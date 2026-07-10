# Moonwell Anvil Fork 測試指南

在本地 Anvil fork 上測試 Moonwell (Compound V2) 清算機器人，無需真實資金。

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
# 推薦配置
anvil \
  --fork-url $RPC_URL_8453 \
  --fork-block-number 48000000 \
  --port 8545 \
  --host 0.0.0.0 \
  --slots-in-an-epoch 0 \
  --block-time 2
```

> **取得合適區塊號**：選擇有 Moonwell 可清算倉位的區塊。可用 `cast` 查詢 `getAccountLiquidity` 找到 shortfall > 0 的帳戶。

## 2. 配置環境變數

建立 `.env.fork` 檔案：

```bash
# 指向本地 Anvil fork
RPC_URL_8453=http://127.0.0.1:8545

# Moonwell Comptroller（Base 鏈）
COMPTROLLER_ADDRESS=0xfBb21d0380beE3312B33c4353c8936a0F13EF26C

# Executor 地址 — 需先在 fork 上部署
EXECUTOR_ADDRESS_8453=<DEPLOYED_EXECUTOR_ADDRESS>

# Anvil 預設帳戶私鑰（測試用）
LIQUIDATION_PRIVATE_KEY_8453=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# DRY-RUN 模式
DRY_RUN=true

# 1inch API
ONE_INCH_SWAP_API_KEY=<YOUR_KEY>
```

## 3. Moonwell Base 鏈關鍵合約（已驗證 ✅）

| 合約 | 地址 | 驗證 |
|------|------|------|
| Comptroller | `0xfBb21d0380beE3312B33c4353c8936a0F13EF26C` | ✅ |
| mUSDC | `0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22` | ✅ USDC underlying |
| mWETH | `0x628ff693426583D9a7FB391E54366292F509D457` | ✅ WETH underlying |
| mcbBTC | `0xF877ACaFA28c19b96727966690b2f44d35aD5976` | ✅ cbBTC underlying |
| WELL Token | `0xA88594D40446637d6e32EE3422effc22d222f1d1` | — |

**Comptroller 參數（已驗證）：**

| 參數 | 值 |
|------|------|
| closeFactorMantissa | `5e17` (50%) |
| liquidationIncentiveMantissa | `1.1e18` (10% 清算獎勵) |
| 市場總數 | 21 個 MToken |

**mUSDC 鏈上數據（已驗證）：**

| 項目 | 值 |
|------|------|
| underlying | `0x833589fC...` (USDC) |
| exchangeRateStored | `2.296e14` |
| totalBorrows | ~13.88M USDC |
| totalSupply | ~72.6M mUSDC |
| totalReserves | ~9,036 USDC |
| reserveFactorMantissa | `1e17` (10%) |

## 4. 測試功能清單

### 4.1 DRY-RUN 模式

```bash
DRY_RUN=true npx tsx apps/client/src/script.ts --env-file=.env.fork
```

觀察輸出：
- `🧪 DRY-RUN mode enabled`
- 找到可清算帳戶時顯示 `🧪 [DRY-RUN] Would execute liquidation tx`

### 4.2 鏈上清算能力查詢

```bash
# 查詢帳戶流動性（shortfall > 0 代表可清算）
cast call 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C \
  "getAccountLiquidity(address)(uint256,uint256,uint256)" \
  <ACCOUNT_ADDRESS> \
  --rpc-url http://127.0.0.1:8545

# 查詢所有市場
cast call 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C \
  "getAllMarkets()(address[])" \
  --rpc-url http://127.0.0.1:8545

# 查詢市場 collateral factor
cast call <M_TOKEN_ADDRESS> \
  "mintGuardianPaused()(bool)" \
  --rpc-url http://127.0.0.1:8545

# 查詢帳戶在特定市場的 supply/borrow balance
cast call <M_TOKEN_ADDRESS> \
  "balanceOf(address)(uint256)" \
  <ACCOUNT> --rpc-url http://127.0.0.1:8545

cast call <M_TOKEN_ADDRESS> \
  "borrowBalanceStored(address)(uint256)" \
  <ACCOUNT> --rpc-url http://127.0.0.1:8545

# 查詢 exchange rate（cToken ↔ underlying 轉換）
cast call <M_TOKEN_ADDRESS> \
  "exchangeRateStored()(uint256)" \
  --rpc-url http://127.0.0.1:8545
