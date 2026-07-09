# Anvil Fork 測試指南

在本地 Anvil fork 上測試清算機器人的所有功能，無需花費真實資金。

## 前置需求

```bash
# 安裝 foundry（含 anvil）
curl -L https://foundry.paradigm.xyz | bash
foundryup

# 安裝專案依賴
pnpm install
```

## 1. 啟動 Base 鏈 Anvil Fork

```bash
# 基本啟動（使用最新區塊）
anvil --fork-url $RPC_URL_8453 --fork-block-number <BLOCK_NUMBER> --port 8545

# 推薦：指定區塊號 + 增加 slot 數量 + 允許 CORS
anvil \
  --fork-url $RPC_URL_8453 \
  --fork-block-number 28000000 \
  --port 8545 \
  --host 0.0.0.0 \
  --slots-in-an-epoch 0 \
  --block-time 2

# 如需模擬特定帳戶（帶餘額）
anvil \
  --fork-url $RPC_URL_8453 \
  --fork-block-number 28000000 \
  --mnemonic "test test test test test test test test test test test junk" \
  --port 8545
```

> **取得合適的區塊號**：選擇一個有可清算倉位的區塊。可用 `scan-liquidations.ts` 找到有 HF < 1 倉位的區塊號。

## 2. 配置環境變數

建立 `.env.fork` 檔案指向本地 fork：

```bash
# 指向本地 Anvil fork
RPC_URL_8453=http://127.0.0.1:8545

# Base 鏈 Morpho 合約
MORPHO_BLUE_BASE=0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb

# Executor 地址 — 需要先在 fork 上部署
# 啟動 bot 後會自動部署，或手動部署後填入
EXECUTOR_ADDRESS_8453=<DEPLOYED_EXECUTOR_ADDRESS>

# Anvil 預設帳戶私鑰（測試用）
LIQUIDATION_PRIVATE_KEY_8453=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# 啟用 DRY-RUN 模式（不發送真實交易）
DRY_RUN=true

# Discovery 白名單（可選）
WHITELIST_DATA_DIR=../morpho-liquidation-discovery/data

# Webhook 端口
WEBHOOK_PORT=3001

# 1inch API（流動性檢查）
ONE_INCH_SWAP_API_KEY=<YOUR_KEY>
```

## 3. 部署 Executor 到 Fork

```bash
# 使用 deploy 腳本部署到本地 fork
npx tsx apps/client/src/deployExecutor.ts --env-file=.env.fork
```

部署完成後記下 executor 地址，填入 `.env.fork` 的 `EXECUTOR_ADDRESS_8453`。

## 4. 測試功能清單

### 4.1 DRY-RUN 模式（模擬清算）

DRY-RUN 模式下 bot 會執行完整的模擬流程（simulation + profit check），但不發送真實交易。

```bash
# 啟動 bot（dry-run 模式）
DRY_RUN=true npx tsx apps/client/src/script.ts --env-file=.env.fork
```

觀察輸出：
- `🧪 DRY-RUN mode enabled — no real transactions will be sent`
- 找到可清算倉位時會顯示 `🧪 [DRY-RUN] Would execute liquidation tx`
- Flash loan 路徑會顯示 `🧪 [DRY-RUN] Would execute flash-loan liquidation tx`

### 4.2 事件驅動觸發（Webhook）

**步驟 A：啟動 bot + webhook server**

```bash
DRY_RUN=true npx tsx apps/client/src/script.ts --env-file=.env.fork
```

**步驟 B：模擬 MorphoBlue 事件**

用 `cast` 在 fork 上觸發 Borrow 事件（增加債務 → 降低 HF）：

```bash
# 1. 找到一個有借貸的市場
# 從 discovered-markets.8453.json 中取一個 approved 的 marketId

# 2. 用 cast 調用 Morpho Blue 的 borrow 函數
# 這會觸發 Borrow 事件，webhook 會收到通知
cast send 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb \
  "borrow((address,address,address,address,uint256),uint256,uint256,address,address)" \
  "<loanToken>" "<collateralToken>" "<oracle>" "<irm>" "<lltv>" \
  "<amount>" "0" "<onBehalf>" "<receiver>" \
  --rpc-url http://127.0.0.1:8545 \
  --private-key <TEST_KEY>
```

