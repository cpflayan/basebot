"use strict";
/**
 * 掃描 Morpho Blue on Base 的清算機會
 * 過濾壞賬，只顯示有利可圖的清算目標
 *
 * 用法: npx tsx scripts/scan-liquidations.ts
 */
const MORPHO_API = "https://api.morpho.org/graphql";
const BASE_CHAIN_ID = 8453;
const WHITELIST_PATH = process.env.WHITELIST_DATA_DIR
    ? `${process.env.WHITELIST_DATA_DIR}/discovered-markets.${BASE_CHAIN_ID}.json`
    : "./data/discovered-markets.8453.json";
// 過濾門檻
const MIN_COLLATERAL_USD = 100; // 抵押品至少 $100 才值得看（排除壞賬和粉塵倉位）
const MIN_BORROW_USD = 50; // 借款至少 $50
const MAX_TOP_MARKETS = 50; // 掃描借款最大的 N 個市場
// ─── GraphQL Queries ───
const MARKETS_QUERY = `
  query Markets($first: Int, $skip: Int, $where: MarketFilters) {
    markets(first: $first, skip: $skip, orderBy: BorrowAssetsUsd, orderDirection: Desc, where: $where) {
      items {
        marketId
        lltv
        loanAsset { address symbol decimals }
        collateralAsset { address symbol decimals }
        oracle { address }
        state {
          borrowAssets
          borrowAssetsUsd
          supplyAssets
          supplyAssetsUsd
          collateralAssets
          collateralAssetsUsd
          utilization
        }
      }
      pageInfo { count countTotal }
    }
  }
`;
const POSITIONS_QUERY = `
  query Positions($first: Int, $skip: Int, $where: MarketPositionFilters) {
    marketPositions(first: $first, skip: $skip, orderBy: BorrowShares, orderDirection: Desc, where: $where) {
      items {
        user { address }
        market { marketId }
        state {
          borrowShares
          borrowAssets
          borrowAssetsUsd
          collateral
          collateralUsd
          supplyShares
          supplyAssets
          supplyAssetsUsd
        }
      }
      pageInfo { count countTotal }
    }
  }
`;
// ─── API Helper ───
async function gql(query, variables = {}) {
    const res = await fetch(MORPHO_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json());
    if (json.errors) {
        console.error("GraphQL errors:", JSON.stringify(json.errors, null, 2).slice(0, 500));
    }
    return json.data;
}
// ─── Health Factor 計算 ───
// Morpho Blue: liquidatable when borrowValue > collateralValue * lltv
// HF = (collateralValue * lltv) / borrowValue
// HF < 1 = liquidatable
function calcHealthFactor(borrowUsd, collateralUsd, lltv) {
    if (borrowUsd <= 0)
        return Infinity;
    if (collateralUsd <= 0)
        return 0;
    return (collateralUsd * lltv) / borrowUsd;
}
// ─── 清算利潤估算（修正版）───
// Morpho Blue 清算機制：
//   清算人償還 X 的債務，獲得價值 X × (1 + incentive) 的抵押品
//   但最多只能沒收倉位的全部抵押品
//
// 因此：
//   maxRepay = min(borrowUsd, collateralUsd / (1 + incentive))
//   grossProfit = maxRepay × incentive
//
// 當 collateralUsd < borrowUsd（HF<1）時：
//   如果 collateralUsd 很小 → maxRepay 很小 → 利潤很小（大部分債務無法回收 = 壞賬）
//   如果 collateralUsd 接近 borrowUsd → 利潤 = 差額部分的 incentive
const LIQUIDATION_INCENTIVE = 0.05; // 假設 5% 清算獎勵（實際由市場 curator 設定）
const SLIPPAGE_BPS = 30; // 假設 DEX 兌換滑點 0.3%（30 bps）
const GAS_COST_USD = 0.10; // Base 鏈 Gas 約 $0.01-0.10
function estimateLiquidationProfit(borrowUsd, collateralUsd, lltv) {
    // 核心公式：最多能偿还多少债务（受限于可没收的抵押品）
    const maxRepayUsd = Math.min(borrowUsd, collateralUsd / (1 + LIQUIDATION_INCENTIVE));
    const seizedCollateralUsd = maxRepayUsd * (1 + LIQUIDATION_INCENTIVE);
    const grossProfitUsd = seizedCollateralUsd - maxRepayUsd; // = maxRepayUsd × incentive
    // 净利润：扣除滑点和 Gas
    const slippageCost = seizedCollateralUsd * (SLIPPAGE_BPS / 10000);
    const netProfitUsd = grossProfitUsd - slippageCost - GAS_COST_USD;
    // 坏账判定：抵押品不足以覆盖全部债务
    const isBadDebt = collateralUsd < borrowUsd;
    const unrecoverableDebtUsd = isBadDebt ? borrowUsd - collateralUsd : 0;
    const profitable = netProfitUsd > 0 && collateralUsd > 0;
    return { profitable, maxRepayUsd, seizedCollateralUsd, grossProfitUsd, netProfitUsd, isBadDebt, unrecoverableDebtUsd };
}
// ─── 分頁抓取倉位 ───
async function fetchAllPositions(marketIds) {
    const allPositions = [];
    const batchSize = 100;
    for (const marketId of marketIds) {
        let skip = 0;
        let hasMore = true;
        while (hasMore) {
            try {
                const data = await gql(POSITIONS_QUERY, {
                    first: batchSize,
                    skip,
                    where: {
                        marketUniqueKey_in: [marketId],
                        borrowShares_gte: "1",
                    },
                });
                const positions = data?.marketPositions?.items ?? [];
                allPositions.push(...positions);
                const total = data?.marketPositions?.pageInfo?.count ?? 0;
                skip += batchSize;
                hasMore = skip < total;
            }
            catch (e) {
                console.error(`  抓取 market ${marketId.slice(0, 10)}... skip=${skip} 失敗:`, e.message);
                hasMore = false;
            }
        }
    }
    return allPositions;
}
// ─── 格式化 ───
function fmt$(n) {
    if (n >= 1_000_000)
        return `$${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000)
        return `$${(n / 1_000).toFixed(1)}K`;
    return `$${n.toFixed(2)}`;
}
// ─── 載入白名單 ───
async function loadWhitelist() {
    try {
        const fs = await import("fs");
        if (!fs.existsSync(WHITELIST_PATH)) {
            console.warn(`⚠️  白名單文件不存在: ${WHITELIST_PATH}`);
            console.warn(`   將掃描所有市場（無白名單過濾）\n`);
            return new Set();
        }
        const raw = JSON.parse(fs.readFileSync(WHITELIST_PATH, "utf-8"));
        if (!Array.isArray(raw)) {
            console.warn(`⚠️  白名單格式異常，將掃描所有市場\n`);
            return new Set();
        }
        const approved = raw
            .filter((m) => m.approved === true && m.marketId)
            .map((m) => m.marketId.toLowerCase());
        console.log(`✅ 已載入白名單: ${approved.length} 個市場 (from ${WHITELIST_PATH})\n`);
        return new Set(approved);
    }
    catch (e) {
        console.warn(`⚠️  讀取白名單失敗: ${e.message}，將掃描所有市場\n`);
        return new Set();
    }
}
// ─── Main ───
async function main() {
    console.log("=== Morpho Blue 清算掃描器 (Base chain) ===");
    console.log(`過濾條件: 抵押品 >= $${MIN_COLLATERAL_USD}, 借款 >= $${MIN_BORROW_USD}\n`);
    // Step 0: 載入白名單
    const whitelist = await loadWhitelist();
    const useWhitelist = whitelist.size > 0;
    // Step 1: 抓取所有市場
    console.log("📡 正在抓取 Base 鏈上所有 Morpho Blue 市場...");
    const allMarkets = [];
    let skip = 0;
    const batchSize = 100;
    let totalMarkets = 0;
    while (true) {
        const data = await gql(MARKETS_QUERY, {
            first: batchSize,
            skip,
            where: { chainId_in: [BASE_CHAIN_ID] },
        });
        const markets = data?.markets?.items ?? [];
        allMarkets.push(...markets);
        totalMarkets = data?.markets?.pageInfo?.countTotal ?? 0;
        if (allMarkets.length % 500 === 0)
            console.log(`  已抓取 ${allMarkets.length}/${totalMarkets} 個市場`);
        if (allMarkets.length >= totalMarkets || markets.length < batchSize)
            break;
        skip += batchSize;
    }
    console.log(`  完成: ${allMarkets.length} 個市場`);
    // Step 1.5: 白名單過濾
    const filteredMarkets = useWhitelist
        ? allMarkets.filter((m) => whitelist.has(m.marketId.toLowerCase()))
        : allMarkets;
    if (useWhitelist) {
        console.log(`  🔒 白名單過濾後: ${filteredMarkets.length} 個市場（從 ${allMarkets.length} 個中篩選）\n`);
    }
    else {
        console.log("");
    }
    // Step 2: 篩選活躍市場（從白名單過濾後的市場中）
    const activeMarkets = filteredMarkets.filter((m) => Number(m.state?.borrowAssetsUsd ?? 0) > 100);
    activeMarkets.sort((a, b) => Number(b.state?.borrowAssetsUsd ?? 0) - Number(a.state?.borrowAssetsUsd ?? 0));
    const totalBorrowUsd = activeMarkets.reduce((s, m) => s + Number(m.state?.borrowAssetsUsd ?? 0), 0);
    console.log(`📊 活躍市場: ${activeMarkets.length} 個, 總借款: ${fmt$(totalBorrowUsd)}`);
    // Step 3: 掃描 Top 市場（從白名單活躍市場中）
    const topMarkets = activeMarkets.slice(0, MAX_TOP_MARKETS);
    console.log(`🔍 掃描 Top ${topMarkets.length} 白名單市場的倉位...\n`);
    const marketIds = topMarkets.map((m) => m.marketId);
    const allPositions = await fetchAllPositions(marketIds);
    console.log(`\n📊 共抓取 ${allPositions.length} 個有借款的倉位\n`);
    // Step 4: 分類（過濾壞賬）— 只使用白名單市場
    const marketMap = new Map();
    for (const m of filteredMarkets)
        marketMap.set(m.marketId, m);
    const badDebt = []; // HF<1 且抵押品 <$100（壞賬，不可清算）
    const profitableLiquidations = []; // HF<1 且淨利潤>0（真正可清算）
    const unprofitableUnderwater = []; // HF<1 但淨利潤<=0（抵押品不足，清算會虧錢）
    const atRisk = []; // HF 1~1.05（接近清算）
    const safe = []; // HF > 1.05
    let skipped = 0; // 粉塵倉位
    for (const pos of allPositions) {
        const market = marketMap.get(pos.market?.marketId);
        if (!market)
            continue;
        const borrowUsd = Number(pos.state?.borrowAssetsUsd ?? 0);
        const collateralUsd = Number(pos.state?.collateralUsd ?? 0);
        const lltv = Number(market.lltv) / 1e18;
        // 跳過粉塵倉位
        if (borrowUsd < MIN_BORROW_USD && collateralUsd < MIN_COLLATERAL_USD) {
            skipped++;
            continue;
        }
        const hf = calcHealthFactor(borrowUsd, collateralUsd, lltv);
        const profit = estimateLiquidationProfit(borrowUsd, collateralUsd, lltv);
        const target = {
            marketId: pos.market?.marketId,
            user: pos.user?.address,
            borrowUsd,
            collateralUsd,
            lltv,
            hf,
            loanSymbol: market.loanAsset?.symbol ?? "?",
            collateralSymbol: market.collateralAsset?.symbol ?? "?",
            profit,
        };
        if (hf < 1 && collateralUsd < MIN_COLLATERAL_USD) {
            badDebt.push(target);
        }
        else if (hf < 1 && profit.profitable) {
            profitableLiquidations.push(target);
        }
        else if (hf < 1) {
            unprofitableUnderwater.push(target);
        }
        else if (hf < 1.05) {
            atRisk.push(target);
        }
        else {
            safe.push(target);
        }
    }
    // ─── 輸出結果 ───
    // 壞賬統計
    console.log("═".repeat(80));
    console.log(`⚫ 壞賬 (HF<1, 抵押品<$${MIN_COLLATERAL_USD}): ${badDebt.length} 個 — 不可清算，跳過`);
    console.log("═".repeat(80));
    const totalBadDebt = badDebt.reduce((s, t) => s + t.borrowUsd, 0);
    console.log(`  壞賬總借款: ${fmt$(totalBadDebt)}（這些是協議損失，不是你的利潤）\n`);
    // 真正可清算
    console.log("═".repeat(80));
    console.log(`🔴 可清算且有利可圖 (HF<1, 淨利潤>0): ${profitableLiquidations.length} 個`);
    console.log("═".repeat(80));
    profitableLiquidations.sort((a, b) => b.profit.netProfitUsd - a.profit.netProfitUsd);
    for (const t of profitableLiquidations.slice(0, 30)) {
        console.log(`  HF=${t.hf.toFixed(4)} | 借款=${fmt$(t.borrowUsd)} | 抵押=${fmt$(t.collateralUsd)} | ` +
            `可回收=${fmt$(t.profit.maxRepayUsd)} | 淨利潤=${fmt$(t.profit.netProfitUsd)} | ` +
            `${t.loanSymbol}/${t.collateralSymbol} (LLTV=${(t.lltv * 100).toFixed(1)}%) | ${t.user.slice(0, 12)}...`);
    }
    if (profitableLiquidations.length > 30)
        console.log(`  ... 還有 ${profitableLiquidations.length - 30} 個`);
    const totalProfitBorrow = profitableLiquidations.reduce((s, t) => s + t.borrowUsd, 0);
    const totalProfitEstimate = profitableLiquidations.reduce((s, t) => s + t.profit.netProfitUsd, 0);
    console.log(`\n  💰 可清算總借款: ${fmt$(totalProfitBorrow)}`);
    console.log(`  💵 預估淨利潤 (扣滑點+Gas): ${fmt$(totalProfitEstimate)}\n`);
    // 水下但无利润（坏账但抵押品 > $100）
    if (unprofitableUnderwater.length > 0) {
        console.log("═".repeat(80));
        console.log(`⚠️  水下但無利潤 (HF<1, 淨利潤<=0): ${unprofitableUnderwater.length} 個 — 清算會虧錢，跳過`);
        console.log("═".repeat(80));
        const totalUnrecovable = unprofitableUnderwater.reduce((s, t) => s + t.profit.unrecoverableDebtUsd, 0);
        console.log(`  無法回收債務: ${fmt$(totalUnrecovable)}\n`);
    }
    // 高風險（接近清算）
    console.log("═".repeat(80));
    console.log(`🟡 高風險 (HF 1~1.05): ${atRisk.length} 個 — 小幅波動即觸發清算`);
    console.log("═".repeat(80));
    atRisk.sort((a, b) => a.hf - b.hf);
    for (const t of atRisk.slice(0, 30)) {
        const distanceToLiq = ((t.hf - 1) * 100).toFixed(2);
        console.log(`  HF=${t.hf.toFixed(4)} (距清算 ${distanceToLiq}%) | 借款=${fmt$(t.borrowUsd)} | 抵押=${fmt$(t.collateralUsd)} | ` +
            `${t.loanSymbol}/${t.collateralSymbol} | ${t.user.slice(0, 12)}...`);
    }
    if (atRisk.length > 30)
        console.log(`  ... 還有 ${atRisk.length - 30} 個`);
    const totalAtRiskBorrow = atRisk.reduce((s, t) => s + t.borrowUsd, 0);
    console.log(`\n  💰 高風險總借款: ${fmt$(totalAtRiskBorrow)}\n`);
    // 總結
    console.log("═".repeat(80));
    console.log("📈 總結");
    console.log("═".repeat(80));
    console.log(`  Base 鏈 Morpho Blue 市場: ${allMarkets.length}`);
    if (useWhitelist) {
        console.log(`  白名單市場: ${filteredMarkets.length}`);
    }
    console.log(`  活躍市場 (借款>$100): ${activeMarkets.length}`);
    console.log(`  掃描的倉位: ${allPositions.length} (跳過粉塵 ${skipped})`);
    console.log(`  ⚫ 壞賬 (不可清算): ${badDebt.length} 個, ${fmt$(totalBadDebt)}`);
    console.log(`  🔴 可清算 (淨利潤>0): ${profitableLiquidations.length} 個, 借款 ${fmt$(totalProfitBorrow)}, 淨利潤 ${fmt$(totalProfitEstimate)}`);
    if (unprofitableUnderwater.length > 0) {
        const totalUnprofitable = unprofitableUnderwater.reduce((s, t) => s + t.borrowUsd, 0);
        console.log(`  ⚠️  水下無利潤: ${unprofitableUnderwater.length} 個, 借款 ${fmt$(totalUnprofitable)}`);
    }
    console.log(`  🟡 高風險 (HF 1~1.05): ${atRisk.length} 個, 借款 ${fmt$(totalAtRiskBorrow)}`);
    console.log(`  🟢 安全: ${safe.length} 個`);
}
main().catch((e) => {
    console.error("掃描失敗:", e);
    process.exit(1);
});
