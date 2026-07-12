/**
 * findLiquidationEvents.ts
 *
 * 獨立腳本（不依賴 monorepo 內部路徑），用來抓「真實存在、真的發生過清算」的
 * borrower 地址，補齊 realChainData.fork.test.ts 第 7 節需要的資料。
 *
 * 抓三種協議的清算事件：
 *   - Comet:     AbsorbDebt(address absorber, address borrower, uint256 basePaidOut, uint256 usdValue)
 *   - Aave V3:   LiquidationCall(address collateralAsset, address debtAsset, address user, ...)
 *   - Moonwell:  LiquidateBorrow(address liquidator, address borrower, uint256 repayAmount, address mTokenCollateral, uint256 seizeTokens)
 *
 * 對每筆事件，額外算出 forkBlockNumber = eventBlock - 1（清算發生前一刻），
 * 這樣你把這個 block 餵進 aaveBaseForkTest 就能斷言「清算前一刻 isLiquidatable=true」。
 *
 * ── 使用方式 ──────────────────────────────────────────────
 *   npm install viem dotenv --no-save     # 只需要這兩個套件，沒有的話先裝
 *   RPC_URL_8453=https://xxxx npx tsx findLiquidationEvents.ts
 *
 * 可選環境變數：
 *   LOOKBACK_BLOCKS   要往回掃多少個區塊（預設 300,000，約 Base 上 30~35 天）
 *   CHUNK_SIZE        每次 eth_getLogs 掃多少區塊（預設 2000，依你的 RPC provider
 *                     限制調整；Alchemy 免費層通常抓 500~2000 沒問題）
 *   PER_PROTOCOL_LIMIT 每個協議最多蒐集幾筆事件就停止（預設 5）
 *
 * 執行完會在終端機印出 JSON，同時寫到 ./liquidation-events.json。
 * 把那個 JSON 貼回來給我，我就能幫你把第 7 節的 TODO 填成真的測試。
 * ─────────────────────────────────────────────────────────
 */

import { createPublicClient, http, parseAbiItem, getAddress, formatUnits } from "viem";
import { base } from "viem/chains";
import { writeFileSync } from "fs";
import "dotenv/config";

const RPC_URL = process.env.RPC_URL_8453;
if (!RPC_URL) {
  console.error("❌ 請先設定 RPC_URL_8453 環境變數（例如指向 Alchemy 的 Base RPC）");
  process.exit(1);
}

const LOOKBACK_BLOCKS = BigInt(process.env.LOOKBACK_BLOCKS ?? 300_000);
const CHUNK_SIZE = BigInt(process.env.CHUNK_SIZE ?? 2000);
const PER_PROTOCOL_LIMIT = Number(process.env.PER_PROTOCOL_LIMIT ?? 5);

const client = createPublicClient({ chain: base, transport: http(RPC_URL) });

// ── 從 apps/config/src/config.ts 抄過來的位址（Base = chainId 8453）──────────
const COMET_MARKETS = [
  { address: "0xb125E6687d4313864e53df431d5425969c15Eb2F", label: "USDC" },
  { address: "0x46e6b214b524310239732D51387075E0e70970bf", label: "WETH" },
  { address: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", label: "USDbC" },
  { address: "0x784efeB622244d2348d4F2522f8860B96fbEcE89", label: "AERO" },
] as const;

const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";

const MOONWELL_MTOKENS = [
  { address: "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22", label: "mUSDC" },
  { address: "0x703843C3379b52F9FF486c9f5892218d2a065cC8", label: "mUSDbC" },
  { address: "0x628ff693426583D9a7FB391E54366292F509D457", label: "mWETH" },
  { address: "0x3bf93770f2d4a794c3d9EBEfBAeBAE2a8f09A5E5", label: "mcbETH" },
  { address: "0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b", label: "mwstETH" },
  { address: "0xb8051464C8c92209C92F3a4CD9C73746C4c3CFb3", label: "mweETH" },
  { address: "0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6", label: "mAERO" },
  { address: "0xF877ACaFA28c19b96727966690b2f44d35aD5976", label: "mcbBTC" },
] as const;

// ── Event 定義 ──────────────────────────────────────────────────────────
const absorbDebtEvent = parseAbiItem(
  "event AbsorbDebt(address indexed absorber, address indexed borrower, uint256 basePaidOut, uint256 usdValue)",
);
const liquidationCallEvent = parseAbiItem(
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
);
const liquidateBorrowEvent = parseAbiItem(
  "event LiquidateBorrow(address liquidator, address borrower, uint256 repayAmount, address cTokenCollateral, uint256 seizeTokens)",
);

interface FoundEvent {
  protocol: "comet" | "aave" | "moonwell";
  market: string;
  marketLabel: string;
  borrower: string;
  blockNumber: string;
  forkBlockNumber: string; // blockNumber - 1，給 aaveBaseForkTest 用
  txHash: string;
}

async function scanBackwards(
  address: `0x${string}`,
  event: ReturnType<typeof parseAbiItem>,
  fromBlock: bigint,
  toBlock: bigint,
  limit: number,
): Promise<Array<{ blockNumber: bigint; args: Record<string, unknown>; txHash: string }>> {
  const results: Array<{ blockNumber: bigint; args: Record<string, unknown>; txHash: string }> = [];
  let end = toBlock;

  while (end > fromBlock && results.length < limit) {
    const start = end - CHUNK_SIZE > fromBlock ? end - CHUNK_SIZE : fromBlock;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const logs: any[] = await client.getLogs({
        address,
        event: event as never,
        fromBlock: start,
        toBlock: end,
      });
      for (const log of logs.reverse()) {
        results.push({
          blockNumber: log.blockNumber,
          args: log.args as Record<string, unknown>,
          txHash: log.transactionHash,
        });
        if (results.length >= limit) break;
      }
    } catch (err) {
      console.warn(`   ⚠️  區塊 ${start}~${end} 查詢失敗（可能超過 provider 限制），略過: ${(err as Error).message}`);
    }
    end = start - 1n;
  }
  return results;
}