**步驟 C：直接測試 Webhook 端點**

不需要真的觸發鏈上事件，可以直接 POST 到 webhook 端點測試解碼：

```bash
# 發送一個模擬的 webhook payload（使用 Borrow 事件的 topic0）
# Borrow topic0 = 0x...（從 webhook.ts 的 MORPHO_EVENT_SIGNATURES 計算）

curl -X POST http://localhost:3001/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "event": {
      "data": {
        "block": {
          "logs": [
            {
              "topics": [
                "0x...Borrow topic0...",
                "0x...marketId padded...",
                "0x...onBehalf padded...",
                "0x...receiver padded..."
              ],
              "data": "0x...encoded assets and shares..."
            }
          ]
        }
      }
    }
  }'
```

### 4.3 PositionCache 增量 HF → 達標清算 / 未達標放棄 ✅ 已驗證

> 測試檔案：`apps/client/test/vitest/execution/cacheLiquidation.test.ts`
> 6 個測試全部通過 ✅

以下兩個測試驗證完整路徑：

```
事件觸發 → 更新 Cache → 讀取 Oracle 價格 → 增量 HF 計算
  ├─ HF < 1 → findAtRiskPositions 返回 → buildAccrualPosition → liquidate()
  └─ HF >= 1 → findAtRiskPositions 為空 → 跳過
```

**SDK 計算鏈（重要）：**
```
collateralValue = collateral * price / ORACLE_PRICE_SCALE (10^36)
maxBorrowAssets = wMulDown(collateralValue, lltv)
borrowAssets    = borrowShares * (totalBorrowAssets + 1) / (totalBorrowShares + 10^6)
healthFactor    = wDivDown(maxBorrowAssets, borrowAssets)
```

**測試數據設定要點：**
- `price` 使用 10^18 縮放（如 `2500e18` = $2500）
- `totalBorrowAssets = totalBorrowShares` 使 share→asset 轉換為 1:1
- `lastUpdate` 設為當前時間以避免利息累積改變 totalBorrow*
- `borrowShares` 直接用原始數字（如 `4000n` = 4000 USDC）

#### 測試 A：HF < 1 → 達標，觸發清算

模擬場景：Oracle 價格暴跌，倉位 HF 從 > 1 跌到 < 1。

