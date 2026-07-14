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
import { multicall, readContract } from "viem/actions";

import {
  aaveAddressesProviderAbi,
  aaveProtocolDataProviderAbi,
  aaveReserveConfigurationAbi,
  AAVE_V3_ADDRESSES_PROVIDER,
  HEALTH_FACTOR_THRESHOLD,
  resolveAaveProtocolDataProvider,
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
  /**
   * True when seizable collateral USD value cannot cover debtToCover USD even with
   * liquidation bonus (true underwater). Collateral-capped profitable partials are NOT bad debt.
   */
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
 * Aave V3 close factor is binary (LiquidationLogic / ValidationLogic):
 * - When HF >= CLOSE_FACTOR_HF_THRESHOLD (0.95e18): DEFAULT_CLOSE_FACTOR (50%)
 * - When HF <  CLOSE_FACTOR_HF_THRESHOLD: MAX_CLOSE_FACTOR (100%)
 *
 * Not a linear interpolation — matching on-chain behaviour.
 */
const DEFAULT_CLOSE_FACTOR_BPS = 5000n; // 50% in bps
const MAX_CLOSE_FACTOR_BPS = 10000n; // 100% in bps
const CLOSE_FACTOR_HF_THRESHOLD = (95n * HEALTH_FACTOR_THRESHOLD) / 100n; // 0.95e18

/**
 * Calculate the close factor based on the user's health factor.
 * Returns close factor in bps (0-10000).
 */
export function calculateCloseFactor(healthFactor: bigint): bigint {
  if (healthFactor >= CLOSE_FACTOR_HF_THRESHOLD) {
    return DEFAULT_CLOSE_FACTOR_BPS;
  }
  return MAX_CLOSE_FACTOR_BPS;
}

// ─── Core: select best liquidation pair ───

/**
 * For a liquidatable Aave user, find the most profitable (collateral, debt) pair.
 *
 * @param client - Wallet client for on-chain reads
 * @param poolAddress - Aave V3 Pool address (used to resolve ProtocolDataProvider)
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
  logTag?: string,
  /** Override ProtocolDataProvider; defaults to resolveAaveProtocolDataProvider(pool). */
  protocolDataProvider?: Address,
): Promise<LiquidationPair | null> {
  // getUserReserveData / getReserveConfigurationData live on ProtocolDataProvider, not Pool
  const chainId = (client as { chain?: { id?: number } }).chain?.id;
  let dataProvider = protocolDataProvider;
  if (!dataProvider && chainId !== undefined) {
    const addressesProvider = AAVE_V3_ADDRESSES_PROVIDER[chainId];
    if (addressesProvider) {
      try {
        dataProvider = await readContract(client, {
          address: addressesProvider,
          abi: aaveAddressesProviderAbi,
          functionName: "getPoolDataProvider",
        });
      } catch {
        // fall through to static map
      }
    }
  }
  dataProvider ??= resolveAaveProtocolDataProvider(poolAddress, chainId);

  if (!dataProvider) {
    if (logTag) {
      console.warn(
        `${logTag}[Pair] No ProtocolDataProvider for pool ${poolAddress.slice(0, 10)}… — cannot enumerate pairs`,
      );
    }
    return null;
  }

  // Step 1: Enumerate user's collateral and debt assets via multicall
  const collateralAssets: { asset: Address; balance: bigint }[] = [];
  const debtAssets: { asset: Address; balance: bigint }[] = [];

  // Use multicall to batch all getUserReserveData calls into a single RPC request
  const reserveDataResults = await multicall(client, {
    contracts: reserves.map((asset) => ({
      address: dataProvider,
      abi: aaveProtocolDataProviderAbi,
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
    const usageAsCollateralEnabled = data[8]; // only seizeable if enabled as collateral
    const totalDebt = currentStableDebt + currentVariableDebt;

    // Inactive reserves: skip as collateral (cannot seize); still list debt so we can repay
    const cfg = cachedReserveConfigs?.get(asset.toLowerCase());
    const inactive = cfg !== undefined && !cfg.isActive;

    if (currentATokenBalance > 0n && usageAsCollateralEnabled && !inactive) {
      // Frozen collateral remains seizable on Aave; only inactive is skipped
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

  // Fetch missing configs via ProtocolDataProvider multicall
  const missingBonusAssets = collateralAssets.filter(
    ({ asset }) => !liquidationBonuses.has(asset.toLowerCase()),
  );
  if (missingBonusAssets.length > 0) {
    const bonusResults = await multicall(client, {
      contracts: missingBonusAssets.map(({ asset }) => ({
        address: dataProvider,
        abi: aaveReserveConfigurationAbi,
        functionName: "getReserveConfigurationData" as const,
        args: [asset] as const,
      })),
      allowFailure: true,
    });
    for (let i = 0; i < bonusResults.length; i++) {
      const entry = bonusResults[i];
      if (entry?.status !== "success" || !entry?.result) continue;
      const asset = missingBonusAssets[i]!.asset;
      // Official order: decimals, ltv, LT, liquidationBonus, ...
      const decimals = Number(entry.result[0]);
      const liquidationBonus = entry.result[3];
      liquidationBonuses.set(asset.toLowerCase(), liquidationBonus);
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
  let badDebtPair: LiquidationPair | null = null; // fallback when no profitable pair exists
  let pairsTried = 0;
  let pairsNoPrice = 0;
  let pairsNonPositive = 0;
  let pairsOk = 0;
  let maxDebtUsd = 0;

  for (const collateral of collateralAssets) {
    for (const debt of debtAssets) {
      pairsTried++;
      const cPrice = priceByAsset.get(collateral.asset.toLowerCase());
      const dPrice = priceByAsset.get(debt.asset.toLowerCase());
      if (pricers && pricers.length > 0 && (cPrice === undefined || dPrice === undefined)) {
        pairsNoPrice++;
      }
      if (dPrice !== undefined) {
        const dDec = reserveDecimals.get(debt.asset.toLowerCase()) ?? 18;
        const debtUsd =
          parseFloat(formatUnits((debt.balance * closeFactorBps) / 10000n, dDec)) * dPrice;
        if (debtUsd > maxDebtUsd) maxDebtUsd = debtUsd;
      }

      const pair = evaluatePair(
        collateral,
        debt,
        closeFactorBps,
        liquidationBonuses,
        reserveDecimals,
        pricers,
        priceByAsset,
      );

      if (!pair) {
        pairsNonPositive++;
        continue;
      }
      pairsOk++;

      // N7: track first bad-debt pair as fallback (alwaysRealizeBadDebt can use it)
      if (pair.isBadDebt && !badDebtPair) {
        badDebtPair = pair;
      }

      if (pair.estimatedProfit > bestProfit) {
        bestProfit = pair.estimatedProfit;
        bestPair = pair;
      }
    }
  }

  // Diagnose large underwater positions that still yield no pair (helps ops)
  if (!bestPair && !badDebtPair && logTag && maxDebtUsd >= 50) {
    console.log(
      `${logTag}[PairDebug] no pair user=${user.slice(0, 10)}… HF=${Number(healthFactor) / 1e18} ` +
        `collats=${collateralAssets.length} debts=${debtAssets.length} tried=${pairsTried} ` +
        `noPrice=${pairsNoPrice} nonPos=${pairsNonPositive} ok=${pairsOk} maxDebtUsd≈${maxDebtUsd.toFixed(2)}`,
    );
  }

  // N7: prefer profitable pair; fall back to bad-debt pair so alwaysRealizeBadDebt works
  return bestPair ?? badDebtPair;
}

// ─── Evaluate a single (collateral, debt) pair ───

/** Convert float USD price to 8-decimal fixed-point for pure bigint math. */
function toPriceScaled(priceUsd: number): bigint {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  return BigInt(Math.floor(priceUsd * 1e8));
}

/**
 * seizableCollateral (raw) for Aave V3:
 *   debtToCover * debtPrice * liquidationBonus * 10^cDec
 *   / (collateralPrice * 10000 * 10^dDec)
 * Rounded down (conservative for swap sizing).
 */
function computeSeizableCollateral(
  debtToCover: bigint,
  debtPriceScaled: bigint,
  collateralPriceScaled: bigint,
  liquidationBonus: bigint,
  debtDecimals: number,
  collateralDecimals: number,
): bigint {
  if (debtToCover === 0n || debtPriceScaled === 0n || collateralPriceScaled === 0n) return 0n;
  const cScale = 10n ** BigInt(collateralDecimals);
  const dScale = 10n ** BigInt(debtDecimals);
  return (
    (debtToCover * debtPriceScaled * liquidationBonus * cScale) /
    (collateralPriceScaled * 10000n * dScale)
  );
}

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
  let debtToCover = (debt.balance * closeFactorBps) / 10000n;
  if (debtToCover === 0n) return null;

  // Liquidation bonus for this collateral (default 10000 = no bonus if not found)
  const liquidationBonus = liquidationBonuses.get(collateral.asset.toLowerCase()) ?? 10000n;

  // ── Without pricers: rough estimation only (same-token approximation) ──
  if (!pricers || pricers.length === 0) {
    // Cannot convert across tokens without prices — use raw approximation
    let seizableCollateral = (debtToCover * liquidationBonus) / 10000n;
    if (seizableCollateral > collateral.balance && seizableCollateral > 0n) {
      // Scale debt down to available collateral (mirrors protocol behaviour)
      debtToCover = (debtToCover * collateral.balance) / seizableCollateral;
      seizableCollateral = collateral.balance;
    }
    const isBadDebt = seizableCollateral <= debtToCover;
    return {
      collateralAsset: collateral.asset,
      debtAsset: debt.asset,
      debtToCover,
      estimatedProfit: seizableCollateral > debtToCover ? seizableCollateral - debtToCover : 0n,
      seizableCollateral,
      liquidationBonus,
      isBadDebt,
    };
  }

  const collateralPrice = priceByAsset.get(collateral.asset.toLowerCase());
  const debtPrice = priceByAsset.get(debt.asset.toLowerCase());

  if (collateralPrice === undefined || debtPrice === undefined) return null;
  if (collateralPrice === 0) return null;

  const collateralDecimals = reserveDecimals.get(collateral.asset.toLowerCase()) ?? 18;
  const debtDecimals = reserveDecimals.get(debt.asset.toLowerCase()) ?? 18;

  const debtPriceScaled = toPriceScaled(debtPrice);
  const collateralPriceScaled = toPriceScaled(collateralPrice);
  if (debtPriceScaled === 0n || collateralPriceScaled === 0n) return null;

  // ── Pure bigint seizable (Aave V3 protocol logic, round down) ──
  let seizableCollateral = computeSeizableCollateral(
    debtToCover,
    debtPriceScaled,
    collateralPriceScaled,
    liquidationBonus,
    debtDecimals,
    collateralDecimals,
  );

  if (seizableCollateral === 0n) return null;

  // Cap at available collateral: scale debtToCover down so swap/repay stay consistent.
  // Collateral-capped is NOT automatically bad debt — only true underwater after bonus is.
  if (seizableCollateral > collateral.balance) {
    debtToCover = (debtToCover * collateral.balance) / seizableCollateral;
    if (debtToCover === 0n) return null;
    seizableCollateral = computeSeizableCollateral(
      debtToCover,
      debtPriceScaled,
      collateralPriceScaled,
      liquidationBonus,
      debtDecimals,
      collateralDecimals,
    );
    if (seizableCollateral > collateral.balance) {
      seizableCollateral = collateral.balance;
    }
    if (seizableCollateral === 0n) return null;
  }

  // Apply a small haircut (1%) so swap amount never exceeds actual seize under oracle drift
  const seizableForSwap = (seizableCollateral * 99n) / 100n;
  if (seizableForSwap === 0n) return null;

  // Profit in micro-USD (1e8): seizable USD - debt USD
  // seizableUsd = seizable * collPrice / 10^cDec
  // debtUsd     = debtToCover * debtPrice / 10^dDec
  const seizableUsdScaled =
    (seizableForSwap * collateralPriceScaled) / 10n ** BigInt(collateralDecimals);
  const debtUsdScaled = (debtToCover * debtPriceScaled) / 10n ** BigInt(debtDecimals);

  // True bad debt: even with liquidation bonus, seizable value cannot cover debt.
  // N7: still return the pair with isBadDebt=true so alwaysRealizeBadDebt can force it.
  // Ranked after profitable pairs (estimatedProfit = 0).
  const isBadDebt = seizableUsdScaled <= debtUsdScaled;
  if (isBadDebt) {
    return {
      collateralAsset: collateral.asset,
      debtAsset: debt.asset,
      debtToCover,
      estimatedProfit: 0n,
      seizableCollateral: seizableForSwap,
      liquidationBonus,
      isBadDebt: true,
    };
  }

  const profitUsdScaled = seizableUsdScaled - debtUsdScaled;
  // estimatedProfit: scale micro-USD (1e8) to 1e18 for ranking compatibility
  const estimatedProfit = profitUsdScaled * 10n ** 10n;

  return {
    collateralAsset: collateral.asset,
    debtAsset: debt.asset,
    debtToCover,
    estimatedProfit,
    seizableCollateral: seizableForSwap,
    liquidationBonus,
    isBadDebt: false,
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
