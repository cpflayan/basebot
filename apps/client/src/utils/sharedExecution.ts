/**
 * Shared execution utilities used by both Morpho LiquidationBot and CometLiquidationBot.
 *
 * Extracted from bot.ts to avoid duplication.
 */
import type { FlashLoanProvider } from "@morpho-blue-liquidation-bot/config";
import type { LiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import type { Pricer, PriceMeta, PriceRole } from "@morpho-blue-liquidation-bot/pricers";
import { executorAbi } from "executooor-viem";
import {
  erc20Abi,
  formatUnits,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import {
  getBlockNumber,
  getGasPrice,
  readContract,
  simulateCalls,
  watchBlocks,
  writeContract,
} from "viem/actions";

import { AAVE_V3_POOL_ADDRESSES } from "../abis/AaveV3.js";
import { BALANCER_FLASH_LOAN_FEE_BPS, BALANCER_VAULT_ADDRESS } from "../abis/BalancerVault.js";

import { Flashbots } from "./flashbots.js";
import { LiquidationEncoder } from "./LiquidationEncoder.js";
import { liquidationTracker } from "./liquidationState.js";

const BPS_DENOMINATOR = 10_000n;

/**
 * SECURITY (C2): Dynamic slippage margin for DEX swaps within the flash loan path.
 * Previously a flat 300 bps (3%) regardless of route. Now sized per the actual
 * venue used:
 * - Route went through an aggregator whose own router enforces minReturn on-chain
 *   (1inch/0x) → the flat 3% was overkill; use a small floor instead.
 * - Route went through a "naked" AMM (UniswapV3/Aerodrome/UniswapV4, no
 *   protocol-level minAmountOut) → scale with the route's own estimated price
 *   impact (never below the old 3% floor), since a thin long-tail pool can move
 *   more than 3% between simulation and inclusion while a deep WETH/USDC pool
 *   barely moves at all.
 */
const PROTECTED_ROUTE_FLOOR_BPS = 100n; // 1% — route already has on-chain minReturn protection
const NAKED_ROUTE_FLOOR_BPS = 300n; // 3% — matches the old flat value, used as a lower bound
const IMPACT_SAFETY_MULTIPLIER_PCT = 150n; // scale the raw impact estimate by +50%

function computeDynamicSlippageBps(venueImpactBps: bigint | undefined): bigint {
  if (venueImpactBps === undefined) return PROTECTED_ROUTE_FLOOR_BPS;
  const scaledImpact = (venueImpactBps * IMPACT_SAFETY_MULTIPLIER_PCT) / 100n;
  return scaledImpact > NAKED_ROUTE_FLOOR_BPS ? scaledImpact : NAKED_ROUTE_FLOOR_BPS;
}

// ─── Token Blacklist ───

/**
 * SECURITY: Token blacklist — markets involving these tokens are skipped entirely.
 * Prevents liquidation of positions with depegged/risky tokens.
 * Merges hardcoded defaults + TOKEN_BLACKLIST env var.
 */
const DEFAULT_BLACKLIST = [
  "0x4ed4e862860bed51a9570b96d89af5e1b0efefed", // USR (Resolv USD) on Base — depegged
];

const ENV_BLACKLIST = process.env.TOKEN_BLACKLIST
  ? process.env.TOKEN_BLACKLIST.split(",").map((addr) => addr.trim().toLowerCase())
  : [];

export const TOKEN_BLACKLIST = new Set<string>([...DEFAULT_BLACKLIST, ...ENV_BLACKLIST]);

// ─── Shared block bus (single watchBlocks for all bots) ───

export class SharedBlockBus {
  private listeners: {
    interval: number;
    callback: () => Promise<void>;
    count: number;
    running: boolean;
    logTag: string;
  }[] = [];
  private unwatch: (() => void) | null = null;

  register(interval: number, callback: () => Promise<void>, logTag: string): void {
    this.listeners.push({ interval, callback, count: 0, running: false, logTag });
    console.log(`${logTag}📡 Registered on shared block bus (every ${interval} blocks)`);
  }

  start(client: PublicClient, retryDelayMs = 5_000): () => void {
    const doWatch = () => {
      this.unwatch = watchBlocks(client, {
        onBlock: () => {
          for (const l of this.listeners) {
            l.count++;
            if (l.count % l.interval !== 0) continue;
            if (l.running) continue;
            l.running = true;
            l.callback()
              .catch((e: unknown) => {
                console.error(
                  `${l.logTag}Error in poll tick: ${e instanceof Error ? e.message : e}`,
                );
              })
              .finally(() => {
                l.running = false;
              });
          }
        },
        onError: (error: Error) => {
          console.error(
            `[SharedBlockBus] watchBlocks error, restarting in ${retryDelayMs}ms: ${error.message}`,
          );
          this.unwatch?.();
          setTimeout(doWatch, retryDelayMs);
        },
      });
    };

    doWatch();
    return () => {
      this.unwatch?.();
    };
  }
}

// ─── Types ───

export interface SharedExecutionDeps {
  logTag: string;
  chainId: number;
  client: WalletClient<Transport, Chain, Account>;
  executorAddress: Address;
  treasuryAddress: Address;
  liquidityVenues: LiquidityVenue[];
  pricers?: Pricer[];
  wNative: Address;
  flashbotAccount?: LocalAccount;
  alwaysRealizeBadDebt: boolean;
  flashLoanProvider: FlashLoanProvider;
  flashLoanFallbackProviders: FlashLoanProvider[];
  morphoAddress?: Address;
}

// ─── Flash loan fee ───

/** Aave V3 flash loan premium on Base: 0.09% = 9 bps */
const AAVE_FLASH_LOAN_PREMIUM_BPS = 9n;

export function calculateFlashLoanFee(amount: bigint, provider: FlashLoanProvider): bigint {
  switch (provider) {
    case "balancer":
      return (amount * BALANCER_FLASH_LOAN_FEE_BPS) / BPS_DENOMINATOR;
    case "morpho":
      return 0n;
    case "aave":
      return (amount * AAVE_FLASH_LOAN_PREMIUM_BPS) / BPS_DENOMINATOR;
  }
}

// ─── Profit check ───

export async function checkProfit(
  deps: SharedExecutionDeps,
  loanAsset: Address,
  loanAssetBalance: {
    beforeTx: bigint | undefined;
    afterTx: bigint | undefined;
  },
  gas: {
    used: bigint;
    price: bigint;
  },
  badDebtPosition: boolean,
  flashLoanAmount?: bigint,
  collateralToken?: Address,
): Promise<boolean> {
  if (deps.alwaysRealizeBadDebt && badDebtPosition) return true;

  if (!deps.pricers || deps.pricers.length === 0) {
    console.error(
      `${deps.logTag}⛔ No pricers configured — refusing to execute trade (cannot verify profitability).`,
    );
    return false;
  }

  if (loanAssetBalance.beforeTx === undefined || loanAssetBalance.afterTx === undefined)
    return false;

  let loanAssetProfit = loanAssetBalance.afterTx - loanAssetBalance.beforeTx;

  if (flashLoanAmount !== undefined && flashLoanAmount > 0n) {
    const flashLoanFee = calculateFlashLoanFee(flashLoanAmount, deps.flashLoanProvider);
    loanAssetProfit -= flashLoanFee;
  }

  if (loanAssetProfit <= 0n) return false;

  const [loanAssetPriceUsd, gasPriceUsd] = await Promise.all([
    // Profit is what the bot GAINS → collateral role → Math.min (conservative)
    getVerifiedPrice(deps, loanAsset, "collateral"),
    // Gas is what the bot SPENDS → debt role → Math.max (conservative)
    getVerifiedPrice(deps, deps.wNative, "debt"),
  ]);

  if (loanAssetPriceUsd === undefined || gasPriceUsd === undefined) return false;

  const loanAssetDecimals =
    loanAsset === deps.wNative
      ? 18
      : await readContract(deps.client, {
          address: loanAsset,
          abi: erc20Abi,
          functionName: "decimals",
        });

  const loanAssetProfitUsd =
    parseFloat(formatUnits(loanAssetProfit, loanAssetDecimals)) * loanAssetPriceUsd;
  const gasUsedUsd = parseFloat(formatUnits(gas.used * gas.price, 18)) * gasPriceUsd;

  let profitUsd = loanAssetProfitUsd - gasUsedUsd;

  // Cross-protocol dump detection: if another protocol recently liquidated
  // the same collateral token, DEX price may be temporarily depressed.
  // Apply a conservative buffer to avoid selling into a saturated market.
  if (collateralToken) {
    const recentDumpUsd = liquidationTracker.getRecentDumpUsd(collateralToken, deps.logTag);
    if (recentDumpUsd > 0) {
      const DUMP_PENALTY_BPS = 2000n;
      const penaltyUsd = (recentDumpUsd * Number(DUMP_PENALTY_BPS)) / Number(BPS_DENOMINATOR);
      profitUsd -= penaltyUsd;
      console.log(
        `${deps.logTag}[CrossProtocol] Recent dump detected: $${recentDumpUsd.toFixed(0)} of ${collateralToken.slice(0, 10)}... → penalty $${penaltyUsd.toFixed(2)}, adjusted profit $${profitUsd.toFixed(2)}`,
      );
    }
  }

  return profitUsd > 0;
}

// ─── Multi-source verified price ───

/**
 * Default maximum staleness for price sources in the verified price aggregation.
 * Sources without an `updatedAt` timestamp are always included (cannot be filtered).
 */
const DEFAULT_MAX_STALENESS_SEC = 3_600; // 1 hour

/**
 * Get a conservatively-aggregated USD price from multiple pricer sources.
 *
 * - Fetches prices from ALL pricers in parallel (via `priceWithMeta`).
 * - Filters out stale observations (where `updatedAt` is available and exceeds maxStalenessSec).
 * - Aggregates by role:
 *   - "collateral" → Math.min (underestimate what we receive)
 *   - "debt"       → Math.max (overestimate what we pay)
 *
 * This is SLOWER than the first-success `priceAsset()` fallback and should only
 * be used in the final profitability check, not in candidate screening.
 */
async function getVerifiedPrice(
  deps: SharedExecutionDeps,
  asset: Address,
  role: PriceRole,
  maxStalenessSec: number = DEFAULT_MAX_STALENESS_SEC,
): Promise<number | undefined> {
  if (!deps.pricers || deps.pricers.length === 0) return undefined;

  const results = await Promise.allSettled(
    deps.pricers.map(async (pricer) => {
      if (pricer.priceWithMeta) {
        return pricer.priceWithMeta(deps.client, asset);
      }
      // Fallback: wrap plain `price()` into PriceMeta without timestamp
      const price = await pricer.price(deps.client, asset);
      return price !== undefined ? { price } : undefined;
    }),
  );

  // Collect fresh prices
  const freshPrices: number[] = [];
  const nowSec = Math.floor(Date.now() / 1000);

  for (const result of results) {
    if (result.status !== "fulfilled" || result.value === undefined) continue;
    const meta: PriceMeta = result.value;

    // Staleness filter: only apply when the source provides a timestamp
    if (meta.updatedAt !== undefined) {
      const staleness = nowSec - meta.updatedAt;
      if (staleness > maxStalenessSec) {
        console.warn(
          `${deps.logTag}Price source returned stale data for ${asset}: ${staleness}s old (max=${maxStalenessSec}s), skipping`,
        );
        continue;
      }
    }

    freshPrices.push(meta.price);
  }

  if (freshPrices.length === 0) return undefined;

  // Role-based conservative aggregation
  return role === "collateral" ? Math.min(...freshPrices) : Math.max(...freshPrices);
}

// ─── Price an asset in USD (fast-path, first-success fallback) ───

export async function priceAsset(
  deps: SharedExecutionDeps,
  asset: Address,
  amount: bigint,
): Promise<number | undefined> {
  if (!deps.pricers) return undefined;

  let price: number | undefined = undefined;
  for (const pricer of deps.pricers) {
    price = await pricer.price(deps.client, asset);
    if (price !== undefined) break;
  }
  if (price === undefined) return undefined;

  const decimals =
    asset === deps.wNative
      ? 18
      : await readContract(deps.client, {
          address: asset,
          abi: erc20Abi,
          functionName: "decimals",
        });

  return parseFloat(formatUnits(amount, decimals)) * price;
}

// ─── Collateral → Loan token swap ───

export interface ConvertCollateralToLoanResult {
  success: boolean;
  // SECURITY (C2): max price impact (bps) across any "naked" (no protocol-level
  // minAmountOut) venue used in the route. `undefined` means either no naked venue
  // was used (fully protocol-protected route, e.g. 1inch/0x) or impact couldn't be
  // estimated — callers should treat `undefined` as "apply the protected floor".
  impactBps: bigint | undefined;
}

export async function convertCollateralToLoan(
  deps: SharedExecutionDeps,
  collateralToken: Address,
  loanToken: Address,
  seizableCollateral: bigint,
  encoder: LiquidationEncoder,
): Promise<ConvertCollateralToLoanResult> {
  let toConvert = {
    src: collateralToken,
    dst: loanToken,
    srcAmount: seizableCollateral,
  };
  let maxImpactBps: bigint | undefined;

  console.log(
    `${deps.logTag}[Route Debug] Trying to convert ${collateralToken.slice(0, 10)}... -> ${loanToken.slice(0, 10)}..., amount=${seizableCollateral}, venues=${deps.liquidityVenues.length}`,
  );

  for (const venue of deps.liquidityVenues) {
    const snapshot = encoder.snapshotCalls();
    const venueName = venue.constructor.name;

    try {
      const routeSupported = await venue.supportsRoute(encoder, toConvert.src, toConvert.dst);
      if (routeSupported) {
        const convertSnapshot = { ...toConvert };
        toConvert = await venue.convert(encoder, toConvert);
        if (toConvert.src === convertSnapshot.src && toConvert.dst === convertSnapshot.dst) {
          console.log(
            `${deps.logTag}[Route Debug] ${venueName}: route supported but convert returned same tokens, skipping`,
          );
          encoder.restoreCalls(snapshot);
          continue;
        }
        console.log(`${deps.logTag}[Route Debug] ${venueName}: conversion successful`);

        // SECURITY (C2): accumulate this hop's price impact (if the venue is "naked")
        const hopImpactBps = venue.estimatePriceImpactBps?.();
        if (hopImpactBps !== undefined) {
          maxImpactBps =
            maxImpactBps === undefined || hopImpactBps > maxImpactBps ? hopImpactBps : maxImpactBps;
          console.log(
            `${deps.logTag}[Route Debug] ${venueName}: estimated price impact ${hopImpactBps} bps`,
          );
        }
      } else {
        console.log(`${deps.logTag}[Route Debug] ${venueName}: route not supported`);
        encoder.restoreCalls(snapshot);
      }
    } catch (error) {
      console.error(
        `${deps.logTag}[Route Debug] ${venueName}: error — ${error instanceof Error ? error.message : error}`,
      );
      encoder.restoreCalls(snapshot);
      continue;
    }

    if (toConvert.src === toConvert.dst) {
      console.log(`${deps.logTag}[Route Debug] Conversion complete via ${venueName}`);
      return { success: true, impactBps: maxImpactBps };
    }
  }

  console.log(
    `${deps.logTag}[Route Debug] No venue found for ${collateralToken.slice(0, 10)}... -> ${loanToken.slice(0, 10)}...`,
  );
  return { success: false, impactBps: undefined };
}

// ─── Simulation + Execution (flash loan path) ───

export async function simulateAndExecFlashLoan(
  deps: SharedExecutionDeps,
  encoder: LiquidationEncoder,
  calls: Hex[],
  baseAsset: Address,
  badDebtPosition: boolean,
  flashLoanAmount: bigint,
  cachedGasPrice?: bigint,
  collateralToken?: Address,
  venueImpactBps?: bigint,
): Promise<boolean> {
  const functionData = {
    abi: executorAbi,
    functionName: "exec_606BaXt",
    args: [calls],
  } as const;

  const [{ results }, gasPrice] = await Promise.all([
    simulateCalls(deps.client, {
      account: deps.client.account.address,
      calls: [
        {
          to: baseAsset,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [deps.treasuryAddress],
        },
        { to: encoder.address, ...functionData },
        {
          to: baseAsset,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [deps.treasuryAddress],
        },
      ],
    }),
    cachedGasPrice ?? getGasPrice(deps.client),
  ]);

  if (results[1].status !== "success") {
    console.warn(`${deps.logTag}[FlashLoan] Simulation failed: ${results[1].error}`);
    return false;
  }

  // DEBUG: Log simulation results
  const simulatedProfit = (results[2].result ?? 0n) - (results[0].result ?? 0n);
  console.log(
    `${deps.logTag}[Sim Debug] balanceBefore=${results[0].result}, balanceAfter=${results[2].result}, simulatedProfit=${simulatedProfit}, gasUsed=${results[1].gasUsed}, gasPrice=${gasPrice}`,
  );

  if (
    !(await checkProfit(
      deps,
      baseAsset,
      {
        beforeTx: results[0].result,
        afterTx: results[2].result,
      },
      {
        used: results[1].gasUsed,
        price: gasPrice,
      },
      badDebtPosition,
      flashLoanAmount,
      collateralToken,
    ))
  ) {
    console.log(`${deps.logTag}[Sim Debug] Profit check failed — skipping execution`);
    return false;
  }

  // Slippage safety margin
  const dynamicSlippageBps = computeDynamicSlippageBps(venueImpactBps);
  const slippageMargin = (flashLoanAmount * dynamicSlippageBps) / BPS_DENOMINATOR;
  const estimatedGasCost = results[1].gasUsed * gasPrice;
  const minProfitThreshold = slippageMargin > estimatedGasCost ? slippageMargin : estimatedGasCost;

  console.log(
    `${deps.logTag}[Sim Debug] dynamicSlippageBps=${dynamicSlippageBps} (venueImpactBps=${venueImpactBps ?? "n/a — protected route"})`,
  );

  if (simulatedProfit < minProfitThreshold) {
    console.warn(
      `${deps.logTag}[FlashLoan] Simulated profit (${simulatedProfit}) below threshold (${minProfitThreshold}), skipping`,
    );
    return false;
  }

  // Execute
  console.log(
    `${deps.logTag}[Exec Debug] Passing profit check — executing via ${deps.flashbotAccount ? "Flashbots" : "direct writeContract"}`,
  );
  try {
    if (deps.flashbotAccount) {
      const signedBundle = await Flashbots.signBundle([
        {
          transaction: { to: encoder.address, ...functionData },
          client: deps.client,
        },
      ]);
      await Flashbots.sendRawBundle(
        signedBundle,
        (await getBlockNumber(deps.client)) + 1n,
        deps.flashbotAccount,
      );
      console.log(`${deps.logTag}[Exec Debug] Flashbots bundle sent`);
    } else {
      const txHash = await writeContract(deps.client, {
        address: encoder.address,
        ...functionData,
      });
      console.log(`${deps.logTag}[Exec Debug] Transaction sent: ${txHash}`);
    }
  } catch (e) {
    console.error(
      `${deps.logTag}[Exec Debug] Execution failed: ${e instanceof Error ? e.message : e}`,
    );
    throw e;
  }

  return true;
}

// ─── Flash Loan Wrapper Helper ───

/**
 * Wrap callback calls with the specified flash loan provider.
 * Returns the full encoded calls ready for simulation/execution.
 */
export function wrapWithFlashLoan(
  deps: SharedExecutionDeps,
  provider: FlashLoanProvider,
  asset: Address,
  amount: bigint,
  callbackCalls: Hex[],
): Hex[] {
  const encoder = new LiquidationEncoder(deps.executorAddress, deps.client);

  switch (provider) {
    case "balancer":
      encoder.balancerFlashLoan(BALANCER_VAULT_ADDRESS, [{ asset, amount }], callbackCalls);
      break;

    case "morpho": {
      if (!deps.morphoAddress) {
        throw new Error(`${deps.logTag}Morpho address not configured for flash loan fallback`);
      }
      encoder.morphoBlueFlashLoan(deps.morphoAddress, asset, amount, callbackCalls);
      break;
    }

    case "aave": {
      const aavePoolAddress = AAVE_V3_POOL_ADDRESSES[deps.chainId];
      if (!aavePoolAddress) {
        throw new Error(`${deps.logTag}Aave V3 pool not configured for chain ${deps.chainId}`);
      }
      encoder.aaveFlashLoanWithPremium(
        aavePoolAddress,
        [{ asset, amount }],
        AAVE_FLASH_LOAN_PREMIUM_BPS,
        callbackCalls,
      );
      break;
    }
  }

  return encoder.flush();
}

// ─── Flash Loan Fallback Execution ───

/**
 * Try flash loan liquidation with fallback providers.
 * Attempts primary provider first, then fallbacks in order.
 * Returns true if any provider succeeds.
 */
export async function simulateAndExecFlashLoanWithFallback(
  deps: SharedExecutionDeps,
  callbackCalls: Hex[],
  baseAsset: Address,
  badDebtPosition: boolean,
  flashLoanAmount: bigint,
  collateralToken?: Address,
  cachedGasPrice?: bigint,
  venueImpactBps?: bigint,
): Promise<boolean> {
  const providers = [deps.flashLoanProvider, ...deps.flashLoanFallbackProviders];
  console.log(
    `${deps.logTag}[FlashLoan Debug] Trying ${providers.length} provider(s): ${providers.join(", ")}, flashLoanAmount=${flashLoanAmount}`,
  );

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i]!;
    const isFallback = i > 0;

    if (isFallback) {
      console.log(
        `${deps.logTag}[FlashLoanFallback] Trying fallback provider: ${provider} (${i}/${providers.length - 1})`,
      );
    }

    try {
      const calls = wrapWithFlashLoan(deps, provider, baseAsset, flashLoanAmount, callbackCalls);
      const encoder = new LiquidationEncoder(deps.executorAddress, deps.client);

      const success = await simulateAndExecFlashLoan(
        { ...deps, flashLoanProvider: provider },
        encoder,
        calls,
        baseAsset,
        badDebtPosition,
        flashLoanAmount,
        cachedGasPrice,
        collateralToken,
        venueImpactBps,
      );

      if (success) {
        if (isFallback) {
          console.log(
            `${deps.logTag}[FlashLoanFallback] ✓ Succeeded with fallback provider: ${provider}`,
          );
        }
        return true;
      }
    } catch (error) {
      console.warn(
        `${deps.logTag}[FlashLoanFallback] Provider ${provider} failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  console.warn(`${deps.logTag}[FlashLoanFallback] All providers exhausted, skipping liquidation`);
  return false;
}

// ─── Simulation + Execution (non-flash-loan path) ───

export async function simulateAndExec(
  deps: SharedExecutionDeps,
  encoder: LiquidationEncoder,
  calls: Hex[],
  loanToken: Address,
  badDebtPosition: boolean,
  flashLoanAmount?: bigint,
  cachedGasPrice?: bigint,
  collateralToken?: Address,
): Promise<boolean> {
  const functionData = {
    abi: executorAbi,
    functionName: "exec_606BaXt",
    args: [calls],
  } as const;

  const [{ results }, gasPrice] = await Promise.all([
    simulateCalls(deps.client, {
      account: deps.client.account.address,
      calls: [
        {
          to: loanToken,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [deps.client.account.address],
        },
        { to: encoder.address, ...functionData },
        {
          to: loanToken,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [deps.client.account.address],
        },
      ],
    }),
    cachedGasPrice ?? getGasPrice(deps.client),
  ]);

  if (results[1].status !== "success") {
    console.warn(`${deps.logTag}Transaction failed in simulation: ${results[1].error}`);
    return false;
  }

  if (
    !(await checkProfit(
      deps,
      loanToken,
      {
        beforeTx: results[0].result,
        afterTx: results[2].result,
      },
      {
        used: results[1].gasUsed,
        price: gasPrice,
      },
      badDebtPosition,
      flashLoanAmount,
      collateralToken,
    ))
  )
    return false;

  // Execute
  console.log(
    `${deps.logTag}[Exec Debug] Passing profit check — executing via ${deps.flashbotAccount ? "Flashbots" : "direct writeContract"}`,
  );
  try {
    if (deps.flashbotAccount) {
      const signedBundle = await Flashbots.signBundle([
        {
          transaction: { to: encoder.address, ...functionData },
          client: deps.client,
        },
      ]);
      await Flashbots.sendRawBundle(
        signedBundle,
        (await getBlockNumber(deps.client)) + 1n,
        deps.flashbotAccount,
      );
      console.log(`${deps.logTag}[Exec Debug] Flashbots bundle sent`);
    } else {
      const txHash = await writeContract(deps.client, {
        address: encoder.address,
        ...functionData,
      });
      console.log(`${deps.logTag}[Exec Debug] Transaction sent: ${txHash}`);
    }
  } catch (e) {
    console.error(
      `${deps.logTag}[Exec Debug] Execution failed: ${e instanceof Error ? e.message : e}`,
    );
    throw e;
  }

  return true;
}
