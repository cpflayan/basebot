import type { Address } from "viem";

// ─── Base 鏈 Compound V3 Comet 地址 ───

export const COMET_ADDRESSES = {
  USDC: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
  WETH: "0x46e6b214b524310239732D51387075E0e70970bf",
  USDbC: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf",
  AERO: "0x784efeB622244d2348d4F2522f8860B96fbEcE89",
} as const;

// ─── Base 鏈常用 token 地址 ───

export const BASE_TOKENS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  AERO: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
  cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  cbETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
  wstETH: "0xc1CBa3fCea344f92D9239c08C0f2487b61DE718D",
} as const;

// ─── 每個 Comet 的部署區塊（用於歷史掃描起點）───
// TODO: 用 BaseScan 確認精確區塊號
export const COMET_DEPLOY_BLOCKS: Record<Address, number> = {
  "0xb125E6687d4313864e53df431d5425969c15Eb2F": 2325257, // USDC
  "0x46e6b214b524310239732D51387075E0e70970bf": 8535851, // WETH
  "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf": 1370556, // USDbC
  "0x784efeB622244d2348d4F2522f8860B96fbEcE89": 11956808, // AERO
};

// ─── 每個 Comet 的 Collateral Assets（hardcode fallback）───
// 當 numCollateralAssets() revert 時使用
export const COMET_COLLATERAL_ASSETS: Record<Address, Address[]> = {
  // USDC Comet: WETH, cbETH, wstETH, cbBTC, AERO
  "0xb125E6687d4313864e53df431d5425969c15Eb2F": [
    "0x4200000000000000000000000000000000000006", // WETH
    "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", // cbETH
    "0xc1CBa3fCea344f92D9239c08C0f2487b61DE718D", // wstETH
    "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
    "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO
  ],
  // WETH Comet: cbBTC, wstETH
  "0x46e6b214b524310239732D51387075E0e70970bf": [
    "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
    "0xc1CBa3fCea344f92D9239c08C0f2487b61DE718D", // wstETH
  ],
  // USDbC Comet: WETH, cbETH, wstETH
  "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf": [
    "0x4200000000000000000000000000000000000006", // WETH
    "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", // cbETH
    "0xc1CBa3fCea344f92D9239c08C0f2487b61DE718D", // wstETH
  ],
  // AERO Comet: WETH
  "0x784efeB622244d2348d4F2522f8860B96fbEcE89": [
    "0x4200000000000000000000000000000000000006", // WETH
  ],
};

// ─── Comet 共用合約地址 ───

export const COMET_SHARED = {
  CONFIGURATOR: "0x45939657d1CA34A8FA39A924B71D28Fe8431e581",
  REWARDS: "0x123964802e6ABabBE1Bc9547D72Ef1B69B00A6b1",
  BULKER: "0x78D0677032A35c63D142a48A2037048871212a8C",
} as const;

// ─── Comet View ABI（用於監控和查詢）───

export const cometViewAbi = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "isLiquidatable",
    outputs: [
      { name: "", type: "bool" },
      { name: "", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "absorber", type: "address" },
      { name: "accounts", type: "address[]" },
    ],
    name: "absorb",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "asset", type: "address" },
      { name: "minAmount", type: "uint256" },
      { name: "baseAmount", type: "uint256" },
      { name: "dst", type: "address" },
    ],
    name: "buyCollateral",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getCollateralReserves",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "asset", type: "address" }],
    name: "getPrice",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "baseToken",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "numCollateralAssets",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "i", type: "uint8" }],
    name: "getCollateralAsset",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "userBasic",
    outputs: [
      { name: "principal", type: "int104" },
      { name: "baseTrackingIndex", type: "uint64" },
      { name: "baseTrackingAccrued", type: "uint64" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "account", type: "address" },
      { name: "asset", type: "address" },
    ],
    name: "userCollateral",
    outputs: [
      { name: "balance", type: "uint128" },
      { name: "reserved", type: "uint128" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalsBasic",
    outputs: [
      { name: "totalSupplyBase", type: "int104" },
      { name: "totalBorrowBase", type: "int104" },
      { name: "baseSupplyIndex", type: "uint64" },
      { name: "baseBorrowIndex", type: "uint64" },
      { name: "lastAccrualTime", type: "uint64" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalsCollateral",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ─── Comet 事件 ABI（用於帳戶發現）───

export const cometEventAbi = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "src", type: "address" },
      { indexed: true, name: "dst", type: "address" },
      { indexed: true, name: "asset", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
    ],
    name: "SupplyCollateral",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "src", type: "address" },
      { indexed: true, name: "dst", type: "address" },
      { indexed: true, name: "asset", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
    ],
    name: "WithdrawCollateral",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "absorber", type: "address" },
      { indexed: true, name: "borrower", type: "address" },
      { indexed: false, name: "baseAbsorbed", type: "uint256" },
      { indexed: false, name: "collateralAbsorbed", type: "uint256" },
    ],
    name: "AbsorbDebt",
    type: "event",
  },
] as const;

// ─── 事件 topic0 簽名（用於 webhook 過濾）───

export const COMET_EVENT_SIGNATURES = [
  "SupplyCollateral(address,address,address,uint256)",
  "WithdrawCollateral(address,address,address,uint256)",
  "AbsorbDebt(address,address,uint256,uint256)",
] as const;