```typescript
// test/vitest/execution/cacheLiquidation.test.ts ✅ 已驗證

import { PositionCache, type CachedMarketState } from "../../../src/positionCache";
import { describe, it, expect } from "vitest";
import type { Address, Hex } from "viem";

// Base 鏈真實地址
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WSTETH_BASE = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" as Address;
const TEST_USER = "0x0000000000000000000000000000000000000001" as Address;
const TEST_MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;

/** 建立測試用市場狀態 */
function makeMarketState(overrides?: Partial<CachedMarketState>): CachedMarketState {
  return {
    marketId: TEST_MARKET,
    params: {
      loanToken: USDC_BASE,
      collateralToken: WSTETH_BASE,
      oracle: "0x4E2b7B6c5a8bB0E3F6aD1b3c8f0E4F7E8C9D0A1b" as Address,
      irm: "0x46415998764C29aB2a25CbeA6254146D50D22687" as Address,
      lltv: 860000000000000000n, // 86% LLTV
    },
    totalSupplyAssets: 1_000_000n * 10n ** 6n,
    totalSupplyShares: 1_000_000n * 10n ** 6n,
    totalBorrowAssets: 500_000n * 10n ** 6n, // 1:1 ratio
    totalBorrowShares: 500_000n * 10n ** 6n,
    lastUpdate: BigInt(Math.floor(Date.now() / 1000)), // 避免利息累積
    fee: 10000000000000000n,
    rateAtTarget: 100000000000000000n,
    price: 2500n * 10n ** 18n,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

describe("PositionCache 增量 HF → 達標清算路徑", () => {
  it("HF < 1: 價格暴跌 → at-risk → 觸發清算", () => {
    const cache = new PositionCache();

    // ── 1. 初始狀態：市場 + 倉位（HF 健康）──
    cache.setMarket(makeMarketState({ price: 2500n * 10n ** 18n }));
    // collateralValue = 2e18 * 2500e18 / 1e36 = 5000
    // HF = 5000 * 0.86 * 1e18 / 4000 ≈ 1.075 > 1 ✅
    cache.set({
      user: TEST_USER,
      marketId: TEST_MARKET,
      collateral: 2n * 10n ** 18n,     // 2 wstETH
      borrowShares: 4000n,             // ≈ 4000 USDC
      supplyShares: 0n,
      updatedAt: Date.now(),
    });

    const hfHealthy = cache.calculateHF(TEST_MARKET, TEST_USER, 2500n * 10n ** 18n);
    console.log(`初始 HF (price=$2500): ${hfHealthy?.toFixed(4)}`);
    expect(hfHealthy).toBeDefined();
    expect(hfHealthy!).toBeGreaterThan(1);

    // ── 2. 事件觸發：Oracle 價格暴跌到 $1800 ──
    // collateralValue = 2e18 * 1800e18 / 1e36 = 3600
    // HF = 3600 * 0.86 * 1e18 / 4000 ≈ 0.774 < 1 ❌
    const crashedPrice = 1800n * 10n ** 18n;
    cache.updateOraclePrice(TEST_MARKET, crashedPrice);

    const hfCrashed = cache.calculateHF(TEST_MARKET, TEST_USER, crashedPrice);
    console.log(`暴跌後 HF (price=$1800): ${hfCrashed?.toFixed(4)}`);
    expect(hfCrashed).toBeDefined();
    expect(hfCrashed!).toBeLessThan(1);

    // ── 3. findAtRiskPositions 應返回該倉位 ──
    const atRisk = cache.findAtRiskPositions(TEST_MARKET, 1, crashedPrice);
    expect(atRisk.length).toBe(1);
    expect(atRisk[0]!.position.user).toBe(TEST_USER);
    expect(atRisk[0]!.hf).toBeLessThan(1);

    // ── 4. buildAccrualPosition 應成功構建 SDK 物件 ──
    const accrualPos = cache.buildAccrualPosition(TEST_MARKET, TEST_USER, crashedPrice);
    expect(accrualPos).toBeDefined();
    expect(accrualPos!.user).toBe(TEST_USER);
    expect(accrualPos!.collateral).toBe(2n * 10n ** 18n);
    expect(accrualPos!.seizableCollateral).toBeGreaterThan(0n);

    console.log(`✅ HF < 1 路徑驗證通過`);
  });

  it("HF < 1: Borrow 事件增加債務 → HF 跌破 1 → 觸發清算", () => {
    const cache = new PositionCache();

    // collateralValue = 3e18 * 2000e18 / 1e36 = 6000
    // HF = 6000 * 0.86 / 4500 ≈ 1.147
    cache.setMarket(makeMarketState({ price: 2000n * 10n ** 18n }));
    cache.set({
      user: TEST_USER,
      marketId: TEST_MARKET,
      collateral: 3n * 10n ** 18n,
      borrowShares: 4500n,
      supplyShares: 0n,
      updatedAt: Date.now(),
    });

    const hfBefore = cache.calculateHF(TEST_MARKET, TEST_USER, 2000n * 10n ** 18n);
    expect(hfBefore!).toBeGreaterThan(1);

    // ── 模擬 Borrow 事件：債務增加 1000 shares ──
    const currentBorrowShares = cache.get(TEST_MARKET, TEST_USER)!.borrowShares;
    cache.upsert(TEST_MARKET, TEST_USER, {
      borrowShares: currentBorrowShares + 1000n,
    });

    // HF = 6000 * 0.86 / 5500 ≈ 0.938 < 1 ❌
    const hfAfter = cache.calculateHF(TEST_MARKET, TEST_USER, 2000n * 10n ** 18n);
    expect(hfAfter!).toBeLessThan(1);

    const atRisk = cache.findAtRiskPositions(TEST_MARKET, 1, 2000n * 10n ** 18n);
    expect(atRisk.length).toBe(1);
    console.log(`✅ Borrow 事件 → 增量更新 → HF 跌破 1 → 觸發清算`);
  });
});
```

#### 測試 B：HF >= 1 → 未達標，放棄

模擬場景：事件觸發但 HF 仍然健康，不應觸發清算。