async function main() {
  const latestBlock = await client.getBlockNumber();
  const fromBlock = latestBlock - LOOKBACK_BLOCKS > 0n ? latestBlock - LOOKBACK_BLOCKS : 0n;

  console.log(`目前區塊高度: ${latestBlock}`);
  console.log(`往回掃描到: ${fromBlock}（共 ${LOOKBACK_BLOCKS} 個區塊）`);
  console.log(`每個協議最多蒐集 ${PER_PROTOCOL_LIMIT} 筆事件\n`);

  const found: FoundEvent[] = [];

  // ── 1. Comet AbsorbDebt ──────────────────────────────────────────────
  for (const market of COMET_MARKETS) {
    console.log(`🔍 掃描 Comet ${market.label} (${market.address}) 的 AbsorbDebt 事件...`);
    const logs = await scanBackwards(
      getAddress(market.address),
      absorbDebtEvent,
      fromBlock,
      latestBlock,
      Math.max(1, Math.ceil(PER_PROTOCOL_LIMIT / COMET_MARKETS.length)),
    );
    for (const log of logs) {
      found.push({
        protocol: "comet",
        market: market.address,
        marketLabel: market.label,
        borrower: String(log.args.borrower),
        blockNumber: log.blockNumber.toString(),
        forkBlockNumber: (log.blockNumber - 1n).toString(),
        txHash: log.txHash,
      });
    }
    console.log(`   找到 ${logs.length} 筆`);
  }

  // ── 2. Aave LiquidationCall ──────────────────────────────────────────
  console.log(`\n🔍 掃描 Aave Pool (${AAVE_POOL}) 的 LiquidationCall 事件...`);
  const aaveLogs = await scanBackwards(
    getAddress(AAVE_POOL),
    liquidationCallEvent,
    fromBlock,
    latestBlock,
    PER_PROTOCOL_LIMIT,
  );
  for (const log of aaveLogs) {
    found.push({
      protocol: "aave",
      market: AAVE_POOL,
      marketLabel: "AavePool",
      borrower: String(log.args.user),
      blockNumber: log.blockNumber.toString(),
      forkBlockNumber: (log.blockNumber - 1n).toString(),
      txHash: log.txHash,
    });
  }
  console.log(`   找到 ${aaveLogs.length} 筆`);

  // ── 3. Moonwell LiquidateBorrow ───────────────────────────────────────
  for (const mToken of MOONWELL_MTOKENS) {
    console.log(`🔍 掃描 Moonwell ${mToken.label} (${mToken.address}) 的 LiquidateBorrow 事件...`);
    const logs = await scanBackwards(
      getAddress(mToken.address),
      liquidateBorrowEvent,
      fromBlock,
      latestBlock,
      Math.max(1, Math.ceil(PER_PROTOCOL_LIMIT / MOONWELL_MTOKENS.length)),
    );
    for (const log of logs) {
      found.push({
        protocol: "moonwell",
        market: mToken.address,
        marketLabel: mToken.label,
        borrower: String(log.args.borrower),
        blockNumber: log.blockNumber.toString(),
        forkBlockNumber: (log.blockNumber - 1n).toString(),
        txHash: log.txHash,
      });
    }
    console.log(`   找到 ${logs.length} 筆`);
  }

  console.log(`\n✅ 總共找到 ${found.length} 筆真實清算事件\n`);
  console.log(JSON.stringify(found, null, 2));

  writeFileSync("./liquidation-events.json", JSON.stringify(found, null, 2));
  console.log(`\n📄 已寫入 ./liquidation-events.json —— 把這個檔案內容貼回來給我`);

  void formatUnits; // 保留 import，未來若要順便印出金額可用
}

main().catch((err) => {
  console.error("腳本執行失敗:", err);
  process.exit(1);
});
