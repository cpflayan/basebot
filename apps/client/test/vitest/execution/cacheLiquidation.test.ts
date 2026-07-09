/**
 * PositionCache 增量 HF 計算路徑驗證
 *
 * 驗證兩條核心路徑：
 *   A. HF < 1 → findAtRiskPositions 返回 → buildAccrualPosition → liquidate()
 *   B. HF >= 1 → findAtRiskPositions 為空 → 跳過
 *
 * 使用真實數據格式：
 * - Oracle price: USD × 10^(36 - loanDecimals + collateralDecimals)
 *   WETH/USDC: $2500 → 2500e30
 * - tBA/tBS ratio ≈ 1e-6（真實市場 tBS >> tBA）
 * - borrowShares 配合 ratio 使 borrowAssets ≈ 合理 USDC 數量
 *
 * SDK 計算鏈：
 *   collateralValue = collateral * price / ORACLE_PRICE_SCALE (10^36)
 *   maxBorrowAssets = wMulDown(collateralValue, lltv)
 *   borrowAssets     = borrowShares * (totalBorrowAssets + 1) / (totalBorrowShares + 10^6)
 *   healthFactor     = wDivDown(maxBorrowAssets, borrowAssets)
 */

import type { Address, Hex } from "viem";
import { describe, it, expect } from "vitest";

import { PositionCache, type CachedMarketState } from "../../../src/positionCache.js";

// ── Test constants ──

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WSTETH_BASE = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" as Address;
const TEST_USER = "0x0000000000000000000000000000000000000001" as Address;
const TEST_MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;

/**
 * 建立測試用市場狀態。
 *
 * 真實格式：
 * - price = USD_price × 10^(36 - loanDecimals + collateralDecimals)
 *   WETH/USDC: 2500 × 10^(36-6+18) = 2500e30
 *   SDK 計算 collateralValue = collateral * price / 10^36
 *   2e18 * 2500e30 / 1e36 = 5000e12（= 5000 USDC，6 decimals）
 *
 * - tBA/tBS ratio ≈ 1e-6（真實市場 tBS >> tBA）
 *   tBA = 500e6, tBS = 500e12 → ratio = 1e-6
 *   borrowShares = 4000e18 → borrowAssets = 4000e18 × 1e-6 = 4000e12（= 4000 USDC）
 *
 * - lastUpdate 設為當前時間以避免利息累積改變 totalBorrow*
 *
 * HF 公式：
 *   HF = (collateral * price / 1e36) * lltv * 1e18 / borrowAssets
 *      = collateralValue * lltv * 1e18 / borrowAssets
 */