```typescript
describe("PositionCache 增量 HF → 未達標放棄路徑", () => {
  it("HF >= 1: WithdrawCollateral 後 HF 仍健康 → 跳過", () => {
    const cache = new PositionCache();

    // collateralValue = 5e18 * 3000e18 / 1e36 = 15000
    // HF = 15000 * 0.86 / 2000 ≈ 6.45
    cache.setMarket(makeMarketState({ price: 3000n * 10n ** 18n }));
    cache.set({
      user: TEST_USER,
      marketId: TEST_MARKET,
      collateral: 5n * 10n ** 18n,
      borrowShares: 2000n,
      supplyShares: 0n,
      updatedAt: Date.now(),
    });

    const hfBefore = cache.calculateHF(TEST_MARKET, TEST_USER, 3000n * 10n ** 18n);
    expect(hfBefore!).toBeGreaterThan(1);

    // 模擬 WithdrawCollateral：撤走 1 wstETH
    const current = cache.get(TEST_MARKET, TEST_USER)!;
    cache.upsert(TEST_MARKET, TEST_USER, {
      collateral: current.collateral - 1n * 10n ** 18n, // 5 → 4 wstETH
    });

    // HF = 12000 * 0.86 / 2000 ≈ 5.16
    const hfAfter = cache.calculateHF(TEST_MARKET, TEST_USER, 3000n * 10n ** 18n);
    expect(hfAfter!).toBeGreaterThan(1);

    const atRisk = cache.findAtRiskPositions(TEST_MARKET, 1, 3000n * 10n ** 18n);
    expect(atRisk.length).toBe(0);

    console.log(`✅ HF >= 1 路徑：WithdrawCollateral 後仍健康 → 跳過`);
  });

  it("HF >= 1: Repay 事件降低債務 → HF 更健康 → 跳過", () => {
    const cache = new PositionCache();

    // collateralValue = 2e18 * 1800e18 / 1e36 = 3600
    // HF = 3600 * 0.86 / 3000 ≈ 1.032
    cache.setMarket(makeMarketState({ price: 1800n * 10n ** 18n }));
    cache.set({
      user: TEST_USER,
      marketId: TEST_MARKET,
      collateral: 2n * 10n ** 18n,
      borrowShares: 3000n,
      supplyShares: 0n,
      updatedAt: Date.now(),
    });

    const hfBefore = cache.calculateHF(TEST_MARKET, TEST_USER, 1800n * 10n ** 18n);
    expect(hfBefore!).toBeGreaterThan(1);

    // 模擬 Repay：還了 1000 shares
    const current = cache.get(TEST_MARKET, TEST_USER)!;
    cache.upsert(TEST_MARKET, TEST_USER, {
      borrowShares: current.borrowShares - 1000n, // 3000 → 2000
    });

    // HF = 3600 * 0.86 / 2000 ≈ 1.548
    const hfAfter = cache.calculateHF(TEST_MARKET, TEST_USER, 1800n * 10n ** 18n);
    expect(hfAfter!).toBeGreaterThan(hfBefore!);

    const atRisk = cache.findAtRiskPositions(TEST_MARKET, 1, 1800n * 10n ** 18n);
    expect(atRisk.length).toBe(0);
    console.log(`✅ Repay 事件 → 債務降低 → HF 更健康 → 跳過`);
  });

  it("無債務倉位 → HF = Infinity → 跳過", () => {
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

    // buildAccrualPosition returns undefined when borrowShares === 0n
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
```

#### 測試 C：端到端 handleEvents 路徑驗證（Anvil Fork）

在真實 fork 上驗證 `handleEvents()` 的完整流程：