```

### 4.3 模擬清算

```bash
# 直接在 fork 上執行 liquidateBorrow
cast send <M_TOKEN_ADDRESS> \
  "liquidateBorrow(address,uint256,address)" \
  <BORROWER> <REPAY_AMOUNT> <COLLATERAL_M_TOKEN> \
  --rpc-url http://127.0.0.1:8545 \
  --private-key <TEST_KEY>

# 查看 seize 後的 collateral 餘額
cast call <COLLATERAL_M_TOKEN> \
  "balanceOf(address)(uint256)" \
  <LIQUIDATOR> --rpc-url http://127.0.0.1:8545
```

### 4.4 製造可清算倉位

**方法 A：Oracle 價格操縱（Anvil cheatcode）**

```bash
# 1. 找到用戶的借款市場和抵押品市場
# 2. 用 anvil cheatcode 修改 oracle 價格

# 前進時間（累積利息可能使 HF 下降）
cast rpc evm_increaseTime 86400 --rpc-url http://127.0.0.1:8545
cast rpc evm_mine --rpc-url http://127.0.0.1:8545

# 3. 再次檢查帳戶流動性
cast call 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C \
  "getAccountLiquidity(address)(uint256,uint256,uint256)" \
  <ACCOUNT> --rpc-url http://127.0.0.1:8545
```

**方法 B：增加債務（Borrow 更多）**

```bash
# 先 supply collateral
cast send <M_TOKEN_ADDRESS> \
  "mint(uint256)(uint256)" \
  <AMOUNT> \
  --rpc-url http://127.0.0.1:8545 \
  --private-key <TEST_KEY>

# 再 borrow 到接近上限
cast send <M_TOKEN_ADDRESS> \
  "borrow(uint256)(uint256)" \
  <AMOUNT> \
  --rpc-url http://127.0.0.1:8545 \
  --private-key <TEST_KEY>
```

### 4.5 清算流程測試

Moonwell (Compound V2) 清算流程：

```
1. 確認帳戶可清算：getAccountLiquidity() → shortfall > 0
2. 執行 liquidateBorrow(mToken, borrower, repayAmount)
   ├─ 自動 repay 借款
   └─ 自動 seize collateral（close factor = 50%）
3. 贖回 seize 的 cToken → underlying
4. DEX swap collateral → base asset（如需）
5. 計算利潤
```

**關鍵參數：**

| 參數 | 說明 | 典型值 |
|------|------|--------|
| closeFactor | 每次清算可還的最大債務比例 | 0.5 (50%) |
| liquidationIncentive | 清算人獲得的額外 collateral | 1.08-1.10 (8-10%) |
| collateralFactor | 市場抵押品折算率 | 0.75-0.85 |
| exchangeRate | cToken ↔ underlying 匯率 | 鏈上查詢 |

### 4.6 Flash Loan 清算路徑（Base 鏈可用來源）

> **注意**：Balancer Vault 和 Aave V3 Pool 在 Base 鏈**不存在**。

Base 鏈上可用的閃電貸來源：

| 來源 | 地址 | 函數 |
|------|------|------|
| Uniswap V3 Pool | `0xd0b53D9277642d899DF5C87A3966A349A798F224` (USDC/WETH) | `flash(address,address,uint256,uint256,bytes)` |
| Morpho Blue | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | `flashLoan(address,address,uint256,bytes)` |

```
Uniswap V3 Flash → liquidateBorrow → seize cToken
  → redeem cToken → Aerodrome/1inch swap → repay flash + skim profit
```

```bash
# 測試 Uniswap V3 flash loan (USDC/WETH pool)
cast call 0xd0b53D9277642d899DF5C87A3966A349A798F224 \
  "flash(address,address,uint256,uint256,bytes)" \
  0x0000000000000000000000000000000000000001 \
  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  1000000 0 "0x" \
  --rpc-url http://127.0.0.1:8545

# 測試 Morpho Blue flash loan
cast call 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb \
  "flashLoan(address,address,uint256,bytes)" \
  0x0000000000000000000000000000000000000001 \
  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  1000000 "0x" \
  --rpc-url http://127.0.0.1:8545
```

## 5. 端到端測試腳本

```bash
#!/bin/bash
set -e

echo "=== Moonwell Anvil Fork E2E Test ==="

# 1. 啟動 Anvil fork
echo "📦 Starting Anvil fork..."
anvil \
  --fork-url "$RPC_URL_8453" \
  --fork-block-number "${FORK_BLOCK:-48000000}" \
  --port 8545 \
  --host 0.0.0.0 &