function makeMarketState(overrides?: Partial<CachedMarketState>): CachedMarketState {
  return {
    marketId: TEST_MARKET,
    params: {
      loanToken: USDC_BASE,
      collateralToken: WSTETH_BASE,
      oracle: "0x4E2b7B6c5a8bB0E3F6aD1b3c8f0E4F7E8C9D0A1b",
      irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
      lltv: 860000000000000000n, // 86% LLTV
    },
    totalSupplyAssets: 1_000_000n * 10n ** 6n,
    totalSupplyShares: 1_000_000n * 10n ** 6n,
    // 真實 tBA/tBS ratio ≈ 1e-6（tBS >> tBA）
    totalBorrowAssets: 500n * 10n ** 6n, // 500 USDC (6 dec)
    totalBorrowShares: 500n * 10n ** 12n, // ratio = 1e-6
    // 設為當前時間 → elapsed = 0 → 不累積利息
    lastUpdate: BigInt(Math.floor(Date.now() / 1000)),
    fee: 10000000000000000n, // 1%
    rateAtTarget: 100000000000000000n, // 0.1
    price: 2500n * 10n ** 30n, // WETH/USDC 真實格式：$2500 × 10^30
    fetchedAt: Date.now(),
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────
// 測試 A：HF < 1 → 達標，觸發清算
// ────────────────────────────────────────────────────────────

describe("PositionCache 增量 HF → 達標清算路徑", () => {
  it("HF < 1: 價格暴跌 → at-risk → 觸發清算", () => {
    const cache = new PositionCache();

    // 1. 初始狀態：市場 + 倉位（HF 健康）
    // price = $2500 (2500e30), collateral = 2 wstETH, borrowShares = 4000e12
    // collateralValue = 2e18 * 2500e30 / 1e36 = 5000e12（= 5000 USDC）
    // borrowAssets = 4000e12 * (500000e6+1)/(500000e12+1e6) ≈ 4000e6
    // HF = 5000e12 * 0.86 * 1e18 / 4000e6 ≈ 1.075e18 → 1.075 > 1 ✅
    cache.setMarket(makeMarketState({ price: 2500n * 10n ** 30n }));
    cache.set({
      user: TEST_USER,
      marketId: TEST_MARKET,
      collateral: 2n * 10n ** 18n, // 2 wstETH
      borrowShares: 4000n * 10n ** 18n, // ≈ 4000 USDC (配合 1e-6 ratio)
      supplyShares: 0n,
      updatedAt: Date.now(),
    });

    const hfHealthy = cache.calculateHF(TEST_MARKET, TEST_USER, 2500n * 10n ** 30n);
    console.log(`初始 HF (price=$2500): ${hfHealthy?.toFixed(4)}`);
    expect(hfHealthy).toBeDefined();
    expect(hfHealthy!).toBeGreaterThan(1);

    // 2. 事件觸發：Oracle 價格暴跌到 $1800
    // collateralValue = 2e18 * 1800e30 / 1e36 = 3600e12（= 3600 USDC）
    // HF = 3600e12 * 0.86 * 1e18 / 4000e6 ≈ 0.774e18 → 0.774 < 1 ❌
    const crashedPrice = 1800n * 10n ** 30n;
    cache.updateOraclePrice(TEST_MARKET, crashedPrice);

    const hfCrashed = cache.calculateHF(TEST_MARKET, TEST_USER, crashedPrice);
    console.log(`暴跌後 HF (price=$1800): ${hfCrashed?.toFixed(4)}`);
    expect(hfCrashed).toBeDefined();
    expect(hfCrashed!).toBeLessThan(1);

    // 3. findAtRiskPositions 應返回該倉位
    const atRisk = cache.findAtRiskPositions(TEST_MARKET, 1, crashedPrice);
    console.log(`At-risk positions: ${atRisk.length}`);
    expect(atRisk.length).toBe(1);
    expect(atRisk[0]!.position.user).toBe(TEST_USER);
    expect(atRisk[0]!.hf).toBeLessThan(1);

    // 4. buildAccrualPosition 應成功構建 SDK 物件
    const accrualPos = cache.buildAccrualPosition(TEST_MARKET, TEST_USER, crashedPrice);
    expect(accrualPos).toBeDefined();
    expect(accrualPos!.user).toBe(TEST_USER);
    expect(accrualPos!.collateral).toBe(2n * 10n ** 18n);
    expect(accrualPos!.borrowShares).toBe(4000n * 10n ** 18n);
    expect(accrualPos!.seizableCollateral).toBeDefined();
    expect(accrualPos!.seizableCollateral).toBeGreaterThan(0n);

    console.log(`✅ HF < 1 路徑驗證通過：`);
    console.log(
      `   HF=${hfCrashed?.toFixed(4)}, collateral=${accrualPos!.collateral}, seizable=${accrualPos!.seizableCollateral}`,
    );
    console.log(`   → handleEvents() 會調用 liquidate(accrualPos)`);
  });

  it("HF < 1: Borrow 事件增加債務 → HF 跌破 1 → 觸發清算", () => {
    const cache = new PositionCache();

    // 初始：HF 剛好 > 1
    // collateralValue = 3e18 * 2000e30 / 1e36 = 6000e12（= 6000 USDC）
    // HF = 6000e12 * 0.86 * 1e18 / 4500e6 ≈ 1.147
    cache.setMarket(makeMarketState({ price: 2000n * 10n ** 30n }));
    cache.set({
      user: TEST_USER,
      marketId: TEST_MARKET,
      collateral: 3n * 10n ** 18n, // 3 wstETH
      borrowShares: 4500n * 10n ** 18n, // ≈ 4500 USDC (配合 1e-6 ratio)
      supplyShares: 0n,
      updatedAt: Date.now(),
    });

    const hfBefore = cache.calculateHF(TEST_MARKET, TEST_USER, 2000n * 10n ** 30n);
    console.log(`Borrow 前 HF: ${hfBefore?.toFixed(4)}`);
    expect(hfBefore!).toBeGreaterThan(1);

    // 模擬 Borrow 事件：債務增加 1000e12 shares
    const currentBorrowShares = cache.get(TEST_MARKET, TEST_USER)!.borrowShares;
    cache.upsert(TEST_MARKET, TEST_USER, {
      borrowShares: currentBorrowShares + 1000n * 10n ** 18n,
    });

    // 增量重算：borrowShares 從 4500e12 → 5500e12
    // HF = 6000e12 * 0.86 * 1e18 / 5500e6 ≈ 0.938 < 1 ❌
    const hfAfter = cache.calculateHF(TEST_MARKET, TEST_USER, 2000n * 10n ** 30n);
    console.log(`Borrow 事件後 HF: ${hfAfter?.toFixed(4)}`);
    expect(hfAfter!).toBeLessThan(1);

    const atRisk = cache.findAtRiskPositions(TEST_MARKET, 1, 2000n * 10n ** 30n);
    expect(atRisk.length).toBe(1);

    // 驗證 buildAccrualPosition 可構建完整物件
    const accrualPos = cache.buildAccrualPosition(TEST_MARKET, TEST_USER, 2000n * 10n ** 30n);
    expect(accrualPos).toBeDefined();
    expect(accrualPos!.borrowShares).toBe(5500n * 10n ** 18n);
    expect(accrualPos!.seizableCollateral).toBeGreaterThan(0n);

    console.log(`✅ Borrow 事件 → 增量更新 → HF 跌破 1 → 觸發清算`);
  });
});

// ────────────────────────────────────────────────────────────
// 測試 B：HF >= 1 → 未達標，放棄
// ────────────────────────────────────────────────────────────

describe("PositionCache 增量 HF → 未達標放棄路徑", () => {
  it("HF >= 1: WithdrawCollateral 後 HF 仍健康 → 跳過", () => {
    const cache = new PositionCache();

    // collateralValue = 5e18 * 3000e30 / 1e36 = 15000e12（= 15000 USDC）
    // HF = 15000e12 * 0.86 * 1e18 / 2000e6 ≈ 6.45
    cache.setMarket(makeMarketState({ price: 3000n * 10n ** 30n }));
    cache.set({
      user: TEST_USER,
      marketId: TEST_MARKET,
      collateral: 5n * 10n ** 18n, // 5 wstETH
      borrowShares: 2000n * 10n ** 18n, // ≈ 2000 USDC (配合 1e-6 ratio)
      supplyShares: 0n,
      updatedAt: Date.now(),
    });

    const hfBefore = cache.calculateHF(TEST_MARKET, TEST_USER, 3000n * 10n ** 30n);
    expect(hfBefore!).toBeGreaterThan(1);

    // 模擬 WithdrawCollateral：撤走 1 wstETH
    const current = cache.get(TEST_MARKET, TEST_USER)!;
    cache.upsert(TEST_MARKET, TEST_USER, {
      collateral: current.collateral - 1n * 10n ** 18n, // 5 → 4 wstETH
    });

    // collateralValue = 4e18 * 3000e30 / 1e36 = 12000e12（= 12000 USDC）
    // HF = 12000e12 * 0.86 * 1e18 / 2000e6 ≈ 5.16
    const hfAfter = cache.calculateHF(TEST_MARKET, TEST_USER, 3000n * 10n ** 30n);
    console.log(`WithdrawCollateral 後 HF: ${hfAfter?.toFixed(4)}`);
    expect(hfAfter!).toBeGreaterThan(1);

    const atRisk = cache.findAtRiskPositions(TEST_MARKET, 1, 3000n * 10n ** 30n);
    expect(atRisk.length).toBe(0);

    console.log(`✅ HF >= 1 路徑：WithdrawCollateral 後仍健康 → 跳過`);
  });

  it("HF >= 1: Repay 事件降低債務 → HF 更健康 → 跳過", () => {
    const cache = new PositionCache();

    // collateralValue = 2e18 * 1800e30 / 1e36 = 3600e12（= 3600 USDC）
    // HF = 3600e12 * 0.86 * 1e18 / 3000e6 ≈ 1.032
    cache.setMarket(makeMarketState({ price: 1800n * 10n ** 30n }));
    cache.set({
      user: TEST_USER,
      marketId: TEST_MARKET,
      collateral: 2n * 10n ** 18n, // 2 wstETH
      borrowShares: 3000n * 10n ** 18n, // ≈ 3000 USDC (配合 1e-6 ratio)
      supplyShares: 0n,
      updatedAt: Date.now(),
    });

    const hfBefore = cache.calculateHF(TEST_MARKET, TEST_USER, 1800n * 10n ** 30n);
    expect(hfBefore!).toBeGreaterThan(1);

    // 模擬 Repay：還了 1000e12 shares
    const current = cache.get(TEST_MARKET, TEST_USER)!;
    cache.upsert(TEST_MARKET, TEST_USER, {
      borrowShares: current.borrowShares - 1000n * 10n ** 18n, // 3000e18 → 2000e18
    });

    // HF = 3600e12 * 0.86 * 1e18 / 2000e6 ≈ 1.548
    const hfAfter = cache.calculateHF(TEST_MARKET, TEST_USER, 1800n * 10n ** 30n);
    console.log(`Repay 事件後 HF: ${hfAfter?.toFixed(4)}`);
    expect(hfAfter!).toBeGreaterThan(hfBefore!);

    const atRisk = cache.findAtRiskPositions(TEST_MARKET, 1, 1800n * 10n ** 30n);
    expect(atRisk.length).toBe(0);

    console.log(`✅ Repay 事件 → 債務降低 → HF 更健康 → 跳過`);
  });

  it("無債務倉位 → buildAccrualPosition 返回 undefined → 跳過", () => {
    const cache = new PositionCache();
    cache.setMarket(makeMarketState());
    cache.set({
      user: TEST_USER,
      marketId: TEST_MARKET,
      collateral: 10n * 10n ** 18n,
      borrowShares: 0n, // 無債務
      supplyShares: 0n,
      updatedAt: Date.now(),
    });

    // buildAccrualPosition 在 borrowShares === 0n 時返回 undefined
    const accrualPos = cache.buildAccrualPosition(TEST_MARKET, TEST_USER);
    expect(accrualPos).toBeUndefined();

    const hf = cache.calculateHF(TEST_MARKET, TEST_USER);
    expect(hf).toBeUndefined();

    const atRisk = cache.findAtRiskPositions(TEST_MARKET, 1);
    expect(atRisk.length).toBe(0);

    console.log(`✅ 無債務倉位 → 跳過`);
  });

  it("市場不在緩存 → HF undefined → 跳過", () => {
    const cache = new PositionCache();
    // 不設置任何市場

    const hf = cache.calculateHF(TEST_MARKET, TEST_USER);
    expect(hf).toBeUndefined();

    const atRisk = cache.findAtRiskPositions(TEST_MARKET, 1);
    expect(atRisk.length).toBe(0);

    console.log(`✅ 市場不在緩存 → 跳過（handleEvents 會 refreshMarketInCache）`);
  });
});
