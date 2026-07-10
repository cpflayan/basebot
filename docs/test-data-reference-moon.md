# Moonwell 測試數據參考

> Moonwell (Compound V2 fork) 清算測試的數據格式、計算公式與參考值。

---

## 1. Moonwell 核心計算公式

### 1.1 cToken 匯率（Exchange Rate）

```
exchangeRate = (totalCash + totalBorrows - totalReserves) / totalSupply
```

- `totalCash`：MToken 持有的 underlying 餘額
- `totalBorrows`：市場總借款（underlying 單位）
- `totalReserves`：協議儲備金
- `totalSupply`：cToken 總供應量

**cToken ↔ Underlying 轉換：**
```
underlyingAmount = cTokenAmount × exchangeRate / 1e18
```

> Compound V2 的 exchangeRate 初始值為 `0.02e18`（即 1 cToken = 0.02 underlying），隨利息累積逐漸增長。

### 1.2 帳戶流動性（Account Liquidity）

```
For each market with supply:
  collateralValue = cTokenBalance × exchangeRate / 1e18 × collateralFactor × oraclePrice

sumCollateral = Σ collateralValue
sumBorrow = Σ (borrowBalance × oraclePrice)

excess = sumCollateral - sumBorrow
  ├─ excess > 0 → 流動性充足，不可清算
  └─ excess < 0 → shortfall，可清算
```

### 1.3 清算計算

```
closeFactor = 0.5 (50%)
maxRepay = min(borrowBalance × closeFactor, availableBalance)

seizedCollateral = (repayAmount × liquidationIncentive × oraclePriceBorrow / oraclePriceCollateral) / exchangeRate
```

| 參數 | 值 | 說明 |
|------|------|------|
| closeFactor | 0.5 | 每次最多還 50% 債務 |
| liquidationIncentive | 1.08-1.10 | 清算人獲得 8-10% 額外 collateral |
| collateralFactor | 0.75-0.85 | 各市場不同 |

---

## 2. Moonwell Base 鏈市場參考數據

### 2.1 主要市場（已驗證 ✅, block 48400000）

| 市場 | MToken 地址 | Underlying | Decimals | exchangeRate |
|------|------------|------------|----------|-------------|
| mUSDC | `0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22` | USDC `0x833589fC...` | 6 | `2.296e14` |
| mWETH | `0x628ff693426583D9a7FB391E54366292F509D457` | WETH `0x420000...` | 18 | `2.073e26` |
| mcbBTC | `0xF877ACaFA28c19b96727966690b2f44d35aD5976` | cbBTC `0xcbB7C0...` | 8 | `2.007e16` |

**市場總數：21 個 MToken**（用 `getAllMarkets()` 查詢完整清單）

**鏈上數據（block 48400000 驗證）：**

| 項目 | mUSDC | mWETH | mcbBTC |
|------|-------|-------|--------|
| totalBorrows | ~13.89M USDC | ~3,928 WETH | ~19.47 cbBTC |
| exchangeRate | `2.296e14` | `2.073e26` | `2.007e16` |
| reserveFactor | 10% | — | — |

### 2.2 Comptroller 地址

```
Base 鏈 Comptroller: 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C
```

---

## 3. 測試數據設定

### 3.1 簡化測試數據（單元測試用）

```typescript
// 市場狀態
const marketState = {
  // mUSDC
  totalCash: 1_000_000n * 10n ** 6n,       // 1M USDC
  totalBorrows: 500_000n * 10n ** 6n,      // 500K USDC
  totalReserves: 10_000n * 10n ** 6n,      // 10K USDC
  totalSupply: 50_000_000n * 10n ** 8n,    // cToken supply (8 decimals)
  exchangeRate: 20_000_000_000_000_000n,   // 0.02e18 (初始值)
  collateralFactor: 770_000_000_000_000_000n, // 0.77e18
  borrowRatePerBlock: 100_000_000n,        // ~2% APY
  supplyRatePerBlock: 50_000_000n,         // ~1% APY
};

// Oracle 價格
const prices = {
  USDC: 1n * 10n ** 18n,          // $1
  WETH: 2500n * 10n ** 18n,       // $2500
  cbBTC: 62000n * 10n ** 18n,     // $62000
  wstETH: 2800n * 10n ** 18n,     // $2800
};

// 用戶倉位（健康）
const healthyPosition = {
  // Supply: 10 WETH as collateral
  mWETHBalance: 500n * 10n ** 8n,  // 500 mWETH
  exchangeRate: 20_000_000_000_000_000n, // 0.02e18
  // underlying = 500e8 × 0.02e18 / 1e18 = 10 WETH
  // collateralValue = 10 × $2500 × 0.825 = $20,625

  // Borrow: 5000 USDC
  mUSDCBorrow: 5000n * 10n ** 6n,  // 5000 USDC
  // borrowValue = 5000 × $1 = $5000

  // HF = $20,625 / $5000 = 4.125 ✅
};

// 用戶倉位（可清算）
const liquidatablePosition = {
  // Supply: 2 WETH
  mWETHBalance: 100n * 10n ** 8n,  // 100 mWETH
  exchangeRate: 20_000_000_000_000_000n,
  // underlying = 100e8 × 0.02e18 / 1e18 = 2 WETH
  // collateralValue = 2 × $2500 × 0.825 = $4,125

  // Borrow: 5000 USDC
  mUSDCBorrow: 5000n * 10n ** 6n,
  // borrowValue = $5000

  // HF = $4,125 / $5000 = 0.825 ❌ (shortfall = $875)
};
```

### 3.2 各測試場景數據