ANVIL_PID=$!
sleep 3

# 2. 查詢 Moonwell 市場
echo "🔍 Querying Moonwell markets..."
MARKETS=$(cast call 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C \
  "getAllMarkets()(address[])" \
  --rpc-url http://127.0.0.1:8545)
echo "Markets: $MARKETS"

# 3. 查找可清算帳戶
echo "🔎 Searching for liquidatable accounts..."
# 需要遍歷歷史事件找到借款人

# 4. 部署 Executor
echo "🔧 Deploying executor..."
EXECUTOR=$(npx tsx apps/client/src/deployExecutor.ts --env-file=.env.fork | grep "Executor deployed at:" | awk '{print $NF}')
echo "Executor: $EXECUTOR"

# 5. 啟動 Bot（dry-run）
echo "🤖 Starting bot in DRY-RUN mode..."
DRY_RUN=true EXECUTOR_ADDRESS_8453=$EXECUTOR \
  npx tsx apps/client/src/script.ts --env-file=.env.fork &
BOT_PID=$!
sleep 5

# 6. Health check
echo "🏥 Health check..."
curl -s http://localhost:3000/health | jq .

# 7. 清理
echo "🧹 Cleaning up..."
kill $BOT_PID 2>/dev/null || true
kill $ANVIL_PID 2>/dev/null || true

echo "✅ E2E test complete"
```

## 6. 常用 Anvil 調試命令

```bash
# 查看帳戶在 Moonwell 的流動性
cast call 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C \
  "getAccountLiquidity(address)(uint256,uint256,uint256)" \
  <ADDRESS> --rpc-url http://127.0.0.1:8545

# 查看 cToken 餘額
cast call <M_TOKEN> "balanceOf(address)(uint256)" \
  <ADDRESS> --rpc-url http://127.0.0.1:8545

# 查看借款餘額
cast call <M_TOKEN> "borrowBalanceStored(address)(uint256)" \
  <ADDRESS> --rpc-url http://127.0.0.1:8545

# 查看 exchange rate
cast call <M_TOKEN> "exchangeRateStored()(uint256)" \
  --rpc-url http://127.0.0.1:8545

# 查看 collateral factor
cast call <M_TOKEN> "mintRate()(uint256)" \
  --rpc-url http://127.0.0.1:8545

# 給帳戶打 ETH
cast rpc anvil_setBalance <ADDRESS> 0x56BC75E2D63100000 \
  --rpc-url http://127.0.0.1:8545

# 前進時間
cast rpc evm_increaseTime 86400 --rpc-url http://127.0.0.1:8545
cast rpc evm_mine --rpc-url http://127.0.0.1:8545
```

## 7. Moonwell vs Morpho Blue 測試差異

| 項目 | Morpho Blue | Moonwell (Compound V2) |
|------|-------------|----------------------|
| 市場模型 | 自定義 market (loanToken + collateralToken + oracle + irm + lltv) | cToken 模型（每個資產一個 MToken） |
| 健康因子 | SDK 計算 `wDivDown(maxBorrow, borrow)` | 協議內建 `getAccountLiquidity()` |
| 清算觸發 | `isLiquidatable()` 或 HF < 1 | `getAccountLiquidity()` shortfall > 0 |
| 清算執行 | `liquidate()` 一筆交易 | `liquidateBorrow()` + 自動 seize |
| 抵押品模型 | 直接持有 underlying | 持有 cToken（需 redeem） |
| Close factor | 無（可全額清算） | 0.5（最多清算 50% 債務） |
| 清算獎勵 | 協議參數 | liquidationIncentive (8-10%) |
| PositionCache | 需要增量 HF 計算 | 不需要（協議提供） |
| Oracle | 每個市場獨立 oracle | 每個 MToken 內建 oracle 或 Chainlink |

## 8. 常見問題

| 問題 | 解決方案 |
|------|---------|
| `getAccountLiquidity` 返回全 0 | 帳戶無借貸或 Comptroller 地址錯誤 |
| `liquidateBorrow` revert | 確認帳戶 shortfall > 0，且 repayAmount ≤ closeFactor × debt |
| cToken balance 為 0 | 用戶可能已贖回，或地址錯誤 |
| exchange rate 異常 | Compound V2 的 exchangeRate 會隨時間增長（利息累積） |
| `seize` 失敗 | 只能在 liquidateBorrow 內部調用，不能直接調用 |
| ESM 模組錯誤 | 使用 `npx tsx` 而非 `node` |