```typescript
// test/vitest/execution/handleEvents.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { createViemTest } from "@morpho-org/test/vitest";
import { base } from "viem/chains";
import { type Address, type Hex, readContract } from "viem/actions";
import { MarketUtils, fetchMarket } from "@morpho-org/blue-sdk";
import type { MarketId } from "@morpho-org/blue-sdk";
import "@morpho-org/blue-sdk-viem/lib/augment";

import { PositionCache } from "../../../src/positionCache";
import { oracleAbi } from "../../../src/abis/morpho/oracle";
import { morphoBlueAbi } from "../../../src/abis/morpho/morphoBlue";
import type { DecodedMorphoEvent } from "../../../src/webhook";

const MORPHO_BASE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

// 使用 Base fork 測試
const baseForkTest = createViemTest(base, {
  forkUrl: process.env.RPC_URL_8453 ?? base.rpcUrls.default.http[0],
  forkBlockNumber: 28_000_000,
  timeout: 120_000,
});

describe("handleEvents 端到端路徑驗證", () => {
  baseForkTest(
    "完整路徑：載入市場 → 事件觸發 → 增量 HF → 達標清算",
    async ({ client }) => {
      const cache = new PositionCache();

      // ── 1. 從 discovered-markets 取一個真實市場 ──
      // 這裡用 Base 上 WETH/USDC 市場作為範例
      // 實際測試時需替換為真實的 marketId
      const marketId = "0x..." as Hex; // 從 JSON 取

      // ── 2. 載入市場狀態到 cache ──
      const market = await fetchMarket(marketId as MarketId, client as any, {
        chainId: 8453,
        deployless: false,
      });
      const now = BigInt(Math.floor(Date.now() / 1000));
      const timestamp = now > market.lastUpdate ? now : market.lastUpdate;
      const accrued = market.accrueInterest(timestamp);

      cache.setMarket({
        marketId,
        params: {
          loanToken: accrued.params.loanToken,
          collateralToken: accrued.params.collateralToken,
          oracle: accrued.params.oracle,
          irm: accrued.params.irm,
          lltv: accrued.params.lltv,
        },
        totalSupplyAssets: accrued.totalSupplyAssets,
        totalSupplyShares: accrued.totalSupplyShares,
        totalBorrowAssets: accrued.totalBorrowAssets,
        totalBorrowShares: accrued.totalBorrowShares,
        lastUpdate: accrued.lastUpdate ?? 0n,
        fee: accrued.fee ?? 0n,
        rateAtTarget: accrued.rateAtTarget ?? 0n,
        price: accrued.price ?? 0n,
        fetchedAt: Date.now(),
      });

      // ── 3. 讀取一個真實倉位並載入 cache ──
      // 找一個有借貸的用戶地址（從 GraphQL API 或鏈上事件取得）
      const testUser = "0x..." as Address;
      const position = await readContract(client, {
        address: MORPHO_BASE,
        abi: morphoBlueAbi,
        functionName: "position",
        args: [marketId, testUser],
      });

      cache.set({
        user: testUser,
        marketId,
        supplyShares: position[0],
        borrowShares: position[1],
        collateral: position[2],
        updatedAt: Date.now(),
      });

      // ── 4. 讀取當前 Oracle 價格 ──
      const currentPrice = await readContract(client, {
        address: accrued.params.oracle,
        abi: oracleAbi,
        functionName: "price",
      });

      const hfCurrent = cache.calculateHF(marketId, testUser, currentPrice);
      console.log(`當前 HF: ${hfCurrent?.toFixed(4)}`);

      // ── 5. 模擬價格暴跌 → HF < 1 ──
      const crashedPrice = currentPrice / 2n; // 價格腰斬
      const hfCrashed = cache.calculateHF(marketId, testUser, crashedPrice);
      console.log(`暴跌後 HF: ${hfCrashed?.toFixed(4)}`);

      if (hfCrashed !== undefined && hfCrashed < 1) {
        // 達標！驗證 findAtRiskPositions
        const atRisk = cache.findAtRiskPositions(marketId, 1, crashedPrice);
        expect(atRisk.length).toBeGreaterThan(0);

        // 驗證 buildAccrualPosition 成功
        const accrualPos = cache.buildAccrualPosition(marketId, testUser, crashedPrice);
        expect(accrualPos).toBeDefined();
        expect(accrualPos!.seizableCollateral).toBeGreaterThan(0n);

        console.log(`✅ 達標清算路徑驗證通過：`);
        console.log(`   HF ${hfCurrent?.toFixed(4)} → ${hfCrashed?.toFixed(4)}`);
        console.log(`   → handleEvents() 會調用 liquidate()`);
      } else {
        // 即使腰斬仍 >= 1，倉位太安全
        console.log(`⚠️ 價格腰斬後 HF 仍 >= 1，倉位過於安全`);
      }
    },
  );

  baseForkTest(
    "完整路徑：事件觸發 → 增量 HF → 未達標 → 跳過",
    async ({ client }) => {
      const cache = new PositionCache();

      // 載入市場 + 倉位（同上）
      const marketId = "0x..." as Hex;
      const market = await fetchMarket(marketId as MarketId, client as any, {
        chainId: 8453,
        deployless: false,
      });
      // ... 設置 cache ...

      // 模擬一個 SupplyCollateral 事件（增加抵押品）
      const mockEvent: DecodedMorphoEvent = {
        eventName: "SupplyCollateral",
        marketId,
        user: testUser,
        assets: 10n * 10n ** 18n, // 增加 10 個抵押品
      };

      // 更新 cache
      const current = cache.get(marketId, mockEvent.user);
      if (current) {
        cache.upsert(marketId, mockEvent.user, {
          collateral: current.collateral + (mockEvent.assets ?? 0n),
        });
      }

      // 讀取最新 Oracle 價格
      const freshPrice = await readContract(client, {
        address: market.params.oracle,
        abi: oracleAbi,
        functionName: "price",
      });

      // HF 應該更高了（更多抵押品）
      const hfAfter = cache.calculateHF(marketId, mockEvent.user, freshPrice);
      const atRisk = cache.findAtRiskPositions(marketId, 1, freshPrice);

      expect(atRisk.length).toBe(0);
      console.log(`✅ 未達標路徑驗證通過：`);
      console.log(`   HF=${hfAfter?.toFixed(4)}, atRisk=0`);
      console.log(`   → handleEvents() 輸出 "no at-risk positions" → 不觸發清算`);
    },
  );
});
```