| # | 場景 | ETH Price | Supply (WETH) | Borrow (USDC) | HF | 可清算? |
|---|------|-----------|---------------|---------------|------|---------|
| 1 | 健康倉位 | $2500 | 10 WETH | 5000 | 4.125 | ❌ |
| 2 | 價格暴跌 | $1000 | 10 WETH | 5000 | 1.65 | ❌ |
| 3 | 價格暴跌+高槓桿 | $1000 | 2 WETH | 5000 | 0.33 | ✅ |
| 4 | 大量借款 | $2500 | 10 WETH | 20000 | 1.03 | ❌ |
| 5 | 利息累積後 | $2500 | 10 WETH | 21000 | 0.98 | ✅ |
| 6 | 極端暴跌 | $100 | 10 WETH | 5000 | 0.165 | ✅ |

### 3.3 清算利潤計算

```
場景 #3：ETH=$1000, Supply=2WETH, Borrow=5000USDC

maxRepay = 5000 × 0.5 = 2500 USDC
seizedWETH = 2500 × 1.08 × ($1/$1000) = 2.7 WETH (但最多 seize 全部 collateral)
實際 seized = min(2.7, 2) = 2 WETH

redeem 2 WETH → DEX swap → 得到 ~$2000 USDC
profit = $2000 - $2500 (repay) = -$500 ❌ 虧損

→ 此場景不值得清算（ collateral 不足覆蓋 repay）
```

```
場景 #5：ETH=$2500, Supply=10WETH, Borrow=21000USDC

maxRepay = 21000 × 0.5 = 10500 USDC
seizedWETH = 10500 × 1.08 × ($1/$2500) = 4.536 WETH

redeem 4.536 WETH → DEX swap → ~$11,340 USDC
profit = $11,340 - $10,500 (repay) - gas = ~$800 ✅
```

---

## 4. 真實鏈上數據查詢

### 4.1 查詢帳戶流動性

```bash
# getAccountLiquidity 返回 [error, shortfall, liquidity]
# shortfall > 0 → 可清算
cast call 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C \
  "getAccountLiquidity(address)(uint256,uint256,uint256)" \
  0x1234567890abcdef1234567890abcdef12345678 \
  --rpc-url http://127.0.0.1:8545

# 期望輸出（可清算）：
# 0  # error
# 875000000  # shortfall ($875 in 6-dec)
# 0  # liquidity
```

### 4.2 查詢市場數據

```bash
# 查詢 MToken 的 exchangeRate
cast call 0xedc817A28E8B93B03976DFd4a3ddBC9f7D176c22 \
  "exchangeRateStored()(uint256)" \
  --rpc-url http://127.0.0.1:8545

# 查詢 collateral factor
cast call 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C \
  "markets(address)(bool,uint256,uint256,bool)" \
  0xedc817A28E8B93B03976DFd4a3ddBC9f7D176c22 \
  --rpc-url http://127.0.0.1:8545

# 查詢 close factor
cast call 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C \
  "closeFactorMantissa()(uint256)" \
  --rpc-url http://127.0.0.1:8545

# 查詢 liquidation incentive
cast call 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C \
  "liquidationIncentiveMantissa()(uint256)" \
  --rpc-url http://127.0.0.1:8545
```

### 4.3 查詢用戶倉位

```bash
# cToken 餘額（supply side）
cast call <M_TOKEN> "balanceOf(address)(uint256)" \
  <USER> --rpc-url http://127.0.0.1:8545

# 借款餘額
cast call <M_TOKEN> "borrowBalanceStored(address)(uint256)" \
  <USER> --rpc-url http://127.0.0.1:8545

# 用戶在所有市場的 entry
# 需要遍歷 getAllMarkets() 逐一查詢
```

---

## 5. Compound V2 vs Morpho Blue 數據格式對比

| 項目 | Morpho Blue | Moonwell (Compound V2) |
|------|-------------|----------------------|
| 市場標識 | marketId (bytes32) | MToken address |
| 價格格式 | `USD × 10^(36-loanDec+collDec)` | `USD × 10^18` (Chainlink) |
| 借款單位 | borrowShares (trillions 級) | borrowBalance (underlying 單位) |
| 抵押品 | collateral (underlying 單位) | cToken balance (需 × exchangeRate) |
| 健康因子 | SDK 計算 | 協議 `getAccountLiquidity()` |
| 清算判定 | HF < 1 | shortfall > 0 |
| 清算限額 | 無限制 | closeFactor = 50% |
| 清算獎勵 | 協議參數 | liquidationIncentive (8-10%) |
| 利息累積 | 連續時間（lastUpdate） | 每區塊（borrowRatePerBlock） |

---

## 6. 測試檔案規劃

| 測試檔案 | 類型 | 說明 |
|----------|------|------|
| `moonwellLiquidation.test.ts` | Anvil fork | 端到端清算測試 |
| `moonwellAccountScan.test.ts` | 純記憶體 | 帳戶掃描 + 流動性計算 |
| `moonwellFlashLoan.test.ts` | Anvil fork | Flash loan 清算路徑 |
| `moonwellExchangeRate.test.ts` | 純記憶體 | cToken ↔ underlying 轉換 |

---

## 7. 上線前 TODO

- [ ] 驗證 Comptroller 地址和所有 MToken 地址
- [ ] 確認 closeFactor 和 liquidationIncentive 當前值
- [ ] 用真實鏈上數據測試 HF 計算
- [ ] 測試 `liquidateBorrow` 在 fork 上成功執行
- [ ] 驗證 flash loan → liquidateBorrow → redeem → swap 完整路徑
- [ ] 確認 close factor 限制（50%）下的利潤計算正確
- [ ] 測試多市場帳戶流動性計算
