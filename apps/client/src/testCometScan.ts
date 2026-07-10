/**
 * Test script: verify Comet account registry scanning flow.
 * Uses Base public RPC only — no private key or executor needed.
 *
 * Usage: pnpm tsx apps/client/src/testCometScan.ts
 */
import { chainConfigs } from "@morpho-blue-liquidation-bot/config";
import { createPublicClient, http, type Address } from "viem";
import { getBlockNumber, getCode } from "viem/actions";
import { base } from "viem/chains";

import { CometAccountRegistry } from "./cometAccountRegistry.js";

// Base 官方公開 RPC
const BASE_PUBLIC_RPC = "https://mainnet.base.org";

// 從 config.ts 讀取 Comet 配置，避免硬編碼不一致
const rawComets =
  (
    chainConfigs[8453]?.options as {
      cometWatchlist?: { comets: { address: Address; baseAsset: Address; deployBlock: number }[] };
    }
  )?.cometWatchlist?.comets ?? [];

const COMETS = rawComets.map((c, i) => ({
  name: ["USDC", "WETH", "USDbC", "AERO"][i] ?? `Comet-${i}`,
  ...c,
}));

async function main() {
  const client = createPublicClient({
    chain: base,
    transport: http(BASE_PUBLIC_RPC),
  });

  console.log("=== Comet Account Scan Test ===\n");

  // 1. 確認 RPC 連線
  const currentBlock = Number(await getBlockNumber(client));
  console.log(`📡 Base public RPC connected, current block: ${currentBlock}\n`);

  // 2. 找部署區塊（指數擴展 + 二分法）
  console.log("--- Step 1: Find deploy blocks (exponential search + binary search) ---\n");
  const resolvedDeploys: Record<string, number> = {};

  for (const comet of COMETS) {
    // 指數擴展：從估算值開始，逐步擴大範圍直到找到合約
    let lo = comet.deployBlock;
    let hi = comet.deployBlock;
    let step = 100_000;
    let found = false;

    // 先確認估算值本身是否有合約
    let code = await getCode(client, {
      address: comet.address,
      blockNumber: BigInt(lo),
    });
    if (code && code !== "0x") {
      // 合約在估算值已存在，往回找
      hi = lo;
      lo = Math.max(0, lo - step);
      while (lo < hi) {
        code = await getCode(client, {
          address: comet.address,
          blockNumber: BigInt(lo),
        });
        if (code && code !== "0x") {
          hi = lo;
          lo = Math.max(0, lo - step);
        } else {
          break;
        }
      }
      found = true;
    } else {
      // 合約在估算值不存在，往前找
      while (!found && hi < currentBlock) {
        hi += step;
        step *= 2; // 指數擴展
        code = await getCode(client, {
          address: comet.address,
          blockNumber: BigInt(hi),
        });
        if (code && code !== "0x") {
          found = true;
        }
      }
    }

    if (!found) {
      console.log(`❌ ${comet.name}: contract not found up to block ${hi}`);
      continue;
    }

    // 二分法：在 [lo, hi] 範圍內找精確部署區塊
    let searchLo = lo;
    let searchHi = hi;
    let iterations = 0;
    while (searchLo < searchHi) {
      const mid = Math.floor((searchLo + searchHi) / 2);
      const codeAtMid = await getCode(client, {
        address: comet.address,
        blockNumber: BigInt(mid),
      });
      iterations++;
      if (codeAtMid && codeAtMid !== "0x") {
        searchHi = mid;
      } else {
        searchLo = mid + 1;
      }
    }

    console.log(
      `✅ ${comet.name}: deploy block = ${searchLo} (estimated: ${comet.deployBlock}, ${iterations} iterations, range: ${lo}-${hi})`,
    );
    resolvedDeploys[comet.address.toLowerCase()] = searchLo;
  }

  // 3. 帳戶掃描
  console.log("\n--- Step 2: Account registry scan ---\n");
  const registry = new CometAccountRegistry("./data/test-comet-accounts.json");

  for (const comet of COMETS) {
    const deployBlock = resolvedDeploys[comet.address.toLowerCase()] ?? comet.deployBlock;
    console.log(`\n🔍 Scanning ${comet.name} from block ${deployBlock}...`);

    const startTime = Date.now();

    // 直接手動掃描，加 progress log
    const currentBlock = Number(await getBlockNumber(client));
    const BATCH = 10_000;
    let batchCount = 0;
    const totalBatches = Math.ceil((currentBlock - deployBlock + 1) / BATCH);

    for (let start = deployBlock; start <= currentBlock; start += BATCH) {
      const end = Math.min(start + BATCH - 1, currentBlock);
      batchCount++;

      try {
        const logs = await client.getLogs({
          address: comet.address,
          fromBlock: BigInt(start),
          toBlock: BigInt(end),
        });

        if (logs.length > 0) {
          console.log(
            `   📦 Batch ${batchCount}/${totalBatches} (blocks ${start}-${end}): ${logs.length} logs`,
          );
        }

        // 每 100 batch 報告進度
        if (batchCount % 100 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`   ⏳ Progress: ${batchCount}/${totalBatches} batches (${elapsed}s)`);
        }
      } catch (e) {
        console.error(
          `   ❌ Batch ${batchCount} failed (blocks ${start}-${end}):`,
          (e as Error).message,
        );
        // 如果失敗，嘗試更小的批次
        const SMALL_BATCH = 2_000;
        for (let s2 = start; s2 <= end; s2 += SMALL_BATCH) {
          const e2 = Math.min(s2 + SMALL_BATCH - 1, end);
          try {
            const logs2 = await client.getLogs({
              address: comet.address,
              fromBlock: BigInt(s2),
              toBlock: BigInt(e2),
            });
            if (logs2.length > 0) {
              console.log(`   📦 (retry) blocks ${s2}-${e2}: ${logs2.length} logs`);
            }
          } catch (e3) {
            console.error(`   ❌ Retry also failed (blocks ${s2}-${e2}):`, (e3 as Error).message);
          }
        }
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`   ⏱️  Elapsed: ${elapsed}s, ${batchCount} batches scanned`);
  }

  console.log(`\n📊 Total accounts across all Comets: ${registry.totalAccounts}`);
  console.log("✅ Scan test complete!\n");
}

main().catch((e: unknown) => {
  console.error("Scan test failed:", e);
  process.exit(1);
});