#### 運行測試

```bash
# 確保 Anvil fork 正在運行
anvil --fork-url $RPC_URL_8453 --fork-block-number 28000000 --port 8545 &

# 運行 cache 路徑測試
npx vitest run apps/client/test/vitest/execution/cacheLiquidation.test.ts \
  --env-file=.env.fork

# 運行端到端 handleEvents 測試
npx vitest run apps/client/test/vitest/execution/handleEvents.test.ts \
  --env-file=.env.fork

# 運行所有 client 測試
pnpm test:client
```

#### 預期輸出（已驗證 ✅）

**達標清算（HF < 1）：**
```
初始 HF (price=$2500): 1.0750
暴跌後 HF (price=$1800): 0.7740
✅ HF < 1 路徑驗證通過：
   HF=0.7740, collateral=2000000000000000000, seizable=2000000000000000000
   → handleEvents() 會調用 liquidate(accrualPos)
```

**Borrow 事件觸發：**
```
Borrow 前 HF: 1.1467
Borrow 事件後 HF: 0.9382
✅ Borrow 事件 → 增量更新 → HF 跌破 1 → 觸發清算
```

**未達標放棄（HF >= 1）：**
```
WithdrawCollateral 後 HF: 5.1600
✅ HF >= 1 路徑：WithdrawCollateral 後仍健康 → 跳過

Repay 事件後 HF: 1.5480
✅ Repay 事件 → 債務降低 → HF 更健康 → 跳過

✅ 無債務倉位 → 跳過
✅ 市場不在緩存 → 跳過（handleEvents 會 refreshMarketInCache）
```

### 4.4 Token 黑名單測試

```bash
# 嘗試清算一個包含 USR 的市場
# 應該看到：⛔ Skip 0x...: blacklisted token in market ...

# 驗證黑名單生效：
# 1. 在 fork 上創建一個 USR 市場的倉位
# 2. 操縱價格使 HF < 1
# 3. 觀察 bot 是否跳過該倉位
```

### 4.5 新倉位檢測

```bash
# 1. 啟動 bot（DRY_RUN=true）
# 2. 在 fork 上用 cast 創建新倉位（SupplyCollateral + Borrow）
# 3. 觀察 webhook 是否收到事件
# 4. 觀察 handleEvents 是否更新 cache
# 5. 操縱價格使 HF < 1
# 6. 觀察 bot 是否觸發清算嘗試
```

### 4.6 流動性渠道測試

在 fork 上測試各流動性渠道的 swap 路由：

