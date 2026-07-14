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
  type Client,
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
  waitForTransactionReceipt,
  watchBlocks,
  writeContract,
} from "viem/actions";

import { AAVE_V3_POOL_ADDRESSES } from "../abis/AaveV3.js";
import { BALANCER_FLASH_LOAN_FEE_BPS, BALANCER_VAULT_ADDRESS } from "../abis/BalancerVault.js";

import { Flashbots } from "./flashbots.js";
import { LiquidationEncoder } from "./LiquidationEncoder.js";
import { liquidationTracker } from "./liquidationState.js";

/** Wait for inclusion before counting liquidationsSucceeded / arming success cooldown. */
const TX_RECEIPT_TIMEOUT_MS = 90_000;

/**
 * Structured sim/exec outcome so bots do not log every false as "not profitable".
 * success=true only after receipt (or Flashbots send).
 */
export type SimExecFailReason =
  | "sim_fail"
  | "profit_fail"
  | "slippage_fail"
  | "exec_revert"
  | "providers_exhausted";

export interface SimExecResult {
  success: boolean;
  reason?: SimExecFailReason;
  detail?: string;
}

export function simExecOk(): SimExecResult {
  return { success: true };
}

export function simExecFail(reason: SimExecFailReason, detail?: string): SimExecResult {
  return { success: false, reason, detail };
}

/**
 * Common custom-error selectors seen in flash-loan sim reverts.
 * Viem cannot decode these against executor ABI alone → noisy "Unable to decode signature".
 * Map selector → human name for logs (keccak256("Name()")[0:4]).
 */
const KNOWN_REVERT_SELECTORS: Record<string, string> = {
  "0x42301c23": "InsufficientOutputAmount()", // Aerodrome / UniV2-style swap minOut
  "0x08c379a0": "Error(string)", // standard Solidity Error
  "0x4e487b71": "Panic(uint256)",
  "0xb629b0e4": "MustNotLeaveDust()", // Morpho Blue flash-loan: executor retains >dust loan-asset balance
  "0x32b219b6": "AggregatorError()", // 1inch / LiFi aggregator swap revert (stale quote or insufficient liquidity)
};

/** Balancer V2 string reasons that show up as Error(string) after decode, or raw in logs. */
const KNOWN_BALANCER_CODES: Record<string, string> = {
  "BAL#528": "INSUFFICIENT_FLASH_LOAN_BALANCE (vault lacks token for flash loan)",
  "BAL#519": "INVALID_FLASH_LOAN_TOKEN_BALANCE",
};

/** Compound V2 / Moonwell failure strings (Error(string) reason). */
const KNOWN_COMPOUND_REASONS: Record<string, string> = {
  LIQUIDATE_SEIZE_TOO_MUCH: "repay too large vs borrower collateral mToken balance (cap repay)",
  LIQUIDATE_LIQUIDATOR_IS_BORROWER: "cannot liquidate self",
  LIQUIDATE_CLOSE_AMOUNT_IS_UINT_MAX: "invalid repay amount",
  LIQUIDATE_CLOSE_AMOUNT_IS_ZERO: "zero repay",
  LIQUIDATE_SEIZE_LIQUIDATOR_IS_BORROWER: "seize liquidator is borrower",
  TOKEN_INSUFFICIENT_ALLOWANCE: "need approve underlying to mToken",
  TOKEN_INSUFFICIENT_BALANCE: "executor missing repay tokens (flash loan path)",
};

