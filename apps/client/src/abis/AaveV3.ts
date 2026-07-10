/**
 * Aave V3 Pool ABI definitions — liquidation, flash loan, account data queries.
 *
 * Aave V3 uses a single shared Pool contract per chain (unlike Compound V3's per-market Comet model).
 * Users can have multiple collateral and debt assets in the same Pool.
 *
 * Key precision notes:
 * - healthFactor is WAD-scaled (18 decimals): 1e18 = 1.0
 * - totalCollateralBase / totalDebtBase / availableBorrowsBase use 8-decimal "base currency" units
 * - Individual reserve balances use the token's native decimals
 */
import type { Address } from "viem";

// ─── Aave V3 Pool addresses (per chain) ───

export const AAVE_V3_POOL_ADDRESSES: Record<number, Address> = {
  // Base
  8453: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  // Ethereum mainnet
  1: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
} as const;

// ─── Constants ───

/** Health factor threshold — WAD-scaled 1.0 (18 decimals) */
export const HEALTH_FACTOR_THRESHOLD = 10n ** 18n;

/** Aave base currency unit — 8 decimals (used for aggregate values like totalCollateralBase) */
export const BASE_CURRENCY_UNIT = 10n ** 8n;

/** WAD unit — 18 decimals (used for healthFactor) */
export const WAD = 10n ** 18n;

// ─── Aave V3 Pool View ABI ───

export const aavePoolViewAbi = [
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserAccountData",
    outputs: [
      { name: "totalCollateralBase", type: "uint256" }, // 8 decimals (base currency)
      { name: "totalDebtBase", type: "uint256" }, // 8 decimals (base currency)
      { name: "availableBorrowsBase", type: "uint256" }, // 8 decimals (base currency)
      { name: "currentLiquidationThreshold", type: "uint256" }, // 4 decimals (bps)
      { name: "ltv", type: "uint256" }, // 4 decimals (bps)
      { name: "healthFactor", type: "uint256" }, // 18 decimals (WAD)
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getReservesList",
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getReserveData",
    outputs: [
      { name: "configuration", type: "uint256" },
      { name: "liquidityIndex", type: "uint128" },
      { name: "currentLiquidityRate", type: "uint128" },
      { name: "variableBorrowIndex", type: "uint128" },
      { name: "currentVariableBorrowRate", type: "uint128" },
      { name: "currentStableBorrowRate", type: "uint128" },
      { name: "lastUpdateTimestamp", type: "uint40" },
      { name: "id", type: "uint16" },
      { name: "aTokenAddress", type: "address" },
      { name: "stableDebtTokenAddress", type: "address" },
      { name: "variableDebtTokenAddress", type: "address" },
      { name: "interestRateStrategyAddress", type: "address" },
      { name: "accruedToTreasury", type: "uint128" },
      { name: "unbacked", type: "uint128" },
      { name: "isolationModeTotalDebt", type: "uint128" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ─── Aave V3 Pool Reserve Data ABI (per-reserve user data) ───

export const aavePoolReserveDataAbi = [
  {
    inputs: [
      { name: "asset", type: "address" },
      { name: "user", type: "address" },
    ],
    name: "getUserReserveData",
    outputs: [
      { name: "currentATokenBalance", type: "uint256" },
      { name: "currentStableDebt", type: "uint256" },
      { name: "currentVariableDebt", type: "uint256" },
      { name: "principalStableDebt", type: "uint256" },
      { name: "scaledVariableDebt", type: "uint256" },
      { name: "stableBorrowRate", type: "uint256" },
      { name: "liquidityRate", type: "uint256" },
      { name: "stableRateLastUpdated", type: "uint40" },
      { name: "usageAsCollateralEnabled", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ─── Aave V3 Pool Write ABI (liquidation + flash loan) ───

export const aavePoolWriteAbi = [
  {
    inputs: [
      { name: "collateralAsset", type: "address" },
      { name: "debtAsset", type: "address" },
      { name: "user", type: "address" },
      { name: "debtToCover", type: "uint256" },
      { name: "receiveAToken", type: "bool" },
    ],
    name: "liquidationCall",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "receiverAddress", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "params", type: "bytes" },
      { name: "referralCode", type: "uint16" },
    ],
    name: "flashLoanSimple",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ─── Aave V3 Flash Loan Simple Receiver callback ABI ───
// The executor contract must implement this interface to receive Aave flash loans.

export const aaveFlashLoanReceiverAbi = [
  {
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "premium", type: "uint256" },
      { name: "initiator", type: "address" },
      { name: "params", type: "bytes" },
    ],
    name: "executeOperation",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ─── Aave V3 Reserve Configuration ABI (for liquidation bonus) ───

export const aaveReserveConfigurationAbi = [
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getReserveConfigurationMap",
    outputs: [
      { name: "ltv", type: "uint256" }, // 4 decimals (bps)
      { name: "liquidationThreshold", type: "uint256" }, // 4 decimals (bps)
      { name: "liquidationBonus", type: "uint256" }, // 4 decimals (bps), e.g. 10500 = 5% bonus
      { name: "decimals", type: "uint256" },
      { name: "reserveFactor", type: "uint256" },
      { name: "usageAsCollateralEnabled", type: "bool" },
      { name: "borrowingEnabled", type: "bool" },
      { name: "stableBorrowRateEnabled", type: "bool" },
      { name: "isActive", type: "bool" },
      { name: "isFrozen", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ─── Aave V3 Event ABI (for account discovery) ───

export const aaveEventAbi = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "reserve", type: "address" },
      { indexed: true, name: "user", type: "address" },
      { indexed: true, name: "onBehalfOf", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: true, name: "referralCode", type: "uint16" },
    ],
    name: "Supply",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "reserve", type: "address" },
      { indexed: false, name: "user", type: "address" },
      { indexed: true, name: "onBehalfOf", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: true, name: "interestRateMode", type: "uint8" },
      { indexed: false, name: "borrowRate", type: "uint256" },
      { indexed: true, name: "referralCode", type: "uint16" },
    ],
    name: "Borrow",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "reserve", type: "address" },
      { indexed: true, name: "user", type: "address" },
      { indexed: true, name: "repayer", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: true, name: "useATokens", type: "bool" },
    ],
    name: "Repay",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "reserve", type: "address" },
      { indexed: true, name: "user", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
    ],
    name: "Withdraw",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "collateralAsset", type: "address" },
      { indexed: true, name: "debtAsset", type: "address" },
      { indexed: true, name: "user", type: "address" },
      { indexed: false, name: "debtToCover", type: "uint256" },
      { indexed: false, name: "liquidatedCollateralAmount", type: "uint256" },
      { indexed: false, name: "liquidator", type: "address" },
      { indexed: false, name: "receiveAToken", type: "bool" },
    ],
    name: "LiquidationCall",
    type: "event",
  },
] as const;