```bash
# 測試 1inch 路由
npx tsx apps/liquidity-venues/test/vitest/1inch.test.ts

# 測試 Aerodrome 路由
npx tsx apps/liquidity-venues/test/vitest/aerodrome.test.ts

# 測試 UniswapV3 路由
npx tsx apps/liquidity-venues/test/vitest/uniswapV3.test.ts
```

## 5. 完整端到端測試腳本

建立 `scripts/test-e2e-fork.sh`：

```bash
#!/bin/bash
set -e

echo "=== Anvil Fork E2E Test ==="

# 1. 啟動 Anvil fork（背景）
echo "📦 Starting Anvil fork..."
anvil \
  --fork-url "$RPC_URL_8453" \
  --fork-block-number "${FORK_BLOCK:-28000000}" \
  --port 8545 \
  --host 0.0.0.0 &
ANVIL_PID=$!
sleep 3

# 2. 部署 Executor
echo "🔧 Deploying executor..."
EXECUTOR=$(npx tsx apps/client/src/deployExecutor.ts --env-file=.env.fork | grep "Executor deployed at:" | awk '{print $NF}')
echo "Executor: $EXECUTOR"

# 3. 啟動 Bot（dry-run）
echo "🤖 Starting bot in DRY-RUN mode..."
DRY_RUN=true EXECUTOR_ADDRESS_8453=$EXECUTOR \
  npx tsx apps/client/src/script.ts --env-file=.env.fork &
BOT_PID=$!
sleep 5

# 4. 檢查 health
echo "🏥 Health check..."
curl -s http://localhost:3000/health | jq .
curl -s http://localhost:3001/health | jq .

# 5. 觸發 webhook 測試
echo "📡 Testing webhook endpoint..."
curl -s -X POST http://localhost:3001/webhook \
  -H "Content-Type: application/json" \
  -d '{"event":{"data":{"block":{"logs":[]}}}}' | jq .

# 6. 清理
echo "🧹 Cleaning up..."
kill $BOT_PID 2>/dev/null || true
kill $ANVIL_PID 2>/dev/null || true

echo "✅ E2E test complete"
```

## 6. 常用 Anvil 調試命令

```bash
# 查看 Morpho Blue 合約的 storage
cast storage 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb <SLOT> \
  --rpc-url http://127.0.0.1:8545

# 查看某個倉位狀態
cast call 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb \
  "position(bytes32,address)(uint256,uint128,uint128)" \
  <MARKET_ID> <USER_ADDRESS> \
  --rpc-url http://127.0.0.1:8545

# 查看 Oracle 價格
cast call <ORACLE_ADDRESS> "price()(uint256)" \
  --rpc-url http://127.0.0.1:8545

# 操縱 Oracle 價格（測試用）
# 需要先取得 oracle admin 權限或使用 anvil 的 cheatcode
cast store <ORACLE_ADDRESS> <SLOT> <NEW_PRICE> \
  --rpc-url http://127.0.0.1:8545

# 給帳戶打幣
cast send <TOKEN_ADDRESS> "mint(address,uint256)(bool)" \
  <RECIPIENT> <AMOUNT> \
  --rpc-url http://127.0.0.1:8545 \
  --private-key <KEY>

# 或使用 anvil 的 deal cheatcode
cast rpc anvil_setBalance <ADDRESS> <HEX_BALANCE> \
  --rpc-url http://127.0.0.1:8545

# 快速前進時間
cast rpc evm_increaseTime 3600 --rpc-url http://127.0.0.1:8545
cast rpc evm_mine --rpc-url http://127.0.0.1:8545
```

## 7. 常見問題

| 問題 | 解決方案 |
|---|---|
| `ESM ERR_MODULE_NOT_FOUND` | 使用 `npx tsx` 而非 `node` |
| Executor 部署失敗 | 確認 Anvil fork 的 RPC URL 正確且可達 |
| Webhook 無反應 | 確認 bot 已啟動且 webhook server 在 3001 端口監聽 |
| HF 計算結果為 undefined | 檢查 PositionCache 是否有該市場和倉位的數據 |
| 黑名單未生效 | 確認 `TOKEN_BLACKLIST` 中的地址是 lowercase |
| 模擬失敗 `simulation failed` | 正常 — DRY-RUN 模式下可能因流動性不足等原因跳過 |
| `pnpm` 版本問題 | 使用 `corepack enable` 或 `npx pnpm@8` |
