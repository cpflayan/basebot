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

/**
 * PoolAddressesProvider — source of truth for PoolDataProvider upgrades.
 * Prefer `fetchAaveProtocolDataProvider()` over static maps (address changes over time).
 */
export const AAVE_V3_ADDRESSES_PROVIDER: Record<number, Address> = {
  // Base
  8453: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
  // Ethereum mainnet
  1: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
} as const;

/**
 * AaveProtocolDataProvider (PoolDataProvider) — NOT the Pool.
 * Static fallback when AddressesProvider read fails. Keep aligned with live
 * PoolAddressesProvider.getPoolDataProvider() on each chain.
 */
export const AAVE_V3_PROTOCOL_DATA_PROVIDER: Record<number, Address> = {
  // Base — live PoolDataProvider (was 0x2d8A3C…; still callable but not current)
  8453: "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A",
  // Ethereum mainnet
  1: "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3",
} as const;

/** Resolve ProtocolDataProvider for a known Pool address (lowercase keys). */
export const AAVE_V3_POOL_TO_DATA_PROVIDER: Record<string, Address> = {
  [AAVE_V3_POOL_ADDRESSES[8453]!.toLowerCase()]: AAVE_V3_PROTOCOL_DATA_PROVIDER[8453]!,
  [AAVE_V3_POOL_ADDRESSES[1]!.toLowerCase()]: AAVE_V3_PROTOCOL_DATA_PROVIDER[1]!,
};

export const aaveAddressesProviderAbi = [
  {
    inputs: [],
    name: "getPoolDataProvider",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export function resolveAaveProtocolDataProvider(
  poolAddress: Address,
  chainId?: number,
): Address | undefined {
  const byPool = AAVE_V3_POOL_TO_DATA_PROVIDER[poolAddress.toLowerCase()];
  if (byPool) return byPool;
  if (chainId !== undefined) return AAVE_V3_PROTOCOL_DATA_PROVIDER[chainId];
  return undefined;
}

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

// ─── Aave V3 ProtocolDataProvider ABI (per-reserve user + config) ───
// These views are on AaveProtocolDataProvider / PoolDataProvider, NOT on Pool.

export const aaveProtocolDataProviderAbi = [
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
  {
    // Official field order: decimals first, then ltv / LT / bonus / RF / flags
    inputs: [{ name: "asset", type: "address" }],
    name: "getReserveConfigurationData",
    outputs: [
      { name: "decimals", type: "uint256" },
      { name: "ltv", type: "uint256" }, // 4 decimals (bps)
      { name: "liquidationThreshold", type: "uint256" }, // 4 decimals (bps)
      { name: "liquidationBonus", type: "uint256" }, // e.g. 10500 = 5% bonus
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

/** @deprecated Use aaveProtocolDataProviderAbi — Pool never had getUserReserveData */
export const aavePoolReserveDataAbi = aaveProtocolDataProviderAbi;

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

// ─── Aave V3 Reserve Configuration ABI (ProtocolDataProvider) ───
// Alias kept for call sites that only need configuration reads.

export const aaveReserveConfigurationAbi = [
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getReserveConfigurationData",
    outputs: [
      { name: "decimals", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "liquidationThreshold", type: "uint256" },
      { name: "liquidationBonus", type: "uint256" },
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
// Indexed flags must match official IPool (max 3 indexed topics excluding topic0).

export const aaveEventAbi = [
  {
    // Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)
    anonymous: false,
    inputs: [
      { indexed: true, name: "reserve", type: "address" },
      { indexed: false, name: "user", type: "address" },
      { indexed: true, name: "onBehalfOf", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: true, name: "referralCode", type: "uint16" },
    ],
    name: "Supply",
    type: "event",
  },
  {
    // Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount,
    //        DataTypes.InterestRateMode interestRateMode, uint256 borrowRate, uint16 indexed referralCode)
    anonymous: false,
    inputs: [
      { indexed: true, name: "reserve", type: "address" },
      { indexed: false, name: "user", type: "address" },
      { indexed: true, name: "onBehalfOf", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: false, name: "interestRateMode", type: "uint8" },
      { indexed: false, name: "borrowRate", type: "uint256" },
      { indexed: true, name: "referralCode", type: "uint16" },
    ],
    name: "Borrow",
    type: "event",
  },
  {
    // Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)
    anonymous: false,
    inputs: [
      { indexed: true, name: "reserve", type: "address" },
      { indexed: true, name: "user", type: "address" },
      { indexed: true, name: "repayer", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: false, name: "useATokens", type: "bool" },
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
