import "dotenv/config";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

export async function notify(message: string): Promise<void> {
  console.log(`[notify] ${message}`);

  const tasks: Promise<unknown>[] = [];

  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    tasks.push(
      fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
      })
        .then((res) => {
          // SECURITY (NL2): 不在日誌中暴露 Telegram bot token
          if (!res.ok) console.error(`[notify] Telegram 發送失敗: status=${res.status}`);
        })
        .catch((e) => {
          // NL2: 過濾可能包含 token 的錯誤訊息
          const safeMsg = (e as Error).message.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<TOKEN>");
          console.error("[notify] Telegram 發送失敗:", safeMsg);
        }),
    );
  }

  if (DISCORD_WEBHOOK_URL) {
    tasks.push(
      fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      }).catch((e) => console.error("[notify] Discord 發送失敗:", e)),
    );
  }

  if (tasks.length === 0) {
    console.warn("[notify] 尚未設定任何通知管道（TELEGRAM_* 或 DISCORD_WEBHOOK_URL）");
    return;
  }

  await Promise.all(tasks);
}

// 熔斷專用：發送高優先級告警，前綴加上明顯標記
export async function notifyCritical(message: string): Promise<void> {
  await notify(`🚨🚨🚨 熔斷觸發 🚨🚨🚨\n${message}`);
}