/** Short, readable sim failure line (selector decoded when known). */
function formatSimError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split("\n")[0] ?? raw;

  for (const [code, meaning] of Object.entries(KNOWN_BALANCER_CODES)) {
    if (raw.includes(code)) {
      return `${firstLine} → ${code} ${meaning}`;
    }
  }

  for (const [code, meaning] of Object.entries(KNOWN_COMPOUND_REASONS)) {
    if (raw.includes(code)) {
      return `${firstLine} → ${code}: ${meaning}`;
    }
  }

  // Empty revert / empty return — common when an inner call fails without a custom error
  // (e.g. wrong function selector on mToken → no matching ABI → 0x)
  if (/returned no data\s*\("0x"\)/i.test(raw) || /returned no data/i.test(raw)) {
    return (
      `${firstLine} → empty revert/return (inner call failed without error selector; ` +
      `often wrong liquidateBorrow args, redeem/swap fail, or flash-loan callback).`
    );
  }

  const selMatch =
    /signature:\s*(0x[0-9a-fA-F]{8})\b/i.exec(raw) ?? /\b(0x[0-9a-fA-F]{8})\b/.exec(raw);
  const sel = selMatch?.[1]?.toLowerCase();
  if (sel && KNOWN_REVERT_SELECTORS[sel]) {
    const name = KNOWN_REVERT_SELECTORS[sel];
    return `${firstLine} → ${name} [${sel}]`;
  }
  // Truncate multi-line viem dumps (args / docs walls)
  if (raw.length > 400) return `${raw.slice(0, 400)}…`;
  return raw;
}

const BPS_DENOMINATOR = 10_000n;

// Remembers which venue successfully handled a (collateralToken, loanToken) pair last time.
// Route availability for a given pair rarely changes within a process lifetime, so on repeat
// liquidations (same handful of Morpho/Comet/Moonwell markets) we can skip straight to the
// known-good venue instead of re-probing the full priority list from the top every time.
const knownVenueForPair = new Map<string, LiquidityVenue[]>();

function pairCacheKey(src: Address, dst: Address): string {
  return `${src.toLowerCase()}->${dst.toLowerCase()}`;
}

/**
 * Process-lifetime ERC-20 decimals cache.
 * Decimals are immutable on-chain; caching eliminates repeated `decimals()` RPCs
 * across profit checks, pair selection, and budget math on every poll tick.
 */
const decimalsCache = new Map<string, number>();

/** Resolve ERC-20 decimals with process-lifetime cache. Fallback 18 on failure. */
export async function getTokenDecimals(
  client: WalletClient<Transport, Chain, Account> | PublicClient | Client<Transport, Chain>,
  asset: Address,
  wNative?: Address,
): Promise<number> {
  if (asset.toLowerCase() === wNative?.toLowerCase()) return 18;

  const key = asset.toLowerCase();
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;

  try {
    const decimals = await readContract(client, {
      address: asset,
      abi: erc20Abi,
      functionName: "decimals",
    });
    decimalsCache.set(key, decimals);
    return decimals;
  } catch {
    return 18;
  }
}

