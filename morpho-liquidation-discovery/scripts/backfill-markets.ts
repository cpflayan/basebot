/**
 * 歷史回填腳本
 * 掃描 Morpho Blue (Base) 從部署塊到當前塊的所有 CreateMarket 事件，
 * 跑安全檢查後寫入 data/ 白名單，供 discover 服務接續監聽新市場。
 *
 * 用法: npx tsx scripts/backfill-markets.ts
 *
 * Morpho Blue 在 Base 的部署塊約為 ~4,400,000（2024 年初）
 * 如需精確起始塊，可查 https://basescan.org/address/0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http, decodeEventLog } from "viem";
import { base } from "viem/chains";
import { MORPHO_BLUE_ADDRESS, CREATE_MARKET_EVENT } from "../src/shared/chains.js";
import { runSafetyChecks } from "../src/safety/checks.js";
import { saveDiscoveredMarket, loadDiscovered } from "../src/shared/whitelist-store.js";
import type { ChainSetup } from "../src/shared/chains.js";

// ─── 配置 ───
const BASE_CHAIN_ID = 8453;
const MORPHO_BLUE_DEPLOY_BLOCK = 13_977_148n; // Morpho Blue 在 Base 的實際部署塊（二分法確認）
const BATCH_SIZE = BigInt(process.env.BACKFILL_BATCH_SIZE ?? 100_000); // Alchemy 支持大範圍；QuickNode 需設為 5
const PROGRESS_INTERVAL = 50; // 每 N 批打印一次進度
const CHECKPOINT_INTERVAL = 100; // 每 N 批寫入 checkpoint
const DATA_DIR = process.env.WHITELIST_DATA_DIR ?? path.resolve(process.cwd(), "data");
const CHECKPOINT_FILE = path.join(DATA_DIR, "backfill-checkpoint.json");

// ─── ChainSetup（僅 Base）───
// SCAN_RPC: 用於 eth_getLogs 事件掃描（需支持大區塊範圍）
// SAFETY_RPC: 用於安全檢查的 eth_call（oracle 驗證、proxy 檢測等）
const SCAN_RPC_URL = process.env.BACKFILL_SCAN_RPC ?? process.env.RPC_URL_BASE ?? "";
const SAFETY_RPC_URL = process.env.BACKFILL_SAFETY_RPC ?? process.env.RPC_URL_BASE ?? "";

const baseSetup: ChainSetup = {
  chainId: BASE_CHAIN_ID,
  chain: base,
  rpcUrl: SAFETY_RPC_URL, // safety checks 使用穩定的 RPC
  liquidationEnabled: true,
};

if (!SCAN_RPC_URL || !SAFETY_RPC_URL) {
  console.error("❌ 缺少 RPC 環境變數。需要 RPC_URL_BASE 或 BACKFILL_SCAN_RPC + BACKFILL_SAFETY_RPC");
  process.exit(1);
}

// ─── Checkpoint ───

interface Checkpoint {
  lastBlock: string; // bigint 序列化为 string
  totalEvents: number;
  newMarkets: number;
  approvedCount: number;
  savedAt: string;
}

function loadCheckpoint(): Checkpoint | null {
  if (!fs.existsSync(CHECKPOINT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

// ─── Main ───
async function main() {
  console.log("=== Morpho Blue 歷史市場回填 (Base chain) ===\n");

  const client = createPublicClient({
    chain: base,
    transport: http(SCAN_RPC_URL), // 事件掃描使用高容量 RPC
  });

  // 1. 取得當前塊號
  const currentBlock = await client.getBlockNumber();
  console.log(`當前塊號: ${currentBlock}`);

  // 2. 檢查 checkpoint（斷點續傳）
  const checkpoint = loadCheckpoint();
  let fromBlock = MORPHO_BLUE_DEPLOY_BLOCK;
  let totalEvents = 0;
  let newMarkets = 0;
  let approvedCount = 0;

  if (checkpoint && BigInt(checkpoint.lastBlock) > MORPHO_BLUE_DEPLOY_BLOCK) {
    fromBlock = BigInt(checkpoint.lastBlock);
    totalEvents = checkpoint.totalEvents;
    newMarkets = checkpoint.newMarkets;
    approvedCount = checkpoint.approvedCount;
    console.log(`🔄 找到 checkpoint，從 block ${fromBlock} 繼續`);
    console.log(`   上次保存: ${checkpoint.savedAt}`);
    console.log(`   累計進度: ${totalEvents} 個事件, ${newMarkets} 個新市場\n`);
  } else {
    console.log(`起始塊號: ${MORPHO_BLUE_DEPLOY_BLOCK}`);
  }

  // 3. 檢查已存在的市場（避免重複處理）
  const existing = loadDiscovered(BASE_CHAIN_ID);
  const existingIds = new Set(existing.map((m) => m.marketId));
  console.log(`已有白名單記錄: ${existingIds.size} 個市場（將跳過重複）\n`);

  console.log(`掃描範圍: ${(currentBlock - fromBlock).toString()} 個區塊\n`);
  console.log("🔍 開始掃描 CreateMarket 事件...\n");

  let batchNum = 0;

  while (fromBlock <= currentBlock) {
    const toBlock = fromBlock + BATCH_SIZE - 1n > currentBlock ? currentBlock : fromBlock + BATCH_SIZE - 1n;

    try {
      const logs = await client.getLogs({
        address: MORPHO_BLUE_ADDRESS,
        event: CREATE_MARKET_EVENT,
        fromBlock,
        toBlock,
      });

      for (const log of logs) {
        totalEvents++;

        try {
          const decoded = decodeEventLog({
            abi: [CREATE_MARKET_EVENT],
            data: log.data,
            topics: log.topics,
          });

          const { id, marketParams } = decoded.args as {
            id: `0x${string}`;
            marketParams: {
              loanToken: `0x${string}`;
              collateralToken: `0x${string}`;
              oracle: `0x${string}`;
              irm: `0x${string}`;
              lltv: bigint;
            };
          };

          // 跳過已存在的
          if (existingIds.has(id)) {
            continue;
          }

          console.log(`  📦 發現市場 ${id.slice(0, 16)}... (block ${log.blockNumber})`);

          // 跑安全檢查
          const result = await runSafetyChecks({
            chainSetup: baseSetup,
            oracle: marketParams.oracle,
            loanToken: marketParams.loanToken,
            collateralToken: marketParams.collateralToken,
            lltv: marketParams.lltv,
          });

          const statusEmoji = result.approved ? "✅" : "⛔";
          const hardFailInfo = result.hardFail ? ` [HARD FAIL: ${result.hardFailReasons.join("; ")}]` : "";
          console.log(`    ${statusEmoji} 分數: ${result.score}/100${hardFailInfo}`);

          saveDiscoveredMarket({
            marketId: id,
            chainId: BASE_CHAIN_ID,
            loanToken: marketParams.loanToken,
            collateralToken: marketParams.collateralToken,
            oracle: marketParams.oracle,
            irm: marketParams.irm,
            lltv: marketParams.lltv.toString(),
            discoveredAt: new Date().toISOString(),
            safetyScore: result.score,
            safetyNotes: result.notes,
            approved: result.approved,
          });

          newMarkets++;
          if (result.approved) approvedCount++;
        } catch (e) {
          console.error(`  ⚠️  解碼事件失敗 (block ${log.blockNumber}):`, (e as Error).message);
        }
      }
    } catch (e) {
      console.error(`  ⚠️  查詢區塊 ${fromBlock}-${toBlock} 失敗:`, (e as Error).message);
    }

    fromBlock = toBlock + 1n;
    batchNum++;

    // 定期保存 checkpoint
    if (batchNum % CHECKPOINT_INTERVAL === 0) {
      saveCheckpoint({
        lastBlock: fromBlock.toString(),
        totalEvents,
        newMarkets,
        approvedCount,
        savedAt: new Date().toISOString(),
      });
    }

    // 進度報告
    if (batchNum % PROGRESS_INTERVAL === 0) {
      const pct = (((fromBlock - MORPHO_BLUE_DEPLOY_BLOCK) * 100n) / (currentBlock - MORPHO_BLUE_DEPLOY_BLOCK)).toString();
      console.log(`  ⏳ 進度: ${pct}% (block ${fromBlock})，已發現 ${totalEvents} 個市場`);
    }
  }

  // 最终 checkpoint（标记完成）
  saveCheckpoint({
    lastBlock: currentBlock.toString(),
    totalEvents,
    newMarkets,
    approvedCount,
    savedAt: new Date().toISOString(),
  });

  // 4. 總結
  console.log("\n" + "═".repeat(60));
  console.log("📈 回填完成");
  console.log("═".repeat(60));
  console.log(`  掃描區塊範圍: ${MORPHO_BLUE_DEPLOY_BLOCK} → ${currentBlock}`);
  console.log(`  發現的 CreateMarket 事件: ${totalEvents} 個`);
  console.log(`  新增至白名單: ${newMarkets} 個`);
  console.log(`  通過安全檢查 (approved): ${approvedCount} 個`);
  console.log(`  未通過 (rejected): ${newMarkets - approvedCount} 個`);
  console.log(`\n  白名單檔案: data/discovered-markets.${BASE_CHAIN_ID}.json`);
  console.log(`  總市場數: ${loadDiscovered(BASE_CHAIN_ID).length}\n`);
}

main().catch((e) => {
  console.error("回填失敗:", e);
  process.exit(1);
});
