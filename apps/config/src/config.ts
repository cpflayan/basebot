import fs from "node:fs";
import path from "node:path";

import { arbitrum, base, katana, mainnet, tempo, unichain, worldchain } from "viem/chains";

import { hyperevm, monad } from "./chains";
import type { Config } from "./types";

/// Discovery layer integration — load approved markets from morpho-liquidation-discovery

const DISCOVERY_DATA_DIR = process.env.WHITELIST_DATA_DIR ?? "";

// SECURITY (NM5): 驗證 marketId 格式為 0x + 64 hex chars
const MARKET_ID_REGEX = /^0x[0-9a-fA-F]{64}$/;

export function loadApprovedMarketIds(chainId: number): `0x${string}`[] {
  if (!DISCOVERY_DATA_DIR) return [];
  const filePath = path.join(DISCOVERY_DATA_DIR, `discovered-markets.${chainId}.json`);
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
    console.warn(`[config] 讀取 discovered-markets.${chainId}.json 失敗:`, e);
    return [];
  }
}

/// Bad debt realization

export const ALWAYS_REALIZE_BAD_DEBT = false; // true if you want to always realize bad debt

/// Cooldown mechanisms

export const MARKETS_FETCHING_COOLDOWN_PERIOD = 60 * 60 * 24; // 24 hours (1 day)
export const POSITION_LIQUIDATION_COOLDOWN_ENABLED = true; // true if you want to enable the cooldown mechanism
export const POSITION_LIQUIDATION_COOLDOWN_PERIOD = 60 * 60; // 1 hour

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
        "1inch",
        "erc20Wrapper",
        "erc4626",
        "uniswapV3",
        "uniswapV4",
      ],
      pricers: ["defillama", "chainlink", "uniswapV3"],
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
        "1inch",
        "erc20Wrapper",
        "erc4626",
        "aerodrome",
        "uniswapV3",
        "uniswapV4",
      ],
      pricers: ["defillama", "chainlink", "uniswapV3"],
      liquidationBufferBps: 50,
      useFlashbots: false, // SECURITY (M6): Base 不支持 Flashbots，交易進入公開 mempool，存在三明治攻擊風險
      blockInterval: 10,
      useFlashLoan: true, // SECURITY (M6): Flash loan 在公開 mempool 中可被 sandwich，已於 bot.ts 添加模擬利潤安全邊際
      flashLoanProvider: "balancer",
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
            deployBlock: 19_000_000, // Moonwell deployment on Base — approx Aug 2024
          },
          {
            address: "0x628ff693426583D9a7FB391E54366292F509D457", // mWETH
            underlying: "0x4200000000000000000000000000000000000006", // WETH
            deployBlock: 19_000_000,
          },
          {
            address: "0xF877ACaFA28c19b96727966690b2f44d35aD5976", // mcbBTC
            underlying: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC
            deployBlock: 19_000_000,
          },
        ],
        pollIntervalBlocks: 5,
      },
    },
  },
  [unichain.id]: {
    chain: unichain,
    wNative: "0x4200000000000000000000000000000000000006",
    options: {
      dataProvider: "morphoApi",
      vaultWhitelist: "morpho-api",
      additionalMarketsWhitelist: [],
      liquidityVenues: ["1inch", "erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4"],
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
      liquidityVenues: ["pendlePT", "1inch", "erc20Wrapper", "erc4626", "uniswapV3", "uniswapV4"],
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
