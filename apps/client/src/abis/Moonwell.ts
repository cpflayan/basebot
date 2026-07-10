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
  mUSDbC: "0x703843C3379b52F9FF486c9f5892218d2a065cC8",
  mWETH: "0x628ff693426583D9a7FB391E54366292F509D457",
  mcbETH: "0x3bf93770f2d4a794c3d9EBEfBAeBAE2a8f09A5E5",
  mDAI: "0x73b06D8d18De422E269645eaCe15400DE7462417",
  mwstETH: "0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b",
  mrETH: "0xCB1DaCd30638ae38F2B94eA64F066045B7D45f44",
  mAERO: "0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6",
  mweETH: "0xb8051464C8c92209C92F3a4CD9C73746C4c3CFb3",
  mcbBTC: "0xF877ACaFA28c19b96727966690b2f44d35aD5976",
  mEURC: "0xb682c840B5F4FC58B20769E691A6fa1305A501a2",
  mwrsETH: "0xfC41B49d064Ac646015b459C522820DB9472F4B5",
  mWELL: "0xdC7810B47eAAb250De623F0eE07764afa5F71ED1",
  mUSDS: "0xb6419c6C2e60c4025D6D06eE4F913ce89425a357",
  mtBTC: "0x9A858ebfF1bEb0D3495BB0e2897c1528eD84A218",
  mLBTC: "0x10fF57877b79e9bd949B3815220eC87B9fc5D2ee",
  mVIRTUAL: "0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64",
  mMORPHO: "0x6308204872BdB7432dF97b04B42443c714904F3E",
  mcbXRP: "0xb4fb8fed5b3AaA8434f0B19b1b623d977e07e86d",
  mMAMO: "0x2F90Bb22eB3979f5FfAd31EA6C3F0792ca66dA32",
  mVVV: "0xD64BCb70C613a6D1F4D7D57Ba64bb4a0767A9682",
} as const;

// ─── MToken → Underlying 映射（hardcoded fallback）───

export const MOONWELL_UNDERLYING_MAP: Record<Address, Address> = {
  // mUSDC → USDC (native)
  "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  // mUSDbC → USDbC
  "0x703843C3379b52F9FF486c9f5892218d2a065cC8": "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  // mWETH → WETH
  "0x628ff693426583D9a7FB391E54366292F509D457": "0x4200000000000000000000000000000000000006",
  // mcbETH → cbETH
  "0x3bf93770f2d4a794c3d9EBEfBAeBAE2a8f09A5E5": "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
  // mDAI → DAI
  "0x73b06D8d18De422E269645eaCe15400DE7462417": "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  // mwstETH → wstETH
  "0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b": "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
  // mrETH → rETH
  "0xCB1DaCd30638ae38F2B94eA64F066045B7D45f44": "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c",
  // mAERO → AERO
  "0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
  // mweETH → weETH
  "0xb8051464C8c92209C92F3a4CD9C73746C4c3CFb3": "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A",
  // mcbBTC → cbBTC
  "0xF877ACaFA28c19b96727966690b2f44d35aD5976": "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  // mEURC → EURC
  "0xb682c840B5F4FC58B20769E691A6fa1305A501a2": "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
  // mwrsETH → wrsETH
  "0xfC41B49d064Ac646015b459C522820DB9472F4B5": "0xEDfa23602D0EC14714057867A78d01e94176BEA0",
  // mWELL → WELL
  "0xdC7810B47eAAb250De623F0eE07764afa5F71ED1": "0xA88594D404727625A9437C3f886C7643872296AE",
  // mUSDS → USDS
  "0xb6419c6C2e60c4025D6D06eE4F913ce89425a357": "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc",
  // mtBTC → tBTC
  "0x9A858ebfF1bEb0D3495BB0e2897c1528eD84A218": "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b",
  // mLBTC → LBTC
  "0x10fF57877b79e9bd949B3815220eC87B9fc5D2ee": "0xecAc9C5F704e954931349Da37F60E39f515c11c1",
  // mVIRTUAL → VIRTUAL
  "0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64": "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
  // mMORPHO → MORPHO
  "0x6308204872BdB7432dF97b04B42443c714904F3E": "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842",
  // mcbXRP → cbXRP
  "0xb4fb8fed5b3AaA8434f0B19b1b623d977e07e86d": "0xcb585250f852C6c6bf90434AB21A00f02833a4af",
  // mMAMO → MAMO
  "0x2F90Bb22eB3979f5FfAd31EA6C3F0792ca66dA32": "0x7300B37DfdfAb110d83290A29DfB31B1740219fE",
  // mVVV → VVV
  "0xD64BCb70C613a6D1F4D7D57Ba64bb4a0767A9682": "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf",
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
