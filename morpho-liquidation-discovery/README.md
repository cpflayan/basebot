# Morpho Liquidation Discovery Layer

獨立於官方 `morpho-blue-liquidation-bot` 之外的自動發現 + 安全過濾 + 熔斷通知層。
跟官方 bot 之間**不共用程式碼**，只透過共用的 JSON 白名單檔案 (`data/discovered-markets.<chainId>.json`) 跟 kill switch 檔案 (`data/kill.flag`) 對接。

## 這是什麼 / 不是什麼

- **是**：一個持續監聽 Morpho Blue `CreateMarket` 事件、對新市場跑安全檢查、把通過檢查的市場寫進共用白名單、並且監控 executor 合約資金曲線觸發熔斷的服務。
- **不是**：完整的清算執行邏輯。清算的實際執行（flash loan、清算交易、DEX 換幣）仍然交給官方 `morpho-blue-liquidation-bot` 處理，本專案只負責「餵市場」跟「按下緊急停止鍵」。

## 目錄結構

```
src/
  discovery/        # CreateMarket 事件監聽 + 觸發安全檢查
  safety/           # 市場安全過濾邏輯（oracle、LLTV、代幣合法性、流動性）
  circuit-breaker/  # 監控 executor 合約資金曲線，觸發熔斷
  notifier/         # Telegram / Discord webhook
  shared/           # 多鏈設定、白名單讀寫工具
config-patch/       # 官方 bot config.ts 的修改範例（不是可執行檔）
scripts/supervisor.sh  # 定期重啟官方 bot + 監聽 kill switch
data/               # 執行期產生的白名單 JSON 跟 kill.flag（不要 commit 進 git）
```

## 安裝

```bash
pnpm install
cp .env.example .env
# 編輯 .env，至少填入 RPC_URL_BASE 跟一組通知管道
```

## 跟官方 bot 對接的步驟

1. 官方 repo clone 在同一台機器的旁邊目錄（例如 `../morpho-blue-liquidation-bot`）
2. 打開官方的 `apps/config/src/config.ts`，參考 `config-patch/config.patch.example.ts` 加入 `loadApprovedMarketIds()`，把 Base 鏈的 `additionalMarketsWhitelist` 改成讀取本專案 `data/` 資料夾產生的 JSON
3. 兩個專案的 `WHITELIST_DATA_DIR` 環境變數要指向同一個絕對路徑
4. 部署 executor 合約後，把地址填進本專案 `.env` 的 `EXECUTOR_ADDRESS_8453`

## 啟動順序

```bash
# 1. 啟動發現層（監聽新市場 + 安全過濾）
pnpm discover

# 2. 另開一個 terminal，啟動熔斷監控
pnpm circuit-breaker

# 3. 用 supervisor 腳本啟動官方 bot（會定期重啟以載入新白名單，並監聽 kill switch）
chmod +x scripts/supervisor.sh
BOT_DIR=../morpho-blue-liquidation-bot ./scripts/supervisor.sh
```

## 歷史市場回填（一次性）

首次部署時需要回填 Morpho Blue 歷史創建的市場：

```bash
# 使用雙 RPC 策略（掃描用高容量公共 RPC，安全檢查用付費 RPC）
BACKFILL_SCAN_RPC="https://mainnet.base.org" \
BACKFILL_SAFETY_RPC="https://your-rpc-url" \
BACKFILL_BATCH_SIZE=10000 \
npx tsx scripts/backfill-markets.ts
```

**環境變數說明：**
- `BACKFILL_SCAN_RPC`：事件掃描用（需支援大範圍 eth_getLogs，Base 公共 RPC 支援 10,000 區塊）
- `BACKFILL_SAFETY_RPC`：安全檢查用（會頻繁調用，建議用付費 RPC 避免 rate limit）
- `BACKFILL_BATCH_SIZE`：每批掃描區塊數（預設 100,000，可根據 RPC 限制調整）

回填會自動保存進度到 `data/backfill-checkpoint.json`，中斷後重啟會從上次位置繼續。

## 上線前一定要做的事（目前骨架裡是 TODO，還沒做完）

1. ~~**Pyth oracle factory 的驗證函式名稱未經 100% 確認**~~ ✅ 已驗證：`isMorphoPythOracle(address)` 透過 bytecode selector 反推確認正確（selector 0xc1cb624b 與 basescan 交易記錄完全吻合）
2. ~~**0x API 流動性檢查的 taker 地址無效**~~ ✅ 已修復：使用 `0x1234567890123456789012345678901234567890`（符合 0x API v2 要求 > 0x...ffff）
3. ~~**DEX 流動性檢查的測試量目前沒有校正 decimals**~~ ✅ 已修復：自動查詢 `collateralToken` decimals，使用 `100 * 10^decimals` 作為測試量（約 $100 等值）
4. **0x API 流動性檢查需要你自己申請 API key**（https://dashboard.0x.org，免費），填進 `.env` 的 `ZEROX_API_KEY`
5. **`data/discovered-markets.*.json` 裡 `approved: false` 的市場預設不會被官方 bot 讀取**，但目前的安全分數門檻（60分）是隨手設的，建議先跑一段時間觀察誤判率再調整
6. **熔斷門檻（`MAX_DRAWDOWN_PCT`、`MAX_ABSOLUTE_LOSS_NATIVE`）目前是預設的保守值**，需要根據你實際的資金規模重新校準
7. **kill switch 目前只會停止 supervisor 管理的官方 bot 進程**，不會自動撤回已經在鏈上等待確認的交易，也不會清空 executor 合約裡的資金——熔斷後務必人工檢查現場

## 安全提醒

這套系統設計成全自動執行，私鑰會直接控制資金。在正式接上主網資金之前：
- 先在測試網或用極小額資金跑至少一到兩週，觀察安全過濾器的誤判率
- 熔斷通知務必確認能收到（先手動觸發一次測試訊息）
- 定期人工檢查 `data/discovered-markets.*.json`，抽查安全過濾器批准的市場是否真的安全
