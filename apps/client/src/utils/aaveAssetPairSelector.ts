/**
 * selectBestLiquidationPair — Aave V3 asset pair selection logic.
 *
 * For a liquidatable Aave user, enumerates all (collateralAsset, debtAsset) combinations
 * and selects the pair with the highest estimated profit.
 *
 * This is the key Aave-specific step that has no Comet/Morpho equivalent:
 * - Comet: one base asset per Comet, single possible liquidation path
 * - Morpho: one collateral → one debt per market
 * - Aave: user can have multiple collateral AND debt assets in one Pool
 */
import type { Pricer } from "@morpho-blue-liquidation-bot/pricers";
import type { Address, Transport, Chain, Account, Client, PublicClient, WalletClient } from "viem";
import { formatUnits } from "viem";
import { multicall } from "viem/actions";

import {
  aavePoolReserveDataAbi,
  aaveReserveConfigurationAbi,
  HEALTH_FACTOR_THRESHOLD,
} from "../abis/AaveV3.js";

import { getTokenDecimals, primeTokenDecimals } from "./sharedExecution.js";

// ─── Types ───

export interface LiquidationPair {
  collateralAsset: Address;
  debtAsset: Address;
  debtToCover: bigint;
  estimatedProfit: bigint; // in USD (wei-scaled for comparison)
  seizableCollateral: bigint;
  liquidationBonus: bigint; // e.g. 10500 = 5% bonus (4 decimals bps)
  /** True when seizable collateral value < debt to cover value (underwater position) */
  isBadDebt: boolean;
}

/** Cached reserve configuration — avoids repeated RPC calls for stable config data */
export interface ReserveConfig {
  ltv: bigint;
  liquidationThreshold: bigint;
  liquidationBonus: bigint;
  decimals: number;
  isActive: boolean;
  isFrozen: boolean;
}

// ─── Dynamic Close Factor ───

/**
 * Aave V3.1+ uses a dynamic close factor:
 * - When HF >= CLOSE_FACTOR_HF_THRESHOLD (0.95e18): close factor = DEFAULT_CLOSE_FACTOR (50%)
 * - When HF < CLOSE_FACTOR_HF_THRESHOLD: close factor scales up to MAX_CLOSE_FACTOR (100%)
 *
 * Formula: closeFactor = max(DEFAULT_CLOSE_FACTOR,
 *   DEFAULT_CLOSE_FACTOR + (MAX_CLOSE_FACTOR - DEFAULT_CLOSE_FACTOR) * (threshold - HF) / threshold)
 */
const DEFAULT_CLOSE_FACTOR_BPS = 5000n; // 50% in bps
const MAX_CLOSE_FACTOR_BPS = 10000n; // 100% in bps
const CLOSE_FACTOR_HF_THRESHOLD = (95n * HEALTH_FACTOR_THRESHOLD) / 100n; // 0.95e18

/**
 * Calculate the dynamic close factor based on the user's health factor.
 * Returns close factor in bps (0-10000).
 */
export function calculateCloseFactor(healthFactor: bigint): bigint {
  if (healthFactor >= CLOSE_FACTOR_HF_THRESHOLD) {
    return DEFAULT_CLOSE_FACTOR_BPS;
  }
  if (healthFactor === 0n) {
    return MAX_CLOSE_FACTOR_BPS;
  }

  // Linear interpolation: as HF drops below 0.95, close factor increases from 50% to 100%
  const numerator =
    (MAX_CLOSE_FACTOR_BPS - DEFAULT_CLOSE_FACTOR_BPS) * (CLOSE_FACTOR_HF_THRESHOLD - healthFactor);
  const denominator = CLOSE_FACTOR_HF_THRESHOLD;
  const additional = numerator / denominator;

  const closeFactor = DEFAULT_CLOSE_FACTOR_BPS + additional;
  return closeFactor > MAX_CLOSE_FACTOR_BPS ? MAX_CLOSE_FACTOR_BPS : closeFactor;
}

// ─── Core: select best liquidation pair ───

/**
 * For a liquidatable Aave user, find the most profitable (collateral, debt) pair.
 *
 * @param client - Wallet client for on-chain reads
 * @param poolAddress - Aave V3 Pool address
 * @param user - User address to liquidate
 * @param healthFactor - User's current health factor (WAD-scaled)
 * @param reserves - List of reserve addresses (from getReservesList)
 * @param pricers - Pricer instances for USD valuation
 * @param wNative - Wrapped native token address (for gas pricing)
 * @param cachedReserveConfigs - Pre-cached reserve configs (skips RPC calls for liquidationBonus/decimals)
 * @returns Best liquidation pair, or null if no profitable option exists
 */
/** Any viem client that supports public multicall (wallet, public, or read pool). */
export type AaveReadClient =
  | WalletClient<Transport, Chain, Account>
  | PublicClient
  | Client<Transport, Chain>;

