/**
 * Moonwell (Compound V2 fork) ABI definitions for Base chain.
 *
 * SECURITY: Moonwell V2 Comptroller's `markets(address)` is NOT compatible
 * with standard Compound V2 ABI — avoid using it. Instead, query individual
 * mToken contracts directly and use Comptroller global params.
 *
 * Comptroller: 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C
 */
import type { Address } from "viem";

// ─── Base 鏈 Moonwell 關鍵合約地址 ───

export const MOONWELL_COMPTROLLER = "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C" as const;

// ─── Base 鏈主要 MToken 地址 ───

export const MOONWELL_MTOKENS = {
  mUSDC: "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22",
  mWETH: "0x628ff693426583D9a7FB391E54366292F509D457",
  mcbBTC: "0xF877ACaFA28c19b96727966690b2f44d35aD5976",
} as const;

// ─── MToken → Underlying 映射（hardcoded fallback）───

export const MOONWELL_UNDERLYING_MAP: Record<Address, Address> = {
  // mUSDC → USDC
  "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  // mWETH → WETH
  "0x628ff693426583D9a7FB391E54366292F509D457": "0x4200000000000000000000000000000000000006",
  // mcbBTC → cbBTC
  "0xF877ACaFA28c19b96727966690b2f44d35aD5976": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
};

// ─── Comptroller ABI ───
// NOTE: Do NOT use `markets(address)` — Moonwell V2 ABI is incompatible.

export const comptrollerAbi = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "getAccountLiquidity",
    outputs: [
      { name: "error", type: "uint256" },
      { name: "liquidity", type: "uint256" },
      { name: "shortfall", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getCloseFactor",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "closeFactorMantissa",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "liquidationIncentiveMantissa",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getAllMarkets",
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ─── MToken (CErc20) ABI ───

export const mTokenAbi = [
  // Liquidation
  {
    inputs: [
      { name: "mTokenCollateral", type: "address" },
      { name: "borrower", type: "address" },
      { name: "repayAmount", type: "uint256" },
    ],
    name: "liquidateBorrow",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },

  // Exchange rate & balances
  {
    inputs: [],
    name: "exchangeRateStored",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "borrowBalanceCurrent",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "borrowBalanceStored",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },

  // Redeem (mToken → underlying)
  {
    inputs: [{ name: "redeemTokens", type: "uint256" }],
    name: "redeem",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "redeemAmount", type: "uint256" }],
    name: "redeemUnderlying",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },

  // Market info
  {
    inputs: [],
    name: "underlying",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalBorrows",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getCash",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalReserves",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "reserveFactorMantissa",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ─── MToken 事件 ABI（用於帳戶發現）───

export const mTokenEventAbi = [
  {
    anonymous: false,
    inputs: [
      { indexed: false, name: "minter", type: "address" },
      { indexed: false, name: "mintAmount", type: "uint256" },
      { indexed: false, name: "mintTokens", type: "uint256" },
    ],
    name: "Mint",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, name: "borrower", type: "address" },
      { indexed: false, name: "borrowAmount", type: "uint256" },
      { indexed: false, name: "accountBorrows", type: "uint256" },
      { indexed: false, name: "totalBorrows", type: "uint256" },
    ],
    name: "Borrow",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, name: "payer", type: "address" },
      { indexed: false, name: "borrower", type: "address" },
      { indexed: false, name: "repayAmount", type: "uint256" },
      { indexed: false, name: "accountBorrows", type: "uint256" },
      { indexed: false, name: "totalBorrows", type: "uint256" },
    ],
    name: "RepayBorrow",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, name: "liquidator", type: "address" },
      { indexed: false, name: "borrower", type: "address" },
      { indexed: false, name: "repayAmount", type: "uint256" },
      { indexed: false, name: "mTokenCollateral", type: "address" },
      { indexed: false, name: "seizeTokens", type: "uint256" },
    ],
    name: "LiquidateBorrow",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, name: "redeemer", type: "address" },
      { indexed: false, name: "redeemAmount", type: "uint256" },
      { indexed: false, name: "redeemTokens", type: "uint256" },
    ],
    name: "Redeem",
    type: "event",
  },
] as const;
