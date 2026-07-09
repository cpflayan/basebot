# 測試數據記錄

> **✅ 真實數據測試已通過**
>
> `cacheLiquidation.realData.test.ts` 使用真實鏈上數據，驗證 SDK HF 與 Morpho API HF 一致。
> 原有的 `cacheLiquidation.test.ts` 使用簡化數據驗證邏輯路徑，仍然有效。

---

## 1. cacheLiquidation.test.ts — PositionCache 增量 HF 計算

### 1.1 市場狀態 (`makeMarketState`)

| 欄位 | 測試值 | 真實格式 | 說明 |
|------|--------|----------|------|
| `loanToken` | `0x833589fC...` (USDC Base) | ✅ 真實地址 | 6 decimals |
| `collateralToken` | `0xc1CBa3fC...` (wstETH Base) | ✅ 真實地址 | 18 decimals |
| `oracle` | `0x4E2b7B6c...` | ⚠️ 佔位地址 | 需替換為真實 oracle |
| `irm` | `0x46415998...` | ⚠️ 佔位地址 | 需替換為真實 IRM |
| `lltv` | `860000000000000000n` (86%) | ✅ 合理 | — |
| `totalSupplyAssets` | `1_000_000e6` | ⚠️ 簡化 | — |
| `totalSupplyShares` | `1_000_000e6` | ⚠️ 簡化 (1:1) | 真實 ratio 通常 ≠ 1:1 |
| `totalBorrowAssets` | `500_000e6` | ⚠️ 簡化 | — |
| `totalBorrowShares` | `500_000e6` | ⚠️ 簡化 (1:1) | **真實 tBA/tBS ratio ≈ 1e-6** |
| `lastUpdate` | `BigInt(now)` | ✅ 正確 | 避免利息累積 |
| `fee` | `10000000000000000n` (1%) | ✅ 合理 | — |
| `rateAtTarget` | `100000000000000000n` (0.1) | ✅ 合理 | — |
| `price` | `2500e18` | ❌ **錯誤格式** | 真實格式見下方說明 |

### 1.2 Oracle Price 格式問題

**測試用**：`price = 2500n * 10n ** 18n`（即 `2500e18`）

**真實格式**：
```
price = USD_price × 10^(36 - loanDecimals + collateralDecimals)
```

| 市場 | loan dec | coll dec | 真實 price 格式 |
|------|----------|----------|-----------------|
| WETH/USDC | 6 | 18 | `2500 × 10^(36-6+18) = 2500e30` |
| cbBTC/USDC | 6 | 8 | `62000 × 10^(36-6+8) = 62000e38` |
| cbETH/USDC | 6 | 18 | `3000 × 10^(36-6+18) = 3000e30` |

> SDK 計算：`collateralValue = collateral × price / 10^36`
>
> 真實 WETH/USDC：`2e18 × 2500e30 / 1e36 = 5000e12`（不是 `5000`）
>
> 但 HF 最終結果不受 scale 影響（wDivDown 內部會約掉），所以測試邏輯路徑仍然正確。

### 1.3 borrowShares 問題

**測試用**：`borrowShares = 4000n`（配合 1:1 ratio，borrowAssets ≈ 4000）

**真實情況**：
- `borrowShares` 是 share，不是 asset
- 真實 borrowShares 數量級為 **trillions**（如 `18,343,430,942,789,167,211,305,175`）
- `tBA/tBS ratio ≈ 1e-6`，所以 `borrowAssets = borrowShares × ratio ≈ 真實 USDC 數量`

> 測試的 1:1 ratio 是數學上的簡化，不反映真實市場行為。

### 1.4 各測試案例數據

| # | 測試場景 | price | collateral | borrowShares | 預期 HF |
|---|----------|-------|------------|--------------|---------|
| 1 | 價格暴跌 | $2500→$1800 | 2 wstETH | 4000 | 1.075→0.774 |
| 2 | Borrow 增加債務 | $2000 | 3 wstETH | 4500→5500 | 1.147→0.938 |
| 3 | WithdrawCollateral | $3000 | 5→4 wstETH | 2000 | 6.45→5.16 |
| 4 | Repay 降低債務 | $1800 | 2 wstETH | 3000→2000 | 1.032→1.548 |
| 5 | 無債務倉位 | $2500 | 10 wstETH | 0 | undefined |
| 6 | 市場不在緩存 | — | — | — | undefined |