export async function selectBestLiquidationPair(
  client: AaveReadClient,
  poolAddress: Address,
  user: Address,
  healthFactor: bigint,
  reserves: Address[],
  pricers?: Pricer[],
  wNative?: Address,
  cachedReserveConfigs?: Map<string, ReserveConfig>,
): Promise<LiquidationPair | null> {
  // Step 1: Enumerate user's collateral and debt assets via multicall
  const collateralAssets: { asset: Address; balance: bigint }[] = [];
  const debtAssets: { asset: Address; balance: bigint }[] = [];

  // Use multicall to batch all getUserReserveData calls into a single RPC request
  const reserveDataResults = await multicall(client, {
    contracts: reserves.map((asset) => ({
      address: poolAddress,
      abi: aavePoolReserveDataAbi,
      functionName: "getUserReserveData" as const,
      args: [asset, user] as const,
    })),
    allowFailure: true,
  });

  for (let i = 0; i < reserveDataResults.length; i++) {
    const entry = reserveDataResults[i];
    if (entry?.status !== "success") continue;
    const asset = reserves[i]!;
    const data = entry.result;
    if (!data) continue;

    const currentATokenBalance = data[0]; // currentATokenBalance
    const currentStableDebt = data[1];
    const currentVariableDebt = data[2];
    const totalDebt = currentStableDebt + currentVariableDebt;

    if (currentATokenBalance > 0n) {
      collateralAssets.push({ asset, balance: currentATokenBalance });
    }
    if (totalDebt > 0n) {
      debtAssets.push({ asset, balance: totalDebt });
    }
  }

  if (collateralAssets.length === 0 || debtAssets.length === 0) {
    return null;
  }

  // Step 2: Calculate close factor
  const closeFactorBps = calculateCloseFactor(healthFactor);

  // Step 3: Get liquidation bonuses — use cache when available, fallback to RPC
  const liquidationBonuses = new Map<string, bigint>();
  const reserveDecimals = new Map<string, number>();

  // Populate from cache first
  if (cachedReserveConfigs) {
    for (const { asset } of collateralAssets) {
      const config = cachedReserveConfigs.get(asset.toLowerCase());
      if (config) {
        liquidationBonuses.set(asset.toLowerCase(), config.liquidationBonus);
        reserveDecimals.set(asset.toLowerCase(), config.decimals);
        primeTokenDecimals(asset, config.decimals);
      }
    }
    for (const { asset } of debtAssets) {
      const config = cachedReserveConfigs.get(asset.toLowerCase());
      if (config) {
        reserveDecimals.set(asset.toLowerCase(), config.decimals);
        primeTokenDecimals(asset, config.decimals);
      }
    }
  }

  // Fetch missing configs via multicall
  const missingBonusAssets = collateralAssets.filter(
    ({ asset }) => !liquidationBonuses.has(asset.toLowerCase()),
  );
  if (missingBonusAssets.length > 0) {
    const bonusResults = await multicall(client, {
      contracts: missingBonusAssets.map(({ asset }) => ({
        address: poolAddress,
        abi: aaveReserveConfigurationAbi,
        functionName: "getReserveConfigurationMap" as const,
        args: [asset] as const,
      })),
      allowFailure: true,
    });
    for (let i = 0; i < bonusResults.length; i++) {
      const entry = bonusResults[i];
      if (entry?.status !== "success" || !entry?.result) continue;
      const asset = missingBonusAssets[i]!.asset;
      const decimals = Number(entry.result[3]);
      liquidationBonuses.set(asset.toLowerCase(), entry.result[2]); // liquidationBonus
      reserveDecimals.set(asset.toLowerCase(), decimals);
      primeTokenDecimals(asset, decimals);
    }
  }

  // Step 4: Price each unique asset once (not once per pair)
  const priceByAsset = new Map<string, number>();
  if (pricers && pricers.length > 0) {
    const uniqueAssets = new Map<string, Address>();
    for (const { asset } of collateralAssets) uniqueAssets.set(asset.toLowerCase(), asset);
    for (const { asset } of debtAssets) uniqueAssets.set(asset.toLowerCase(), asset);

    // Fill any missing decimals (shared process cache) in parallel
    const assetsNeedingDecimals = [...uniqueAssets.values()].filter(
      (asset) => !reserveDecimals.has(asset.toLowerCase()),
    );
    if (assetsNeedingDecimals.length > 0) {
      const decimalsResults = await Promise.all(
        assetsNeedingDecimals.map(async (asset) => {
          const decimals = await getTokenDecimals(client, asset, wNative);
          return [asset.toLowerCase(), decimals] as const;
        }),
      );
      for (const [key, decimals] of decimalsResults) {
        reserveDecimals.set(key, decimals);
      }
    }

    const priceResults = await Promise.all(
      [...uniqueAssets.values()].map(async (asset) => {
        const price = await priceAssetOnce(client, asset, pricers);
        return [asset.toLowerCase(), price] as const;
      }),
    );
    for (const [key, price] of priceResults) {
      if (price !== undefined) priceByAsset.set(key, price);
    }
  }

  // Step 5: Evaluate all pairs in pure math (no further RPCs)
  let bestPair: LiquidationPair | null = null;
  let bestProfit = 0n;

  for (const collateral of collateralAssets) {
    for (const debt of debtAssets) {
      const pair = evaluatePair(
        collateral,
        debt,
        closeFactorBps,
        liquidationBonuses,
        reserveDecimals,
        pricers,
        priceByAsset,
      );

      if (pair && pair.estimatedProfit > bestProfit) {
        bestProfit = pair.estimatedProfit;
        bestPair = pair;
      }
    }
  }

  return bestPair;
}

