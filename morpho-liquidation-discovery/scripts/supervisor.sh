#!/usr/bin/env bash
# 監督官方 morpho-blue-liquidation-bot 進程：
# 1. 定期重啟，讓新發現且已核准的市場能被載入（config.ts 在啟動時讀取一次）
# 2. 一旦偵測到 kill.flag，立刻停止並且不再自動重啟，等待人工排查
set -euo pipefail

BOT_DIR="${BOT_DIR:-../morpho-blue-liquidation-bot}"
KILL_SWITCH_PATH="${KILL_SWITCH_PATH:-./data/kill.flag}"
RESTART_INTERVAL_SECONDS="${RESTART_INTERVAL_SECONDS:-3600}" # 預設每小時重啟一次，載入新白名單

echo "[supervisor] 開始監督 $BOT_DIR"

while true; do
  if [ -f "$KILL_SWITCH_PATH" ]; then
    echo "[supervisor] 偵測到 kill switch，停止一切操作。內容："
    cat "$KILL_SWITCH_PATH"
    exit 1
  fi

  echo "[supervisor] 啟動 bot（最多跑 $RESTART_INTERVAL_SECONDS 秒後檢查白名單更新）"
  (cd "$BOT_DIR" && pnpm start) &
  BOT_PID=$!

  SECONDS_WAITED=0
  while [ $SECONDS_WAITED -lt "$RESTART_INTERVAL_SECONDS" ]; do
    if [ -f "$KILL_SWITCH_PATH" ]; then
      echo "[supervisor] 執行中偵測到 kill switch，立即終止 bot"
      kill "$BOT_PID" 2>/dev/null || true
      wait "$BOT_PID" 2>/dev/null || true
      cat "$KILL_SWITCH_PATH"
      exit 1
    fi
    sleep 5
    SECONDS_WAITED=$((SECONDS_WAITED + 5))
  done

  echo "[supervisor] 定期重啟週期到，重啟 bot 以載入新白名單"
  kill "$BOT_PID" 2>/dev/null || true
  wait "$BOT_PID" 2>/dev/null || true
done