---

## 2. 真實鏈上數據參考（Base chain, 2025-07）

以下為 Morpho GraphQL API 查詢的真實數據，供上線前對照：

### 市場範例（cbBTC-like, price/1e36 = 1.0）

```
price:          1000000000000000000000000000000000000 (1e36)
tBA:            270,480,916,032,313,045,056,298
tBS:            270,416,133,882,159,143,972,910,610,561
tBA/tBS ratio:  1.000240e-6
borrowShares:   18,343,430,942,789,167,211,305,175
collateral:     64,000,000,000,000,000,000 (64e18)
collateralValue: 64,000,000,000,000,000,000 (64e18)
borrowAssets:   18,348,353,643,469,721,591
HF (SDK):       2.999724 ✅ matches API HF
```

---

## 3. 真實數據測試（已通過 ✅）

### 3.1 cacheLiquidation.realData.test.ts

使用從 Morpho API + SDK `fetchMarket` 捕獲的真實 Base chain 數據：

| 測試案例 | SDK HF | API HF | 結果 |
|----------|--------|--------|------|
| Position 1 (cbBTC/USDC) | 1.999900 | 1.999901 | ✅ ratio=1.0000 |
| Position 2 (collateral/USDC) | 1.999863 | 1.999863 | ✅ ratio=1.0000 |
| collateralValue/borrowAssets 數量級 | 52,302,440,396 / 22,491,168,559 | — | ✅ 正確 |
| findAtRiskPositions 價格暴跌 60% | HF=0.8000 | — | ✅ 1 at-risk |

### 3.2 真實數據格式確認

| 項目 | 真實格式 | 測試驗證 |
|------|----------|----------|
| Oracle price | `USD × 10^(36-loanDec+collDec)` | ✅ cbBTC/USDC: `6.18e38` |
| borrowShares | shares (trillions 級別) | ✅ `20,270,729,142,383,993` |
| tBA/tBS ratio | ≈ 1e-6 | ✅ `1.23e15 / 1.11e21 ≈ 1.1e-6` |
| collateralValue | 與 borrowAssets 同尺度 | ✅ `52,302,440,396` (USDC 6-dec) |
| borrowAssets | USDC 6-dec 尺度 | ✅ `22,491,168,559` (≈22,491 USDC) |

### 3.3 結論

- SDK HF 計算與 Morpho API `health_factor` **完全一致**（誤差 < 0.0001%）
- HF 計算為 scale-invariant，簡化數據測試邏輯路徑仍然正確
- 真實數據測試確認 production bot 使用的所有數據格式正確

---

## 4. 上線前 TODO（剩餘）

- [x] ~~驗證 SDK HF 計算結果與 Morpho API `health_factor` 一致~~ ✅ 已通過
- [x] ~~加入一組「真實數據測試」~~ ✅ cacheLiquidation.realData.test.ts
- [x] ~~用真實 oracle price 格式更新 `cacheLiquidation.test.ts`~~ ✅ 已更新
- [x] ~~Webhook 端到端測試（Alchemy → bot `/webhook`）~~ ✅ 已驗證
  - Cloudflare Tunnel → Bot Webhook Server → 事件解碼 → Bot 觸發，全链路暢通
  - 測試事件：Borrow(bytes32,address,address,address,uint256,uint256)
  - Bot 正確識別事件、同步鏈上倉位、計算 HF 並判斷不觸發清算
- [ ] 實際清算交易測試（需要資金 + gas）

---

## 5. 其他測試檔案數據來源

| 測試檔案 | 數據來源 | 說明 |
|----------|----------|------|
| `liquidation.test.ts` | Anvil fork (mainnet) | 使用真實 mainnet 合約 + `setupPosition` 鏈上操作 |
| `flashLoanLiquidation.test.ts` | Anvil fork (Base, block 48M) | 使用真實 Base 合約 |
| `preLiquidation.test.ts` | Anvil fork (mainnet) | 使用真實 mainnet 合約 |
| `deployExecutor.test.ts` | Anvil fork | 部署測試 |
| `cacheLiquidation.test.ts` | **純記憶體模擬** | ✅ 使用真實數據格式（price 2500e30, tBA/tBS ratio 1e-6） |
| `cacheLiquidation.realData.test.ts` | **真實鏈上數據** | ✅ 使用 Morpho API 捕獲的真實 Base chain 數據 |