// ─── Evaluate a single (collateral, debt) pair ───

function evaluatePair(
  collateral: { asset: Address; balance: bigint },
  debt: { asset: Address; balance: bigint },
  closeFactorBps: bigint,
  liquidationBonuses: Map<string, bigint>,
  reserveDecimals: Map<string, number>,
  pricers: Pricer[] | undefined,
  priceByAsset: Map<string, number>,
): LiquidationPair | null {
  // debtToCover = closeFactor * debtBalance (close factor caps it)
  const debtToCover = (debt.balance * closeFactorBps) / 10000n;
  if (debtToCover === 0n) return null;

  // Liquidation bonus for this collateral (default 10000 = no bonus if not found)
  const liquidationBonus = liquidationBonuses.get(collateral.asset.toLowerCase()) ?? 10000n;

  // ── Without pricers: rough estimation only (same-token approximation) ──
  if (!pricers || pricers.length === 0) {
    // Cannot convert across tokens without prices — use raw approximation
    const seizableCollateral = (debtToCover * liquidationBonus) / 10000n;
    return {
      collateralAsset: collateral.asset,
      debtAsset: debt.asset,
      debtToCover,
      estimatedProfit: seizableCollateral > debtToCover ? seizableCollateral - debtToCover : 0n,
      seizableCollateral,
      liquidationBonus,
      isBadDebt: false, // Cannot determine without prices
    };
  }

  const collateralPrice = priceByAsset.get(collateral.asset.toLowerCase());
  const debtPrice = priceByAsset.get(debt.asset.toLowerCase());

  if (collateralPrice === undefined || debtPrice === undefined) return null;
  if (collateralPrice === 0) return null;

  const collateralDecimals = reserveDecimals.get(collateral.asset.toLowerCase()) ?? 18;
  const debtDecimals = reserveDecimals.get(debt.asset.toLowerCase()) ?? 18;

  // ── Correct seizable collateral formula (Aave V3 protocol logic): ──
  // seizableCollateral = debtToCover * (debtPrice / collateralPrice)
  //                      * (10^collateralDecimals / 10^debtDecimals)
  //                      * liquidationBonus / 10000
  //
  // debtToCover is in debt token units (debtDecimals precision).
  // Result is in collateral token units (collateralDecimals precision).
  // The price ratio converts debt USD value → collateral USD value,
  // then the decimal adjustment converts to collateral token raw units.
  const debtToCoverUsd = parseFloat(formatUnits(debtToCover, debtDecimals)) * debtPrice;
  const seizableCollateralUsd = debtToCoverUsd * (Number(liquidationBonus) / 10000);
  const seizableCollateralFloat = seizableCollateralUsd / collateralPrice;

  // Convert back to collateral token raw units
  const seizableCollateral = BigInt(Math.floor(seizableCollateralFloat * 10 ** collateralDecimals));

  if (seizableCollateral === 0n) return null;

  // Cap at available collateral balance
  const actualSeizable =
    seizableCollateral > collateral.balance ? collateral.balance : seizableCollateral;

  // Profit = seizable collateral USD value - debt to cover USD value
  const actualSeizableUsd =
    parseFloat(formatUnits(actualSeizable, collateralDecimals)) * collateralPrice;
  const profitUsd = actualSeizableUsd - debtToCoverUsd;
  if (profitUsd <= 0) return null;

  // Convert profit to a comparable bigint (scaled by 1e18 for precision)
  const estimatedProfit = BigInt(Math.floor(profitUsd * 1e18));

  // Bad debt: seizable collateral capped at available balance means we can't cover the debt
  // This happens when the user's collateral is insufficient even with the liquidation bonus
  const isBadDebt = actualSeizable < seizableCollateral;

  return {
    collateralAsset: collateral.asset,
    debtAsset: debt.asset,
    debtToCover,
    estimatedProfit,
    seizableCollateral: actualSeizable,
    liquidationBonus,
    isBadDebt,
  };
}

// ─── Helpers ───

async function priceAssetOnce(
  client: AaveReadClient,
  asset: Address,
  pricers: Pricer[],
): Promise<number | undefined> {
  for (const pricer of pricers) {
    // Pricers only need public read methods; cast from union client types
    const price = await pricer.price(client as WalletClient<Transport, Chain, Account>, asset);
    if (price !== undefined) return price;
  }
  return undefined;
}
