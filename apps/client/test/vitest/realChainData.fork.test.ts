/**
 * apps/client/test/vitest/realChainData.fork.test.ts
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 這份測試檔案跟 allBots.fork.test.ts 的哲學不一樣：
 *
 * allBots.fork.test.ts 會用 impersonation + supply/withdraw 手動「捏」出一個
 * SAFE_USER / LIQ_USER 假帳戶，來模擬安全 / 可清算的倉位。這種做法的問題是：
 * 一旦某個寫死的常量（例如 base asset 地址）跟被測試的市場對不上，捏出來的
 * 帳戶狀態就會悄悄失真，而測試本身看不出來哪裡錯（3.3 Comet LIQ position
 * borrowed 那次除錯就是活生生的例子）。
 *
 * 這份檔案完全不建構任何假帳戶。它只做一件事：把 config.ts 裡實際配置的每一個
 * 地址，拿去問「fork 當下區塊」的真實鏈上合約「你真正的狀態是什麼」，然後
 * 斷言兩者一致。如果哪天有人在 config.ts 裡填錯一個地址、填錯一個 baseAsset、
 * 填錯一個 underlying token —— 這裡會直接紅燈，不需要再手動一條條 cast call
 * 去對。
 *
 * Prerequisites:
 *   RPC_URL_8453 必須指向真實 Base RPC（例如 Alchemy），Anvil fork 才起得來。
 *
 * ⚠️ 已知限制（寫這份檔案的當下發現的）：
 *   aaveBaseForkTest 目前 pin 在 block 25,000,000（見 test/setup.ts）。
 *   moonwellWatchlist.mTokens 裡有 8 個市場的 deployBlock 晚於這個區塊
 *   （mUSDS / mtBTC / mLBTC / mVIRTUAL / mMORPHO / mcbXRP / mMAMO / mVVV），
 *   在這個 fork 高度上根本還沒部署。下面的測試會自動跳過這些市場並在
 *   console 印出跳過清單，不會因此誤判成 FAIL —— 但這代表這份 fork 的
 *   pin 區塊已經偏舊，值得找時間評估要不要調高，否則新加的市場永遠測不到。
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { chainConfigs } from "@morpho-blue-liquidation-bot/config";
import { getChainAddresses } from "@morpho-org/blue-sdk";
import { createViemTest } from "@morpho-org/test/vitest";
import { getAddress, parseAbi, type Address } from "viem";
import { getCode, readContract } from "viem/actions";
import { base } from "viem/chains";
import { describe, expect } from "vitest";

import { HEALTH_FACTOR_THRESHOLD, aavePoolViewAbi } from "../../src/abis/AaveV3.js";
import { cometViewAbi } from "../../src/abis/Comet.js";
import { MOONWELL_COMPTROLLER, comptrollerAbi, mTokenAbi } from "../../src/abis/Moonwell.js";
import { aaveBaseForkTest } from "../setup.js";

const CHAIN_ID = 8453;
const FORK_BLOCK = 25_000_000; // 必須跟 test/setup.ts 裡 aaveBaseForkTest 的 forkBlockNumber 一致

const options = chainConfigs[CHAIN_ID]?.options;
if (!options) {
  throw new Error(`chainConfigs[${CHAIN_ID}].options 未定義，無法跑真實鏈上數據測試`);
}

const aavePoolAbi = parseAbi(["function getReservesList() view returns (address[])"]);
const chainlinkFeedAbi = parseAbi([
  "function latestAnswer() view returns (int256)",
  "function decimals() view returns (uint8)",
]);

// ─── 1. Comet: config 裡每個市場的 baseAsset 是否跟鏈上 baseToken() 一致 ──────────

describe("1. Comet baseAsset 一致性（真實鏈上 baseToken() vs config.ts）", () => {
  const comets = options.cometWatchlist?.comets ?? [];

  for (const market of comets) {
    aaveBaseForkTest(
      `Comet ${market.address} 的鏈上 baseToken() 應等於 config 裡宣告的 baseAsset`,
      async ({ client }) => {
        const onChainBaseToken = await readContract(client, {
          address: getAddress(market.address),
          abi: cometViewAbi,
          functionName: "baseToken",
        });
        expect(
          getAddress(onChainBaseToken),
          `Comet ${market.address}：config 寫的 baseAsset=${market.baseAsset}，` +
            `但鏈上 baseToken() 實際回傳 ${onChainBaseToken}`,
        ).toBe(getAddress(market.baseAsset));
      },
    );
  }
});

// ─── 2. Moonwell: 每個 mToken 的 underlying() 是否跟 config 一致 ────────────────

describe("2. Moonwell underlying() 一致性（真實鏈上 underlying() vs config.ts）", () => {
  const allMTokens = options.moonwellWatchlist?.mTokens ?? [];
  const testable = allMTokens.filter((m) => m.deployBlock <= FORK_BLOCK);
  const skipped = allMTokens.filter((m) => m.deployBlock > FORK_BLOCK);

  if (skipped.length > 0) {
    console.warn(
      `[realChainData] 跳過 ${skipped.length} 個 mToken（deployBlock 晚於 fork 高度 ${FORK_BLOCK}）：\n` +
        skipped
          .map((m) => `  - ${m.address} (underlying=${m.underlying}, deployBlock=${m.deployBlock})`)
          .join("\n"),
    );
  }

  for (const m of testable) {
    aaveBaseForkTest(
      `mToken ${m.address} 的鏈上 underlying() 應等於 config 裡宣告的 underlying`,
      async ({ client }) => {
        const onChainUnderlying = await readContract(client, {
          address: getAddress(m.address),
          abi: mTokenAbi,
          functionName: "underlying",
        });
        expect(
          getAddress(onChainUnderlying),
          `mToken ${m.address}：config 寫的 underlying=${m.underlying}，` +
            `但鏈上 underlying() 實際回傳 ${onChainUnderlying}`,
        ).toBe(getAddress(m.underlying));
      },
    );
  }
});

// ─── 3. Aave: config 裡列出的 reserves 是否都真的存在於 Pool.getReservesList() ────

describe("3. Aave reserves 一致性（真實鏈上 getReservesList() vs config.ts）", () => {
  aaveBaseForkTest(
    "config 裡列出的每個 reserve 都應該存在於 Aave Pool 的 getReservesList()",
    async ({ client }) => {
      const poolAddress = getAddress(options.aaveWatchlist!.poolAddress);
      const onChainReserves = await readContract(client, {
        address: poolAddress,
        abi: aavePoolAbi,
        functionName: "getReservesList",
      });
      const onChainSet = new Set(onChainReserves.map((a) => a.toLowerCase()));

      const missing = options.aaveWatchlist!.reserves.filter(
        (r) => !onChainSet.has(r.toLowerCase()),
      );

      expect(
        missing,
        `以下 reserve 寫在 config 裡，但不存在於鏈上 Aave Pool.getReservesList()：\n` +
          missing.join("\n"),
      ).toEqual([]);
    },
  );
});

// ─── 4. Morpho Blue: SDK 解析出來的地址在鏈上應該真的有部署合約 ──────────────────

describe("4. Morpho Blue 合約存在性", () => {
  aaveBaseForkTest("getChainAddresses(8453).morpho 在鏈上應該有部署 code", async ({ client }) => {
    const { morpho } = getChainAddresses(CHAIN_ID);
    const code = await getCode(client, { address: getAddress(morpho) });
    expect(
      code,
      `Morpho Blue 地址 ${morpho} 在鏈上沒有 code —— SDK 版本是不是不對？`,
    ).toBeDefined();
    expect(code!.length).toBeGreaterThan(2); // "0x" 代表沒部署任何 bytecode
  });
});

// ─── 5. 所有 config 裡的關鍵地址都應該有部署 code（不是打錯字的地址）─────────────

describe("5. config.ts 內關鍵地址部署 code 檢查", () => {
  const addressesToCheck: { label: string; address: string }[] = [
    { label: "aaveWatchlist.poolAddress", address: options.aaveWatchlist?.poolAddress ?? "" },
    {
      label: "moonwellWatchlist.comptroller",
      address: options.moonwellWatchlist?.comptroller ?? "",
    },
    { label: "treasuryAddress", address: options.treasuryAddress ?? "" },
    ...(options.cometWatchlist?.comets ?? []).map((c) => ({
      label: `cometWatchlist market ${c.baseAsset}`,
      address: c.address,
    })),
  ].filter((x): x is { label: string; address: string } => Boolean(x.address));

  for (const { label, address } of addressesToCheck) {
    aaveBaseForkTest(`${label} (${address}) 應該有部署 code`, async ({ client }) => {
      const code = await getCode(client, { address: getAddress(address) });
      expect(code, `${label}=${address} 在鏈上沒有 code —— 是不是打錯地址了？`).toBeDefined();
      expect(code!.length).toBeGreaterThan(2);
    });
  }
});

// ─── 6. Oracle sanity check：USDC/USD 應該接近 $1，不是脫錨也不是讀錯 decimals ────

describe("6. Chainlink USDC/USD Oracle sanity check", () => {
  const usdcAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
  const chainlinkFeeds = options.pricers?.includes("chainlink")
    ? (chainConfigs[CHAIN_ID] as unknown as {
        options: { chainlinkFeeds?: Record<string, string> };
      })
    : undefined;

  aaveBaseForkTest("USDC/USD Chainlink feed 應該落在 $0.98 ~ $1.02 之間", async ({ client }) => {
    // Base 上 USDC/USD Chainlink feed（跟 pricers/chainlink.ts 裡設定的一致）
    const usdcFeed = getAddress("0x7e860098F58bBFC8648a4311b374B1D669a2bc6B");
    const [answer, decimals] = await Promise.all([
      readContract(client, {
        address: usdcFeed,
        abi: chainlinkFeedAbi,
        functionName: "latestAnswer",
      }),
      readContract(client, { address: usdcFeed, abi: chainlinkFeedAbi, functionName: "decimals" }),
    ]);
    const price = Number(answer) / 10 ** decimals;

    expect(
      price,
      `讀到的 USDC 價格是 $${price}，偏離 $1 太多，可能讀錯 feed 或 decimals`,
    ).toBeGreaterThan(0.98);
    expect(
      price,
      `讀到的 USDC 價格是 $${price}，偏離 $1 太多，可能讀錯 feed 或 decimals`,
    ).toBeLessThan(1.02);
    void usdcAddress;
    void chainlinkFeeds;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. 真實歷史清算事件重放 —— 用鏈上歷史 Liquidation 事件掃到的真實 borrower
// ─────────────────────────────────────────────────────────────────────────────
//
// 這 11 筆全部來自 Base 鏈上真實發生過的清算（2026-07-11 用 RPC_URL_8453 掃描
// 最近 300,000 個區塊得到，見 liquidation-events.json）。每個事件把 fork 釘在
// 「清算發生前一刻」（eventBlock - 1），然後斷言：
//   (a) 清算前一刻，這個帳戶的鏈上狀態「確實」是可清算 / 資不抵債
//   (b) 這不是憑空捏出來的帳戶，是真的被清算過、有真實 tx hash 可查證的帳戶
//
// ⚠️ 注意：cometViewAbi 裡的 isLiquidatable 定義有 2 個 output（bool, uint256），
// 但 Comet 合約實際上 isLiquidatable(address) 只回傳單一 bool —— 這是繼
// wstETH 地址重複定義之後，這個 repo 裡第二個「ABI 跟鏈上實際不一致」的案例
// （已在 allBots.fork.test.ts 用簡化過的單一 bool ABI 繞開，這裡沿用同樣做法，
// 不直接用 cometViewAbi 裡那個有問題的定義）。建議找時間把 cometViewAbi 的
// isLiquidatable 定義也修掉。
//
// 因為每筆事件的 forkBlockNumber 都不同，Anvil fork 沒辦法共用單一 fixture，
// 所以這裡用 createViemTest 針對每個 block 各自起一個 fork（跟 test/setup.ts
// 裡 encoderTest / encoderTestLaterBlock 用不同 forkBlockNumber 開多個 fixture
// 的做法一致）。

const isLiquidatableAbi = parseAbi([
  "function isLiquidatable(address account) view returns (bool)",
]);

function makeBaseForkTestAt(blockNumber: number) {
  return createViemTest(base, {
    forkUrl: process.env.RPC_URL_8453 ?? base.rpcUrls.default.http[0],
    forkBlockNumber: blockNumber,
    timeout: 120_000,
  });
}

interface HistoricalLiquidation {
  protocol: "comet" | "aave" | "moonwell";
  market: Address;
  marketLabel: string;
  borrower: Address;
  blockNumber: number;
  forkBlockNumber: number;
  txHash: string;
}

// 直接內嵌 liquidation-events.json 的內容，避免測試依賴檔案系統上的相對路徑。
const HISTORICAL_LIQUIDATIONS: HistoricalLiquidation[] = [
  {
    protocol: "comet",
    market: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
    marketLabel: "Comet USDC",
    borrower: "0x6b6884BfcD72327Bf86515a29C3d3d6588Bf2075",
    blockNumber: 48_460_674,
    forkBlockNumber: 48_460_673,
    txHash: "0xb6a6ad3625ce302d2fb4e7e37f59820a2d7be557ab0ae123a6b31db7941e530d",
  },
  {
    protocol: "comet",
    market: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
    marketLabel: "Comet USDC",
    borrower: "0x65F18ff427a516EB9ffcF3A140741D9E24484d28",
    blockNumber: 48_460_673,
    forkBlockNumber: 48_460_672,
    txHash: "0x769463f35fefb7ffa4ab475e6def920418f56a0174aef9ae1a9a0975e4329877",
  },
  {
    protocol: "aave",
    market: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    marketLabel: "Aave Pool",
    borrower: "0x279ee5B1D6D2Fa34968712b3688A05F0BBbb2895",
    blockNumber: 48_397_753,
    forkBlockNumber: 48_397_752,
    txHash: "0xa825e08707a07c5895ea2581774967f66594fd3f6eb5c238f8fffb9e517ccc1a",
  },
  {
    protocol: "aave",
    market: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    marketLabel: "Aave Pool",
    borrower: "0xFcFCfEA388aF8881CE2822c993CB59Da7dE6747A",
    blockNumber: 48_394_572,
    forkBlockNumber: 48_394_571,
    txHash: "0x14d1cf7de110a50d96c23d3e08ee9c4fdb8c5afe6d5296f0568c0003822e97bd",
  },
  {
    protocol: "aave",
    market: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    marketLabel: "Aave Pool",
    borrower: "0x6621BBEe6DEab2d729E9Fc62677A166759184736",
    blockNumber: 48_386_712,
    forkBlockNumber: 48_386_711,
    txHash: "0x41eb4a1c6acceb22a65eeae4696d33f67ce103588ac87b01ad203f2df2f84df5",
  },
  {
    protocol: "aave",
    market: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    marketLabel: "Aave Pool",
    borrower: "0x4e57F2ae90b168ac8120bE917B0687f79ef6cF10",
    blockNumber: 48_379_792,
    forkBlockNumber: 48_379_791,
    txHash: "0xcc580dd1ac416b452801b9724214b56fb35df79b25b68766d7a6f2fb5ba6ec6d",
  },
  {
    protocol: "aave",
    market: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    marketLabel: "Aave Pool",
    borrower: "0xD4f125e5b88a30F21a417c7Aa98D54eb895dE786",
    blockNumber: 48_369_819,
    forkBlockNumber: 48_369_818,
    txHash: "0xc6cf54b059197105e04dece87607d370c63c680231d55b18fe8ddf3a5c7c9e73",
  },
  {
    protocol: "moonwell",
    market: "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22",
    marketLabel: "mUSDC",
    borrower: "0xb4DF220A3F96802E382FC97e293E7fe7C5cedE26",
    blockNumber: 48_454_416,
    forkBlockNumber: 48_454_415,
    txHash: "0xc41cab42d1226ca6f9e6861221b0a53c5e27333c6ba1c672f2cd2e168dba9014",
  },
  {
    protocol: "moonwell",
    market: "0x628ff693426583D9a7FB391E54366292F509D457",
    marketLabel: "mWETH",
    borrower: "0xb64F1eBAfbb3e64f975B54C963A249CB2F77b40b",
    blockNumber: 48_483_120,
    forkBlockNumber: 48_483_119,
    txHash: "0xc11ad0bc876a84367203361deaff0b67b8ab2b061e609a0af3dff3f2e94065c5",
  },
  {
    protocol: "moonwell",
    market: "0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6",
    marketLabel: "mAERO",
    borrower: "0x6766c78D076F03A090C297F6Bd81e364f31dC1e6",
    blockNumber: 48_318_774,
    forkBlockNumber: 48_318_773,
    txHash: "0x6bd8a2016d431a35dc185b595bfbfb7788137540ec3e527214653d13546cd70a",
  },
  {
    protocol: "moonwell",
    market: "0xF877ACaFA28c19b96727966690b2f44d35aD5976",
    marketLabel: "mcbBTC",
    borrower: "0x18de382D215E6356BF31EDDFFbca3004053E8231",
    blockNumber: 48_301_166,
    forkBlockNumber: 48_301_165,
    txHash: "0xe017c972bec468417f1c11414a999eb2915c582b9e2abb86a338f0b095671b04",
  },
];

describe("7. 真實歷史清算事件重放（清算前一刻的鏈上狀態應為「可清算」）", () => {
  for (const event of HISTORICAL_LIQUIDATIONS) {
    const forkTest = makeBaseForkTestAt(event.forkBlockNumber);
    const label =
      `[真實事件 tx=${event.txHash.slice(0, 10)}…] ${event.marketLabel} borrower=${event.borrower} ` +
      `於 block ${event.forkBlockNumber}（清算發生前一刻）應已處於可清算狀態`;

    if (event.protocol === "comet") {
      forkTest(label, async ({ client }) => {
        const isLiq = await readContract(client, {
          address: getAddress(event.market),
          abi: isLiquidatableAbi,
          functionName: "isLiquidatable",
          args: [getAddress(event.borrower)],
        });
        expect(
          isLiq,
          `${event.marketLabel} borrower=${event.borrower} 在清算前一個區塊（${event.forkBlockNumber}）` +
            `isLiquidatable() 應為 true，但實際回傳 ${isLiq}。這筆是真實 tx=${event.txHash} 的清算事件。`,
        ).toBe(true);
      });
    } else if (event.protocol === "aave") {
      forkTest(label, async ({ client }) => {
        const [, , , , , healthFactor] = await readContract(client, {
          address: getAddress(event.market),
          abi: aavePoolViewAbi,
          functionName: "getUserAccountData",
          args: [getAddress(event.borrower)],
        });
        expect(
          healthFactor < HEALTH_FACTOR_THRESHOLD,
          `Aave borrower=${event.borrower} 在清算前一個區塊（${event.forkBlockNumber}）` +
            `healthFactor 應 < 1e18（不健康），但實際為 ${healthFactor}。這筆是真實 tx=${event.txHash} 的清算事件。`,
        ).toBe(true);
      });
    } else {
      forkTest(label, async ({ client }) => {
        const [, , shortfall] = await readContract(client, {
          address: getAddress(MOONWELL_COMPTROLLER),
          abi: comptrollerAbi,
          functionName: "getAccountLiquidity",
          args: [getAddress(event.borrower)],
        });
        expect(
          shortfall > 0n,
          `Moonwell (${event.marketLabel}) borrower=${event.borrower} 在清算前一個區塊` +
            `（${event.forkBlockNumber}）shortfall 應 > 0（資不抵債），但實際為 ${shortfall}。` +
            `這筆是真實 tx=${event.txHash} 的清算事件。`,
        ).toBe(true);
      });
    }
  }
});