/** Prefill decimals cache (e.g. from Aave reserve config) to skip RPCs entirely. */
export function primeTokenDecimals(asset: Address, decimals: number): void {
  decimalsCache.set(asset.toLowerCase(), decimals);
}

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
    /** Fire when count % interval === phase (0..interval-1). Stagger bots to cut RPC bursts. */
    phase: number;
    callback: () => Promise<void>;
    count: number;
    running: boolean;
    logTag: string;
  }[] = [];
  private unwatch: (() => void) | null = null;

  /**
   * @param phase Offset in [0, interval). Same interval + different phase ⇒ bots don't all
   *              hit multicall on the same block (helps avoid 429 spikes).
   */
  register(interval: number, callback: () => Promise<void>, logTag: string, phase = 0): void {
    const iv = Math.max(1, interval);
    const ph = ((phase % iv) + iv) % iv;
    this.listeners.push({
      interval: iv,
      phase: ph,
      callback,
      count: 0,
      running: false,
      logTag,
    });
    console.log(`${logTag}📡 Registered on shared block bus (every ${iv} blocks, phase=${ph})`);
  }

  start(client: PublicClient, retryDelayMs = 5_000): () => void {
    const doWatch = () => {
      this.unwatch = watchBlocks(client, {
        onBlock: () => {
          for (const l of this.listeners) {
            l.count++;
            // phase stagger: e.g. interval=5 phase=0 → blocks 5,10,15; phase=2 → 2,7,12
            if (l.count % l.interval !== l.phase) continue;
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

  const loanAssetDecimals = await getTokenDecimals(deps.client, loanAsset, deps.wNative);

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

  const decimals = await getTokenDecimals(deps.client, asset, deps.wNative);

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
  /** How the route was resolved (for race metrics). */
  via?: "same" | "cache" | "probe" | "fail";
  /** Wall time for this convert attempt (ms). */
  elapsedMs?: number;
}

export interface ConvertCollateralToLoanOptions {
  /** Override venue list (default: deps.liquidityVenues). */
  venues?: LiquidityVenue[];
  /**
   * Prefer on-chain AMMs (Aerodrome/Uni/wrappers). Only try aggregators (1inch/0x/LiFi)
   * if local venues fail. Recommended for race-sensitive Aave path.
   */
  preferLocalDex?: boolean;
}

/** Aggregator / HTTP venues — slower; keep as fallback for race path. */
function isAggregatorVenue(venue: LiquidityVenue): boolean {
  return /oneinch|1inch|zeroex|0x|lifi|paraswap/i.test(venue.constructor.name);
}

async function tryVenueConvert(
  deps: SharedExecutionDeps,
  venue: LiquidityVenue,
  toConvert: { src: Address; dst: Address; srcAmount: bigint },
  encoder: LiquidationEncoder,
): Promise<
  | { ok: true; result: { src: Address; dst: Address; srcAmount: bigint }; impactBps?: bigint }
  | { ok: false }
> {
  const snapshot = encoder.snapshotCalls();
  const venueName = venue.constructor.name;
  try {
    const result = await venue.convert(encoder, toConvert);
    if (result.src === toConvert.src && result.dst === toConvert.dst) {
      console.log(
        `${deps.logTag}[Route Debug] ${venueName}: route supported but convert returned same tokens, skipping`,
      );
      encoder.restoreCalls(snapshot);
      return { ok: false };
    }
    console.log(`${deps.logTag}[Route Debug] ${venueName}: conversion successful`);
    const impactBps = venue.estimatePriceImpactBps?.();
    if (impactBps !== undefined) {
      console.log(
        `${deps.logTag}[Route Debug] ${venueName}: estimated price impact ${impactBps} bps`,
      );
    }
    return { ok: true, result, impactBps };
  } catch (error) {
    console.error(
      `${deps.logTag}[Route Debug] ${venueName}: error — ${error instanceof Error ? error.message : error}`,
    );
    encoder.restoreCalls(snapshot);
    return { ok: false };
  }
}

/**
 * Core convert against an explicit venue list (preserves list order).
 */
async function convertWithVenues(
  deps: SharedExecutionDeps,
  collateralToken: Address,
  loanToken: Address,
  seizableCollateral: bigint,
  encoder: LiquidationEncoder,
  venues: LiquidityVenue[],
): Promise<ConvertCollateralToLoanResult> {
  const t0 = Date.now();
  const done = (
    success: boolean,
    via: ConvertCollateralToLoanResult["via"],
    impactBps?: bigint,
  ): ConvertCollateralToLoanResult => {
    const elapsedMs = Date.now() - t0;
    if (success) {
      console.log(
        `${deps.logTag}[Route Timing] via=${via} ${elapsedMs}ms ` +
          `${collateralToken.slice(0, 10)}…→${loanToken.slice(0, 10)}…`,
      );
    } else {
      console.log(
        `${deps.logTag}[Route Timing] via=fail ${elapsedMs}ms ` +
          `${collateralToken.slice(0, 10)}…→${loanToken.slice(0, 10)}…`,
      );
    }
    return { success, impactBps, via: success ? via : "fail", elapsedMs };
  };

  if (collateralToken.toLowerCase() === loanToken.toLowerCase()) {
    return done(true, "same");
  }
  if (venues.length === 0 || seizableCollateral === 0n) {
    return done(false, "fail");
  }

  // Snapshot so multi-hop / cached-route partials never pollute the caller encoder
  // (preferLocalDex fallback and post-fail skip paths rely on a clean stack).
  const encoderSnapshot = encoder.snapshotCalls();

  let toConvert = {
    src: collateralToken,
    dst: loanToken,
    srcAmount: seizableCollateral,
  };
  let maxImpactBps: bigint | undefined;

  console.log(
    `${deps.logTag}[Route Debug] Trying to convert ${collateralToken.slice(0, 10)}... -> ${loanToken.slice(0, 10)}..., amount=${seizableCollateral}, venues=${venues.length}`,
  );

  const cacheKey = pairCacheKey(collateralToken, loanToken);

  // Fast path: replay the venue sequence that worked last time for this exact pair.
  const cachedRoute = knownVenueForPair.get(cacheKey);
  if (cachedRoute !== undefined) {
    let cachedRouteOk = true;
    for (const venue of cachedRoute) {
      const outcome = await tryVenueConvert(deps, venue, toConvert, encoder);
      if (!outcome.ok) {
        cachedRouteOk = false;
        break;
      }
      toConvert = outcome.result;
      if (outcome.impactBps !== undefined) {
        maxImpactBps =
          maxImpactBps === undefined || outcome.impactBps > maxImpactBps
            ? outcome.impactBps
            : maxImpactBps;
      }
    }

    if (cachedRouteOk && toConvert.src === toConvert.dst) {
      console.log(`${deps.logTag}[Route Debug] Conversion complete via cached route`);
      return done(true, "cache", maxImpactBps);
    }

    // Cache miss/partial: wipe partial hops before full probe
    knownVenueForPair.delete(cacheKey);
    encoder.restoreCalls(encoderSnapshot);
    toConvert = { src: collateralToken, dst: loanToken, srcAmount: seizableCollateral };
    maxImpactBps = undefined;
  }

  const usedVenues: LiquidityVenue[] = [];

  for (;;) {
    const currentHop = toConvert;
    const supportChecks = await Promise.all(
      venues.map(async (venue) => {
        try {
          const supported = await venue.supportsRoute(encoder, currentHop.src, currentHop.dst);
          return { venue, supported };
        } catch (error) {
          console.error(
            `${deps.logTag}[Route Debug] ${venue.constructor.name}: supportsRoute error — ${error instanceof Error ? error.message : error}`,
          );
          return { venue, supported: false };
        }
      }),
    );

    let hopConverted = false;
    for (const venue of venues) {
      const check = supportChecks.find((c) => c.venue === venue);
      if (!check?.supported) {
        console.log(`${deps.logTag}[Route Debug] ${venue.constructor.name}: route not supported`);
        continue;
      }

      const outcome = await tryVenueConvert(deps, venue, toConvert, encoder);
      if (!outcome.ok) continue;

      toConvert = outcome.result;
      usedVenues.push(venue);
      if (outcome.impactBps !== undefined) {
        maxImpactBps =
          maxImpactBps === undefined || outcome.impactBps > maxImpactBps
            ? outcome.impactBps
            : maxImpactBps;
      }
      hopConverted = true;
      break;
    }

    if (toConvert.src === toConvert.dst) {
      knownVenueForPair.set(cacheKey, usedVenues);
      console.log(`${deps.logTag}[Route Debug] Conversion complete`);
      return done(true, "probe", maxImpactBps);
    }

    if (!hopConverted) {
      break;
    }
  }

  // Full failure: drop any partial multi-hop calls so callers / fallbacks start clean
  encoder.restoreCalls(encoderSnapshot);
  console.log(
    `${deps.logTag}[Route Debug] No venue found for ${collateralToken.slice(0, 10)}... -> ${loanToken.slice(0, 10)}...`,
  );
  return done(false, "fail");
}

export async function convertCollateralToLoan(
  deps: SharedExecutionDeps,
  collateralToken: Address,
  loanToken: Address,
  seizableCollateral: bigint,
  encoder: LiquidationEncoder,
  options?: ConvertCollateralToLoanOptions,
): Promise<ConvertCollateralToLoanResult> {
  const allVenues = options?.venues ?? deps.liquidityVenues;

  if (options?.preferLocalDex) {
    const local = allVenues.filter((v) => !isAggregatorVenue(v));
    const aggs = allVenues.filter((v) => isAggregatorVenue(v));

    if (local.length > 0) {
      const localResult = await convertWithVenues(
        deps,
        collateralToken,
        loanToken,
        seizableCollateral,
        encoder,
        local,
      );
      // convertWithVenues restores encoder on failure — safe to try aggregators next
      if (localResult.success) return localResult;
    }

    if (aggs.length > 0) {
      console.log(
        `${deps.logTag}[Route Debug] Local DEX failed — falling back to aggregator(s): ${aggs.map((v) => v.constructor.name).join(", ")}`,
      );
      // Full list (local + agg) preserves multi-hop via wrapper then aggregator
      return convertWithVenues(
        deps,
        collateralToken,
        loanToken,
        seizableCollateral,
        encoder,
        allVenues,
      );
    }

    return { success: false, impactBps: undefined, via: "fail" };
  }

  return convertWithVenues(
    deps,
    collateralToken,
    loanToken,
    seizableCollateral,
    encoder,
    allVenues,
  );
}

/**
 * Prefill knownVenueForPair for common token pairs (process lifetime).
 * Uses a tiny sample amount so we only discover routes / fill cache — not real sizes.
 * Failures are logged and ignored (pair simply stays cold until first live convert).
 */
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export async function warmVenueRouteCache(
  deps: SharedExecutionDeps,
  pairs: { src: Address; dst: Address }[],
  sampleAmount: bigint = 10n ** 12n, // 0.000001 of 18-decimal token; enough for pool probes
): Promise<{ warmed: number; failed: number }> {
  let warmed = 0;
  let failed = 0;
  const seen = new Set<string>();

  for (const { src, dst } of pairs) {
    // Morpho can list native-ETH markets as collateral 0x0 — not an ERC-20; skip warm probe.
    if (
      src.toLowerCase() === ZERO_ADDR ||
      dst.toLowerCase() === ZERO_ADDR ||
      src.toLowerCase() === dst.toLowerCase()
    ) {
      continue;
    }
    const key = pairCacheKey(src, dst);
    if (seen.has(key) || knownVenueForPair.has(key)) {
      if (knownVenueForPair.has(key)) warmed++;
      continue;
    }
    seen.add(key);

    const encoder = new LiquidationEncoder(deps.executorAddress, deps.client);
    try {
      const result = await convertCollateralToLoan(deps, src, dst, sampleAmount, encoder, {
        preferLocalDex: true,
      });
      if (result.success) {
        warmed++;
        console.log(`${deps.logTag}[Route Warm] ✓ ${src.slice(0, 10)}…→${dst.slice(0, 10)}…`);
      } else {
        failed++;
      }
    } catch (e) {
      failed++;
      console.warn(
        `${deps.logTag}[Route Warm] ✗ ${src.slice(0, 10)}…→${dst.slice(0, 10)}…: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  console.log(
    `${deps.logTag}[Route Warm] done: warmed=${warmed} failed=${failed} cachedPairs=${knownVenueForPair.size}`,
  );
  return { warmed, failed };
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
): Promise<SimExecResult> {
  const functionData = {
    abi: executorAbi,
    functionName: "exec_606BaXt",
    args: [calls],
  } as const;

  // Measure profit on the EXECUTOR, not treasury.
  // Flash callbacks must NOT erc20Skim before repay: Balancer/Morpho/Aave append the
  // repay transfer AFTER user callbacks; skimming full balance makes repay fail with
  // "transfer amount exceeds balance". Leftover baseAsset on the executor after repay
  // is true net profit (flash fee already paid inside the tx).
  const profitHolder = deps.executorAddress;

  const [{ results }, gasPrice] = await Promise.all([
    simulateCalls(deps.client, {
      account: deps.client.account.address,
      calls: [
        {
          to: baseAsset,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [profitHolder],
        },
        { to: encoder.address, ...functionData },
        {
          to: baseAsset,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [profitHolder],
        },
      ],
    }),
    cachedGasPrice ?? getGasPrice(deps.client),
  ]);

  if (results[1].status !== "success") {
    const simErr = results[1].error;
    console.warn(`${deps.logTag}[FlashLoan] Simulation failed: ${formatSimError(simErr)}`);
    const raceReason = isNonRecoverableRevert(simErr);
    if (raceReason !== undefined) {
      throw new LiquidationRaceLostError(raceReason);
    }
    return simExecFail("sim_fail", formatSimError(simErr));
  }

  // DEBUG: Log simulation results
  const simulatedProfit = (results[2].result ?? 0n) - (results[0].result ?? 0n);
  console.log(
    `${deps.logTag}[Sim Debug] executorBalBefore=${results[0].result}, executorBalAfter=${results[2].result}, simulatedProfit=${simulatedProfit}, gasUsed=${results[1].gasUsed}, gasPrice=${gasPrice}`,
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
      // Flash fee already settled in the simulated exec; do not subtract again.
      undefined,
      collateralToken,
    ))
  ) {
    console.log(`${deps.logTag}[Sim Debug] Profit check failed — skipping execution`);
    return simExecFail("profit_fail");
  }

  // Slippage safety margin in loan-token raw units only.
  // Gas is already accounted for in checkProfit (USD). Do NOT mix gas wei
  // into this comparison — estimatedGasCost is native wei (18 dec) while
  // simulatedProfit / slippageMargin are loan-token units (e.g. USDC 6 dec).
  const dynamicSlippageBps = computeDynamicSlippageBps(venueImpactBps);
  const slippageMargin = (flashLoanAmount * dynamicSlippageBps) / BPS_DENOMINATOR;

  console.log(
    `${deps.logTag}[Sim Debug] dynamicSlippageBps=${dynamicSlippageBps} (venueImpactBps=${venueImpactBps ?? "n/a — protected route"}) slippageMargin=${slippageMargin} gasUsed=${results[1].gasUsed} gasPrice=${gasPrice}`,
  );

  if (simulatedProfit < slippageMargin) {
    console.warn(
      `${deps.logTag}[FlashLoan] Simulated profit (${simulatedProfit}) below slippage margin (${slippageMargin}), skipping`,
    );
    return simExecFail("slippage_fail", `profit=${simulatedProfit} margin=${slippageMargin}`);
  }

  // Execute — only return success after on-chain receipt (or Flashbots send, best-effort)
  console.log(
    `${deps.logTag}[Exec Debug] Passing profit check — executing via ${deps.flashbotAccount ? "Flashbots" : "direct writeContract"}`,
  );
  return await submitAndConfirm(deps, encoder.address, functionData);
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
  const wrapperEncoder = new LiquidationEncoder(deps.executorAddress, deps.client);

  // IMPORTANT: Do NOT inject erc20Skim into any flash-loan callback.
  // erc20Skim transfers the executor's FULL balance (placeholder-resolved) to treasury.
  // Inside a flash-loan callback the executor holds flashLoanAmount + profit;
  // skimming sends ALL of it away, so the provider's repay (transfer / transferFrom)
  // reverts with "ERC20: transfer amount exceeds balance".
  // Pre-existing executor dust should be cleaned operationally via src/skim.ts
  // BEFORE the bot starts, not inside the flash-loan callback.
  switch (provider) {
    case "balancer":
      wrapperEncoder.balancerFlashLoan(BALANCER_VAULT_ADDRESS, [{ asset, amount }], callbackCalls);
      break;

    case "morpho": {
      if (!deps.morphoAddress) {
        throw new Error(`${deps.logTag}Morpho address not configured for flash loan fallback`);
      }
      wrapperEncoder.morphoBlueFlashLoan(deps.morphoAddress, asset, amount, callbackCalls);
      break;
    }

    case "aave": {
      const aavePoolAddress = AAVE_V3_POOL_ADDRESSES[deps.chainId];
      if (!aavePoolAddress) {
        throw new Error(`${deps.logTag}Aave V3 pool not configured for chain ${deps.chainId}`);
      }
      wrapperEncoder.aaveFlashLoanWithPremium(
        aavePoolAddress,
        [{ asset, amount }],
        AAVE_FLASH_LOAN_PREMIUM_BPS,
        callbackCalls,
      );
      break;
    }
  }

  return wrapperEncoder.flush();
}

// ─── Flash Loan Fallback Execution ───

/**
 * Try flash loan liquidation with fallback providers.
 * Attempts primary provider first, then fallbacks in order.
 * Returns true if any provider succeeds.
 */
// Revert reasons that mean the liquidation target itself is no longer valid — retrying with
// a different flash loan provider cannot fix these, since the problem isn't the provider,
// it's that the position moved (someone else liquidated it, price recovered, debt was repaid,
// etc.) between detection and simulation. Matching one of these should abort the whole
// fallback chain immediately instead of burning simulation calls on the remaining providers.
// Extend this list as new protocol-specific "not liquidatable" reasons are observed in logs.
const NON_RECOVERABLE_REVERT_PATTERNS = [
  /position is healthy/i, // Morpho Blue
  /health factor.*not below/i, // Aave V3 (HEALTH_FACTOR_NOT_BELOW_THRESHOLD, code "51")
  /HEALTH_FACTOR_NOT_BELOW_THRESHOLD/i,
  /\b51\b/, // Aave V3 numeric error code for the above
  /not.?liquidatable/i, // Compound V3 (Comet) NotLiquidatable()
  /insufficient shortfall/i, // Compound V2-style (Moonwell) comptroller rejection
  /collateral cannot be liquidated/i, // Aave V3
  /already.?liquidat/i,
] as const;

function isNonRecoverableRevert(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const matched = NON_RECOVERABLE_REVERT_PATTERNS.find((pattern) => pattern.test(message));
  return matched ? message : undefined;
}

/** Thrown when the position is no longer liquidatable (competitor / HF recovered). */
export class LiquidationRaceLostError extends Error {
  readonly raceLost = true as const;
  constructor(message: string) {
    super(message);
    this.name = "LiquidationRaceLostError";
  }
}

export function isLiquidationRaceLostError(error: unknown): error is LiquidationRaceLostError {
  return (
    error instanceof LiquidationRaceLostError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { raceLost?: boolean }).raceLost === true)
  );
}

export async function simulateAndExecFlashLoanWithFallback(
  deps: SharedExecutionDeps,
  callbackCalls: Hex[],
  baseAsset: Address,
  badDebtPosition: boolean,
  flashLoanAmount: bigint,
  collateralToken?: Address,
  cachedGasPrice?: bigint,
  venueImpactBps?: bigint,
): Promise<SimExecResult> {
  const providers = [deps.flashLoanProvider, ...deps.flashLoanFallbackProviders];
  console.log(
    `${deps.logTag}[FlashLoan Debug] Trying ${providers.length} provider(s): ${providers.join(", ")}, flashLoanAmount=${flashLoanAmount}`,
  );

  let lastFail: SimExecResult | undefined;

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

      const result = await simulateAndExecFlashLoan(
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

      if (result.success) {
        if (isFallback) {
          console.log(
            `${deps.logTag}[FlashLoanFallback] ✓ Succeeded with fallback provider: ${provider}`,
          );
        }
        return result;
      }
      lastFail = result;
    } catch (error) {
      const nonRecoverableReason = isNonRecoverableRevert(error);
      if (nonRecoverableReason !== undefined) {
        console.warn(
          `${deps.logTag}[FlashLoanFallback] Target no longer liquidatable (${nonRecoverableReason.slice(0, 120)}) — aborting fallback chain, ${providers.length - 1 - i} remaining provider(s) skipped`,
        );
        // Surface as race-lost so callers can apply a short cooldown (not 1h hard lock).
        throw new LiquidationRaceLostError(nonRecoverableReason);
      }

      console.warn(
        `${deps.logTag}[FlashLoanFallback] Provider ${provider} failed: ${error instanceof Error ? error.message : error}`,
      );
      lastFail = simExecFail("sim_fail", error instanceof Error ? error.message : String(error));
    }
  }

  console.warn(`${deps.logTag}[FlashLoanFallback] All providers exhausted, skipping liquidation`);
  return lastFail?.reason
    ? simExecFail(
        "providers_exhausted",
        `${lastFail.reason}${lastFail.detail ? `: ${lastFail.detail}` : ""}`,
      )
    : simExecFail("providers_exhausted");
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
): Promise<SimExecResult> {
  const functionData = {
    abi: executorAbi,
    functionName: "exec_606BaXt",
    args: [calls],
  } as const;

  // Direct path bots erc20Skim profit to treasury before flush — measure treasury,
  // not the EOA (which would show ~0 delta and false-negative profitable liquidations).
  const profitHolder = deps.treasuryAddress;

  const [{ results }, gasPrice] = await Promise.all([
    simulateCalls(deps.client, {
      account: deps.client.account.address,
      calls: [
        {
          to: loanToken,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [profitHolder],
        },
        { to: encoder.address, ...functionData },
        {
          to: loanToken,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [profitHolder],
        },
      ],
    }),
    cachedGasPrice ?? getGasPrice(deps.client),
  ]);

  if (results[1].status !== "success") {
    const simErr = results[1].error;
    console.warn(`${deps.logTag}Transaction failed in simulation: ${formatSimError(simErr)}`);
    const raceReason = isNonRecoverableRevert(simErr);
    if (raceReason !== undefined) {
      throw new LiquidationRaceLostError(raceReason);
    }
    return simExecFail("sim_fail", formatSimError(simErr));
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
    return simExecFail("profit_fail");

  // Execute — only return success after on-chain receipt (or Flashbots send, best-effort)
  console.log(
    `${deps.logTag}[Exec Debug] Passing profit check — executing via ${deps.flashbotAccount ? "Flashbots" : "direct writeContract"}`,
  );
  return await submitAndConfirm(deps, encoder.address, functionData);
}

/**
 * Submit liquidation tx and confirm success before callers arm "success" cooldown
 * or increment liquidationsSucceeded. Hash-only success previously locked positions 1h
 * even when the tx never landed or reverted.
 */

async function submitAndConfirm(
  deps: SharedExecutionDeps,
  executorAddress: Address,
  functionData: any,
): Promise<SimExecResult> {
  try {
    if (deps.flashbotAccount) {
      // Bundle inclusion is not a single receipt path; keep fire-and-forget semantics.
      const signedBundle = await Flashbots.signBundle([
        {
          transaction: { to: executorAddress, ...functionData },
          client: deps.client,
        },
      ]);
      await Flashbots.sendRawBundle(
        signedBundle,
        (await getBlockNumber(deps.client)) + 1n,
        deps.flashbotAccount,
      );
      console.log(
        `${deps.logTag}[Exec Debug] Flashbots bundle sent (receipt not awaited — treat as tentative success)`,
      );
      return simExecOk();
    }

    const txHash = await writeContract(deps.client, {
      address: executorAddress,
      ...functionData,
    });
    console.log(`${deps.logTag}[Exec Debug] Transaction sent: ${txHash} — waiting for receipt…`);

    const receipt = await waitForTransactionReceipt(deps.client, {
      hash: txHash,
      timeout: TX_RECEIPT_TIMEOUT_MS,
    });

    if (receipt.status !== "success") {
      console.error(
        `${deps.logTag}[Exec Debug] Transaction mined but REVERTED: ${txHash} status=${receipt.status}`,
      );
      return simExecFail("exec_revert", `tx=${txHash}`);
    }

    console.log(
      `${deps.logTag}[Exec Debug] Transaction confirmed: ${txHash} block=${receipt.blockNumber}`,
    );
    return simExecOk();
  } catch (e) {
    console.error(
      `${deps.logTag}[Exec Debug] Execution failed: ${e instanceof Error ? e.message : e}`,
    );
    throw e;
  }
}
