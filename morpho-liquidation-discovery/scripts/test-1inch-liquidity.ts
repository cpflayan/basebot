#!/usr/bin/env tsx
/**
 * 1inch 流動性測試腳本
 * 針對 discovered-markets.8453.json 中 approved: false 的市場，
 * 用 1inch Swap API 檢查 collateral → loan 是否有路由。
 *
 * 用法: ONE_INCH_SWAP_API_KEY=xxx tsx scripts/test-1inch-liquidity.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "..", "data", "discovered-markets.8453.json");
const ONE_INCH_API_BASE = "https://api.1inch.dev";
const CHAIN_ID = 8453; // Base

interface Market {
  marketId: string;
  chainId: number;
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: string;
  discoveredAt: string;
  safetyScore: number;
  safetyNotes: string[];
  approved: boolean;
}

interface OneInchQuoteResult {
  hasRoute: boolean;
  dstAmount: string | null;
  error: string | null;
}

async function checkOneInchRoute(
  srcToken: string,
  dstToken: string,
  amount: string,
  apiKey: string,
  maxRetries = 3,
): Promise<OneInchQuoteResult> {
  const url = new URL(`/swap/v6.1/${CHAIN_ID}/quote`, ONE_INCH_API_BASE);
  url.searchParams.set("src", srcToken);
  url.searchParams.set("dst", dstToken);
  url.searchParams.set("amount", amount);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (res.status === 429) {
        // Rate limited — wait and retry
        const retryAfter = parseInt(res.headers.get("retry-after") ?? "5", 10);
        const waitMs = (retryAfter || 5) * 1000 + 500;
        if (attempt < maxRetries) {
          process.stdout.write(`[429 wait ${retryAfter}s] `);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        return { hasRoute: false, dstAmount: null, error: `HTTP 429 after ${maxRetries} retries` };
      }

      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        return { hasRoute: false, dstAmount: null, error: `HTTP ${res.status}: ${errorBody.slice(0, 200)}` };
      }

      const data = (await res.json()) as { dstAmount?: string; toAmount?: string };
      const dstAmount = data.dstAmount ?? data.toAmount ?? null;

      if (dstAmount && BigInt(dstAmount) > 0n) {
        return { hasRoute: true, dstAmount, error: null };
      }

      return { hasRoute: false, dstAmount: dstAmount ?? "0", error: "dstAmount = 0" };
    } catch (e) {
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      return { hasRoute: false, dstAmount: null, error: (e as Error).message };
    }
  }

  return { hasRoute: false, dstAmount: null, error: "max retries exceeded" };
}

function formatAmount(amount: string, decimals: number): string {
  const str = amount.padStart(decimals + 1, "0");
  const intPart = str.slice(0, str.length - decimals) || "0";
  const fracPart = str.slice(str.length - decimals, str.length - decimals + 4);
  return `${intPart}.${fracPart}`;
}

async function main() {
  const apiKey = process.env.ONE_INCH_SWAP_API_KEY;
  if (!apiKey) {
    console.error("❌ 請設置環境變量 ONE_INCH_SWAP_API_KEY");
    process.exit(1);
  }

  console.log(`📂 讀取市場數據: ${DATA_FILE}`);
  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  const markets: Market[] = JSON.parse(raw);

  // 篩選: approved=false 且 safetyScore+40>=60 (加回流動性分數能過關)
  const candidates = markets.filter((m) => !m.approved && m.safetyScore >= 20);
  const skipLow = markets.filter((m) => !m.approved && m.safetyScore < 20);

  console.log(`\n📊 市場統計:`);
  console.log(`   總計: ${markets.length}`);
  console.log(`   已批准: ${markets.filter((m) => m.approved).length}`);
  console.log(`   未批准: ${markets.filter((m) => !m.approved).length}`);
  console.log(`   分數>=20 值得測試: ${candidates.length}`);
  console.log(`   分數<20 跳過: ${skipLow.length}`);

  if (candidates.length === 0) {
    console.log("\n✅ 沒有需要測試的市場");
    return;
  }

  // 按 pair 去重: 同一個 collateral→loan 只調一次 API
  const pairCache = new Map<string, OneInchQuoteResult>();
  const uniquePairs = new Set<string>();
  for (const m of candidates) {
    uniquePairs.add(`${m.collateralToken.toLowerCase()}→${m.loanToken.toLowerCase()}`);
  }
  console.log(`   去重後唯一 pair 數: ${uniquePairs.size}`);

  console.log(`\n🔍 開始測試 ${uniquePairs.size} 個唯一 pair 的 1inch 流動性...\n`);
  console.log("─".repeat(100));

  let passCount = 0;
  let failCount = 0;
  let updatedCount = 0;
  let apiCalls = 0;

  const uniquePairsArr = Array.from(uniquePairs);
  for (let i = 0; i < uniquePairsArr.length; i++) {
    const pairKey = uniquePairsArr[i];
    const [src, dst] = pairKey.split("→");

    process.stdout.write(`[${i + 1}/${uniquePairsArr.length}] ${src.slice(0, 10)}→${dst.slice(0, 10)} ... `);

    const result = await checkOneInchRoute(src, dst, "1000000000000000000", apiKey);
    pairCache.set(pairKey, result);
    apiCalls++;

    if (result.hasRoute) {
      passCount++;
      console.log(`✅ 有路由 dstAmount=${result.dstAmount}`);
    } else {
      failCount++;
      console.log(`❌ ${result.error ?? "無路由"}`);
    }

    // 1inch API rate limit
    await new Promise((r) => setTimeout(r, 300));
  }

  // 套用結果到所有候選市場
  console.log("\n" + "─".repeat(100));
  console.log(`\n📝 套用結果到 ${candidates.length} 個市場...`);

  for (const market of candidates) {
    const pairKey = `${market.collateralToken.toLowerCase()}→${market.loanToken.toLowerCase()}`;
    const result = pairCache.get(pairKey);
    if (result?.hasRoute) {
      market.approved = true;
      market.safetyScore = market.safetyScore + 40;
      market.safetyNotes = market.safetyNotes.filter(
        (n) => !n.includes("流動性不足") && !n.includes("深度不足") && !n.includes("流動性深度不足"),
      );
      market.safetyNotes.push("1inch 流動性路由驗證通過 ✓");
      updatedCount++;
    }
  }

  console.log(`\n📊 結果摘要:`);
  console.log(`   API 調用次數: ${apiCalls}`);
  console.log(`   通過 pair 數: ${passCount}`);
  console.log(`   失敗 pair 數: ${failCount}`);
  console.log(`   已更新 approved=true 市場數: ${updatedCount}`);

  // 保存修改後的 JSON (原子寫入)
  if (updatedCount > 0) {
    const tmpFile = DATA_FILE + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(markets, null, 2), "utf-8");
    fs.renameSync(tmpFile, DATA_FILE);
    console.log(`\n💾 已保存更新: ${DATA_FILE} (${updatedCount} 個市場已批准)`);
  } else {
    console.log("\n⚠️ 沒有市場需要更新");
  }
}

main().catch(console.error);
