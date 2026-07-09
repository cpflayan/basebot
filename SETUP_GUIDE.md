# Morpho 清算機器人 — 設定指南

## 1. 環境變數設定

### 1.1 morpho-blue-liquidation-bot/.env

```bash
# === Base 鏈 RPC（必填）===
# Alchemy Base Mainnet HTTP RPC
RPC_URL_8453=https://base-mainnet.g.alchemy.com/v2/<YOUR_ALCHEMY_API_KEY>

# === 清算執行器（部署後填入）===
EXECUTOR_ADDRESS_8453=<DEPLOYED_EXECUTOR_ADDRESS>

# === 私鑰（必填，帶 0x 前綴）===
LIQUIDATION_PRIVATE_KEY_8453=0x<YOUR_PRIVATE_KEY>

# === Discovery 白名單路徑（必填）===
WHITELIST_DATA_DIR=/home/sip/czaryai/qcmix/base-bot/morpho-liquidation-discovery/data

# === 1inch API（流動性兜底）===
ONE_INCH_SWAP_API_KEY=<YOUR_1INCH_API_KEY>

# === 可選：Treasury 多簽地址（利潤收集）===
# TREASURY_ADDRESS_8453=0x...
```

### 1.2 morpho-liquidation-discovery/.env

```bash
# === RPC ===
# Base 官方（掃描用，支援 10000 區塊 eth_getLogs）
BACKFILL_SCAN_RPC=https://mainnet.base.org
# Alchemy（安全檢查用）
BACKFILL_SAFETY_RPC=https://base-mainnet.g.alchemy.com/v2/<YOUR_ALCHEMY_API_KEY>
# 掃描批次大小（Base 官方限制 10000）
BACKFILL_BATCH_SIZE=10000

# === 共用資料夾 ===
WHITELIST_DATA_DIR=./data
KILL_SWITCH_PATH=./data/kill.flag

# === 熔斷參數 ===
CIRCUIT_BREAKER_POLL_MS=60000
MAX_DRAWDOWN_PCT=20
MAX_ABSOLUTE_LOSS_NATIVE=0.05

# === 通知（至少填一組）===
TELEGRAM_BOT_TOKEN=<YOUR_TELEGRAM_BOT_TOKEN>
TELEGRAM_CHAT_ID=<YOUR_TELEGRAM_CHAT_ID>
# 或
DISCORD_WEBHOOK_URL=<YOUR_DISCORD_WEBHOOK_URL>

# === 1inch API ===
ONE_INCH_SWAP_API_KEY=<YOUR_1INCH_API_KEY>
```

---

## 2. Alchemy Webhook 設定

### 2.1 建立 Webhook

1. 前往 [Alchemy Dashboard](https://dashboard.alchemy.com/)
2. 選擇 Base Mainnet App → Notify → Create Webhook
3. 填入 Webhook URL（你的伺服器 IP 或 Cloudflare Tunnel）

### 2.2 GraphQL 查詢（複製貼上）

```graphql
{
  block {
    logs(filter: { addresses: ["0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"] }) {
      data
      topics
    }
  }
}
```

**說明：**
- `addresses`: MorphoBlue 合約地址（Base 鏈）
- 只回傳 `data` 和 `topics`，最小化 payload

### 2.3 事件類型

Bot 監聽 6 種 MorphoBlue 事件：
- `Borrow` — 借款（可能導致 HF < 1）
- `Repay` — 還款
- `Supply` — 供應
- `Withdraw` — 提取
- `SupplyCollateral` — 供應抵押品
- `WithdrawCollateral` — 提取抵押品

---

## 3. 容易遺漏的項目

### 3.1 私鑰格式
```bash
# ✅ 正確（帶 0x 前綴）
LIQUIDATION_PRIVATE_KEY_8453=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# ❌ 錯誤（缺 0x）
LIQUIDATION_PRIVATE_KEY_8453=ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

### 3.2 WHITELIST_DATA_DIR 路徑
```bash
# ✅ 必須指向 discovery 的 data 目錄
WHITELIST_DATA_DIR=/home/sip/czaryai/qcmix/base-bot/morpho-liquidation-discovery/data

# ❌ 錯誤路徑
WHITELIST_DATA_DIR=./data
```

### 3.3 Discovery 資料夾權限
```bash
# 確保 discovery/data 目錄存在且有寫入權限
mkdir -p /home/sip/czaryai/qcmix/base-bot/morpho-liquidation-discovery/data
chmod 755 /home/sip/czaryai/qcmix/base-bot/morpho-liquidation-discovery/data
```

### 3.4 白名單檔案
首次啟動前需先執行 discovery 生成白名單：
```bash
cd morpho-liquidation-discovery
pnpm install
npx tsx scripts/scan-liquidations.ts
```

確認 `data/discovered-markets.8453.json` 已生成。

### 3.5 Webhook 端口
```bash
# 預設端口 3001，可自訂
WEBHOOK_PORT=3001

# 防火牆需開放此端口
sudo ufw allow 3001/tcp
```

### 3.6 RPC WebSocket 支援
Bot 使用 `watchBlocks` 監聽新区塊，需要 WebSocket RPC：
```bash
# Alchemy WebSocket（自動使用，無需額外設定）
wss://base-mainnet.g.alchemy.com/v2/<YOUR_ALCHEMY_API_KEY>
```

---

## 4. 啟動順序

```bash
# 1. 啟動 Discovery（生成白名單）
cd morpho-liquidation-discovery
npx tsx scripts/scan-liquidations.ts

# 2. 啟動 Bot
cd ../morpho-blue-liquidation-bot
npx tsx apps/client/src/index.ts

# 3. 啟動 Cloudflare Tunnel（如需對外接收 Webhook）
cloudflared tunnel --url http://localhost:3001
```

---

## 5. 驗證清單

- [ ] `RPC_URL_8453` 已設定且有效
- [ ] `LIQUIDATION_PRIVATE_KEY_8453` 帶 `0x` 前綴
- [ ] `WHITELIST_DATA_DIR` 指向正確的 discovery/data 路徑
- [ ] `discovered-markets.8453.json` 已生成
- [ ] Alchemy Webhook GraphQL 查詢正確
- [ ] Webhook URL 可達（Cloudflare Tunnel 或公網 IP）
- [ ] 端口 3001 已開放
- [ ] 通知設定（Telegram/Discord）至少一組已配置
