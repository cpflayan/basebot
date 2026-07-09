/**
 * Shared execution utilities used by both Morpho LiquidationBot and CometLiquidationBot.
 *
 * Extracted from bot.ts to avoid duplication.
 */
import type { LiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import type { Pricer } from "@morpho-blue-liquidation-bot/pricers";
import { executorAbi } from "executooor-viem";
import {
  erc20Abi,
  formatUnits,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type Transport,
  type WalletClient,
} from "viem";
import {
  getBlockNumber,
  getGasPrice,
  readContract,
  simulateCalls,
  writeContract,
} from "viem/actions";

import { BALANCER_FLASH_LOAN_FEE_BPS } from "../abis/BalancerVault.js";

import { Flashbots } from "./flashbots.js";
import { LiquidationEncoder } from "./LiquidationEncoder.js";

const BPS_DENOMINATOR = 10_000n;

/**
 * Slippage tolerance for DEX swaps within flash loan path.
 */
const FLASH_LOAN_SLIPPAGE_BPS = 100n; // 1%

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
  flashLoanProvider: "balancer" | "aave";
}

// ─── Flash loan fee ───

export function calculateFlashLoanFee(amount: bigint, provider: "balancer" | "aave"): bigint {
  if (provider === "balancer") {
    return (amount * BALANCER_FLASH_LOAN_FEE_BPS) / BPS_DENOMINATOR;
  }
  // Aave V3: 0.05% = 5 / 10000
  return (amount * 5n) / 10000n;
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

  const [loanAssetProfitUsd, gasUsedUsd] = await Promise.all([
    priceAsset(deps, loanAsset, loanAssetProfit),
    priceAsset(deps, deps.wNative, gas.used * gas.price),
  ]);

  if (loanAssetProfitUsd === undefined || gasUsedUsd === undefined) return false;

  const profitUsd = loanAssetProfitUsd - gasUsedUsd;
  return profitUsd > 0;
}

// ─── Price an asset in USD ───

async function priceAsset(
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

export async function convertCollateralToLoan(
  deps: SharedExecutionDeps,
  collateralToken: Address,
  loanToken: Address,
  seizableCollateral: bigint,
  encoder: LiquidationEncoder,
): Promise<boolean> {
  let toConvert = {
    src: collateralToken,
    dst: loanToken,
    srcAmount: seizableCollateral,
  };

  for (const venue of deps.liquidityVenues) {
    const savedCalls = encoder.flush();
    for (const call of savedCalls) {
      encoder.pushCall(encoder.address, 0n, call);
    }

    try {
      const routeSupported = await venue.supportsRoute(encoder, toConvert.src, toConvert.dst);
      if (routeSupported) {
        const snapshot = { ...toConvert };
        toConvert = await venue.convert(encoder, toConvert);
        if (toConvert.src === snapshot.src && toConvert.dst === snapshot.dst) {
          continue;
        }
      } else {
        encoder.flush();
        for (const call of savedCalls) {
          encoder.pushCall(encoder.address, 0n, call);
        }
      }
    } catch (error) {
      console.error(`${deps.logTag}Error converting ${toConvert.src} to ${toConvert.dst}`, error);
      encoder.flush();
      for (const call of savedCalls) {
        encoder.pushCall(encoder.address, 0n, call);
      }
      continue;
    }

    if (toConvert.src === toConvert.dst) return true;
  }

  return false;
}

// ─── Simulation + Execution (flash loan path) ───

export async function simulateAndExecFlashLoan(
  deps: SharedExecutionDeps,
  encoder: LiquidationEncoder,
  calls: Hex[],
  baseAsset: Address,
  badDebtPosition: boolean,
  flashLoanAmount: bigint,
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
    getGasPrice(deps.client),
  ]);

  if (results[1].status !== "success") {
    console.warn(`${deps.logTag}[FlashLoan] Simulation failed: ${results[1].error}`);
    return false;
  }

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
    ))
  )
    return false;

  // Slippage safety margin
  const simulatedProfit = (results[2].result ?? 0n) - (results[0].result ?? 0n);
  const slippageMargin = (flashLoanAmount * FLASH_LOAN_SLIPPAGE_BPS) / BPS_DENOMINATOR;
  const estimatedGasCost = results[1].gasUsed * gasPrice;
  const minProfitThreshold = slippageMargin > estimatedGasCost ? slippageMargin : estimatedGasCost;

  if (simulatedProfit < minProfitThreshold) {
    console.warn(
      `${deps.logTag}[FlashLoan] Simulated profit (${simulatedProfit}) below threshold (${minProfitThreshold}), skipping`,
    );
    return false;
  }

  // Execute
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
  } else {
    await writeContract(deps.client, { address: encoder.address, ...functionData });
  }

  return true;
}

// ─── Simulation + Execution (non-flash-loan path) ───

export async function simulateAndExec(
  deps: SharedExecutionDeps,
  encoder: LiquidationEncoder,
  calls: Hex[],
  loanToken: Address,
  badDebtPosition: boolean,
  flashLoanAmount?: bigint,
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
    getGasPrice(deps.client),
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
    ))
  )
    return false;

  // Execute
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
  } else {
    await writeContract(deps.client, { address: encoder.address, ...functionData });
  }

  return true;
}
