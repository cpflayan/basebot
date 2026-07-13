import fs from "node:fs";
import path from "node:path";

import { arbitrum, base, katana, mainnet, tempo, unichain, worldchain } from "viem/chains";

import { hyperevm, monad } from "./chains";
import type { Config } from "./types";

/// Discovery layer integration — load approved markets from morpho-liquidation-discovery

// SECURITY (NM5): 驗證 marketId 格式為 0x + 64 hex chars
const MARKET_ID_REGEX = /^0x[0-9a-fA-F]{64}$/;

export function loadApprovedMarketIds(chainId: number): `0x${string}`[] {
  const discoveryDir = process.env.WHITELIST_DATA_DIR ?? "";
  if (!discoveryDir) return [];
  const filePath = path.join(discoveryDir, `discovered-markets.${chainId}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!Array.isArray(raw)) {
      console.warn(`[config] discovered-markets.${chainId}.json 格式異常，忽略`);
      return [];
    }
    return raw
      .filter((m: { marketId: string; approved: boolean }) => {
        // NM5: schema validation — 只接受格式正確的 marketId
        if (!m.approved) return false;
        if (!m.marketId || !MARKET_ID_REGEX.test(m.marketId)) {
          console.warn(`[config] 忽略無效 marketId: ${m.marketId}`);
          return false;
        }
        return true;
      })
      .map((m: { marketId: string }) => m.marketId as `0x${string}`);
  } catch (e) {
    console.warn(
      `[config] 讀取 discovered-markets.${chainId}.json 失敗: ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}

/// Bad debt realization

export const ALWAYS_REALIZE_BAD_DEBT = false; // true if you want to always realize bad debt

/// Token blacklist — comma-separated addresses to skip in liquidations
export const TOKEN_BLACKLIST_CONFIG = process.env.TOKEN_BLACKLIST
  ? process.env.TOKEN_BLACKLIST.split(",").map((addr) => addr.trim().toLowerCase())
  : [];

/// Cooldown mechanisms

export const MARKETS_FETCHING_COOLDOWN_PERIOD = 60 * 60 * 24; // 24 hours (1 day)
export const POSITION_LIQUIDATION_COOLDOWN_ENABLED = true; // true if you want to enable the cooldown mechanism
/** Hard / success cooldown after a real liquidation attempt (seconds). */
export const POSITION_LIQUIDATION_COOLDOWN_PERIOD = 60 * 60; // 1 hour
/**
 * Race-lost cooldown (competitor took the liq / HF recovered) — short so we can retry if
 * price re-breaks the position. Used by Aave graded cooldown.
 */
export const POSITION_LIQUIDATION_COOLDOWN_RACE_SECONDS = 15;
/** Soft failure (unprofitable / slippage / route) — medium. */
export const POSITION_LIQUIDATION_COOLDOWN_SOFT_SECONDS = 120;

/// Chains configurations

export const chainConfigs: Record<number, Config> = {
  [mainnet.id]: {
    chain: mainnet,
    wNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: [
        "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB",
        "0x8eB67A509616cd6A7c1B3c8C21D48FF57df3d458",
      ],
      additionalMarketsWhitelist: [
        "0x1eda1b67414336cab3914316cb58339ddaef9e43f939af1fed162a989c98bc20",
        "0xff527fe9c6516f9d82a3d51422ccb031d123266e6e26d4c22c942a948c180a75",
      ],
      liquidityVenues: [
        "pendlePT",
        "midas",
        "erc20Wrapper",
        "erc4626",
        "uniswapV3",
        "uniswapV4",
        "1inch",
      ],
      pricers: ["chainlink", "defillama", "uniswapV3"],
      liquidationBufferBps: 50,
      useFlashbots: true,
      blockInterval: 2,
    },
  },
  [base.id]: {
    chain: base,
    wNative: "0x4200000000000000000000000000000000000006",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: ["0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183"],
      additionalMarketsWhitelist: loadApprovedMarketIds(base.id),
      liquidityVenues: [
        "pendlePT",
        "midas",
        "erc20Wrapper",
        "erc4626",
        "aerodrome",
        "uniswapV3",
        "uniswapV4",
        "1inch",
      ],
      pricers: ["chainlink", "pyth", "defillama", "uniswapV3"],
      liquidationBufferBps: 50,
      useFlashbots: false, // SECURITY (M6): Base 不支持 Flashbots，交易進入公開 mempool，存在三明治攻擊風險
      blockInterval: 10,
      useFlashLoan: true, // SECURITY (M6): Flash loan 在公開 mempool 中可被 sandwich，已於 bot.ts 添加模擬利潤安全邊際
      flashLoanProvider: "balancer",
      flashLoanFallbackProviders: ["morpho", "aave"],
      treasuryAddress: "0x5faB997dd358c75680fF2b33E403aB81530fE30a",
      cometWatchlist: {
        enabled: true,
        comets: [
          {
            address: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
            baseAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
            deployBlock: 11699480, // verified via binary search
          },
          {
            address: "0x46e6b214b524310239732D51387075E0e70970bf",
            baseAsset: "0x4200000000000000000000000000000000000006", // WETH
            deployBlock: 2495303, // verified via binary search
          },
          {
            address: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf",
            baseAsset: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
            deployBlock: 2197588, // verified via binary search
          },
          {
            address: "0x784efeB622244d2348d4F2522f8860B96fbEcE89",
            baseAsset: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO
            deployBlock: 20852405, // verified via binary search
          },
        ],
        pollIntervalBlocks: 5,
      },
      moonwellWatchlist: {
        enabled: true,
        comptroller: "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C",
        mTokens: [
          {
            address: "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22", // mUSDC
            underlying: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
            deployBlock: 3_702_954,
          },
          {
            address: "0x703843C3379b52F9FF486c9f5892218d2a065cC8", // mUSDbC
            underlying: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
            deployBlock: 2_162_445,
          },
          {
            address: "0x628ff693426583D9a7FB391E54366292F509D457", // mWETH
            underlying: "0x4200000000000000000000000000000000000006", // WETH
            deployBlock: 2_162_460,
          },
          {
            address: "0x3bf93770f2d4a794c3d9EBEfBAeBAE2a8f09A5E5", // mcbETH
            underlying: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", // cbETH
            deployBlock: 2_162_476,
          },
          {
            address: "0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b", // mwstETH
            underlying: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", // wstETH
            deployBlock: 6_272_868,
          },
          {
            address: "0xCB1DaCd30638ae38F2B94eA64F066045B7D45f44", // mrETH
            underlying: "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c", // rETH
            deployBlock: 6_570_943,
          },
          {
            address: "0xb8051464C8c92209C92F3a4CD9C73746C4c3CFb3", // mweETH
            underlying: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", // weETH
            deployBlock: 18_092_452,
          },
          {
            address: "0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6", // mAERO
            underlying: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", // AERO
            deployBlock: 13_815_306,
          },
          {
            address: "0xF877ACaFA28c19b96727966690b2f44d35aD5976", // mcbBTC
            underlying: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
            deployBlock: 19_389_314,
          },
          {
            address: "0xb682c840B5F4FC58B20769E691A6fa1305A501a2", // mEURC
            underlying: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", // EURC
            deployBlock: 19_597_257,
          },
          {
            address: "0xfC41B49d064Ac646015b459C522820DB9472F4B5", // mwrsETH
            underlying: "0xEDfa23602D0EC14714057867A78d01e94176BEA0", // wrsETH
            deployBlock: 20_948_090,
          },
          {
            address: "0xdC7810B47eAAb250De623F0eE07764afa5F71ED1", // mWELL
            underlying: "0xA88594D404727625A9437C3f886C7643872296AE", // WELL
            deployBlock: 24_784_003,
          },
          {
            address: "0xb6419c6C2e60c4025D6D06eE4F913ce89425a357", // mUSDS
            underlying: "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc", // USDS
            deployBlock: 25_430_421,
          },
          {
            address: "0x9A858ebfF1bEb0D3495BB0e2897c1528eD84A218", // mtBTC
            underlying: "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b", // tBTC
            deployBlock: 25_430_819,
          },
          // Additional markets discovered on-chain (21 total)
          {
            address: "0x73b06D8d18De422E269645eaCe15400DE7462417", // mDAI
            underlying: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // DAI
            deployBlock: 2_967_683,
          },
          {
            address: "0x10fF57877b79e9bd949B3815220eC87B9fc5D2ee", // mLBTC
            underlying: "0xecAc9C5F704e954931349Da37F60E39f515c11c1", // LBTC
            deployBlock: 25_443_366,
          },
          {
            address: "0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64", // mVIRTUAL
            underlying: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", // VIRTUAL
            deployBlock: 25_693_711,
          },
          {
            address: "0x6308204872BdB7432dF97b04B42443c714904F3E", // mMORPHO
            underlying: "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842", // MORPHO
            deployBlock: 28_360_295,
          },
          {
            address: "0xb4fb8fed5b3AaA8434f0B19b1b623d977e07e86d", // mcbXRP
            underlying: "0xcb585250f852C6c6bf90434AB21A00f02833a4af", // cbXRP
            deployBlock: 31_516_963,
          },
          {
            address: "0x2F90Bb22eB3979f5FfAd31EA6C3F0792ca66dA32", // mMAMO
            underlying: "0x7300B37DfdfAb110d83290A29DfB31B1740219fE", // MAMO
            deployBlock: 36_665_237,
          },
          {
            address: "0xD64BCb70C613a6D1F4D7D57Ba64bb4a0767A9682", // mVVV
            underlying: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf", // VVV
            deployBlock: 43_541_377,
          },
        ],
        pollIntervalBlocks: 5,
      },
      aaveWatchlist: {
        enabled: true, // feature flag — set to true to enable Aave V3 liquidation bot
        poolAddress: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
        poolDeployBlock: 2357134, // verified via binary search (eth_getCode)
        reserves: [
          "0x4200000000000000000000000000000000000006", // WETH
          "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", // cbETH
          "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
          "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", // wstETH
          "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
          "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", // weETH
          "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
          "0x2416092f143378750bb29b79eD961ab195CcEea5", // ezETH
          "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee", // GHO
          "0xEDfa23602D0EC14714057867A78d01e94176BEA0", // lbtc
          "0xecAc9C5F704e954931349Da37F60E39f515c11c1", // rETH
          "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", // EURC
          "0x63706e401c06ac8513145b7687A14804d17f814b", // tBTC
          "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b", // xETH
          "0x660975730059246A68521a3e2FBD4740173100f5", // rgUSD
        ],
        // Race: every block hot set; full registry less often to cut 429 bursts
        // (hot path still catches near-liq; full only refreshes membership)
        pollIntervalBlocks: 1,
        fullScanIntervalBlocks: 15,
        nearHealthFactor: 1.05,
        hfBatchSize: 100,
        // concurrency capped in bot via HF_CONCURRENCY / defaultHfConcurrency (≤3)
      },
      // BUGFIX: 原本只用免費的 mainnet.base.org 做歷史事件掃描(可能要掃幾千萬個區塊),
      // 極容易被 rate limit。現在優先用已設定的付費 RPC,免費節點降級為最後備援。
      scanRpcUrls: [
        process.env.RPC_URL_BASE,
        process.env.RPC_URL_BASE2,
        process.env.RPC_URL_BASE3,
        process.env.RPC_URL_BASE4,
        process.env.RPC_URL_BASE5,
        process.env.RPC_URL_BASE6,
        process.env.RPC_URL_BASE7,
        process.env.PUBLIC_RPC_URL_BASE,
        "https://mainnet.base.org",
      ].filter((u): u is string => Boolean(u)),
    },
  },
  [unichain.id]: {
    chain: unichain,
    wNative: "0x4200000000000000000000000000000000000006",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [],
      liquidityVenues: ["erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4", "1inch"],
      liquidationBufferBps: 50,
      useFlashbots: false,
      blockInterval: 5,
    },
  },
  [katana.id]: {
    chain: katana,
    wNative: "0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [],
      liquidityVenues: ["erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4"],
      liquidationBufferBps: 50,
      useFlashbots: false,
      blockInterval: 5,
    },
  },
  [arbitrum.id]: {
    chain: arbitrum,
    wNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [],
      liquidityVenues: ["pendlePT", "erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4", "1inch"],
      liquidationBufferBps: 50,
      useFlashbots: false,
    },
  },
  [worldchain.id]: {
    chain: worldchain,
    wNative: "0x4200000000000000000000000000000000000006",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: [
        "0xb1E80387EbE53Ff75a89736097D34dC8D9E9045B", // Re7 USDC
        "0x348831b46876d3dF2Db98BdEc5E3B4083329Ab9f", // Re7 WLD
        "0x0Db7E405278c2674F462aC9D9eb8b8346D1c1571", // Re7 WETH
        "0xBC8C37467c5Df9D50B42294B8628c25888BECF61", // Re7 WBTC
      ],
      additionalMarketsWhitelist: [],
      liquidityVenues: ["erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4"],
      liquidationBufferBps: 50,
      useFlashbots: false,
      blockInterval: 5,
    },
  },
  [hyperevm.id]: {
    chain: hyperevm,
    wNative: "0x5555555555555555555555555555555555555555",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: [
        "0x8A862fD6c12f9ad34C9c2ff45AB2b6712e8CEa27", // Felix USDC
        "0xFc5126377F0efc0041C0969Ef9BA903Ce67d151e", // Felix USDT
        "0x2900ABd73631b2f60747e687095537B673c06A76", // Felix HYPE
      ],
      liquidityVenues: ["liquidSwap", "erc20Wrapper", "erc4626", "uniswapV3"],
      additionalMarketsWhitelist: [],
      liquidationBufferBps: 50,
      useFlashbots: false,
    },
  },
  [monad.id]: {
    chain: monad,
    wNative: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [],
      liquidityVenues: ["erc20Wrapper", "erc4626", "uniswapV3"],
      liquidationBufferBps: 50,
      useFlashbots: false,
      blockInterval: 10,
    },
  },
  [tempo.id]: {
    chain: tempo,
    wNative: "0x20C000000000000000000000b9537d11c60E8b50",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [],
      liquidityVenues: ["erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4"],
      liquidationBufferBps: 50,
      useFlashbots: false,
      blockInterval: 5,
    },
  },
};
