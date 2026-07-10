import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http, formatEther } from "viem";
import { CHAIN_SETUPS } from "../shared/chains.js";
import { notifyCritical, notify } from "../notifier/webhook.js";
const KILL_SWITCH_PATH = process.env.KILL_SWITCH_PATH ?? path.resolve(process.cwd(), "data/kill.flag");
const POLL_INTERVAL_MS = Number(process.env.CIRCUIT_BREAKER_POLL_MS ?? 60_000);
// 兩種熔斷條件，任一觸發就停：
// 1. 相對峰值回撤超過 MAX_DRAWDOWN_PCT
// 2. 絕對虧損超過 MAX_ABSOLUTE_LOSS_NATIVE（以該鏈原生代幣計價，粗估）
const MAX_DRAWDOWN_PCT = Number(process.env.MAX_DRAWDOWN_PCT ?? 20); // 20%
const MAX_ABSOLUTE_LOSS_NATIVE = Number(process.env.MAX_ABSOLUTE_LOSS_NATIVE ?? 0.05); // 例如 0.05 ETH
const state = new Map();
function isKilled() {
    return fs.existsSync(KILL_SWITCH_PATH);
}
function triggerKillSwitch(reason) {
    fs.mkdirSync(path.dirname(KILL_SWITCH_PATH), { recursive: true });
    fs.writeFileSync(KILL_SWITCH_PATH, JSON.stringify({ reason, timestamp: new Date().toISOString() }, null, 2));
}
async function pollChain(setup) {
    const executorAddress = process.env[`EXECUTOR_ADDRESS_${setup.chainId}`];
    if (!executorAddress) {
        console.warn(`[circuit-breaker] 鏈 ${setup.chainId} 未設定 EXECUTOR_ADDRESS_${setup.chainId}，跳過監控`);
        return;
    }
    const client = createPublicClient({ chain: setup.chain, transport: http(setup.rpcUrl) });
    const balanceWei = await client.getBalance({ address: executorAddress });
    const balance = Number(formatEther(balanceWei));
    // SECURITY (L5): 允許從環境變數設定初始峰值，避免啟動時餘額已低導致熔斷誤判
    const envPeakStr = process.env[`INITIAL_PEAK_BALANCE_${setup.chainId}`];
    const envPeak = envPeakStr ? Number(envPeakStr) : 0;
    const prev = state.get(setup.chainId) ?? {
        peakBalance: Math.max(balance, envPeak), // 取環境變數和當前餘額的較大值
        lastBalance: balance,
    };
    const peakBalance = Math.max(prev.peakBalance, balance);
    state.set(setup.chainId, { peakBalance, lastBalance: balance });
    const drawdownPct = peakBalance > 0 ? ((peakBalance - balance) / peakBalance) * 100 : 0;
    const absoluteLoss = peakBalance - balance;
    console.log(`[circuit-breaker] ${setup.chain.name} executor 餘額=${balance.toFixed(6)} 峰值=${peakBalance.toFixed(6)} 回撤=${drawdownPct.toFixed(2)}%`);
    if (drawdownPct >= MAX_DRAWDOWN_PCT) {
        const reason = `${setup.chain.name} executor 回撤達 ${drawdownPct.toFixed(2)}%（門檻 ${MAX_DRAWDOWN_PCT}%）`;
        triggerKillSwitch(reason);
        await notifyCritical(reason);
        return;
    }
    if (absoluteLoss >= MAX_ABSOLUTE_LOSS_NATIVE) {
        const reason = `${setup.chain.name} executor 絕對虧損達 ${absoluteLoss.toFixed(6)}（門檻 ${MAX_ABSOLUTE_LOSS_NATIVE}）`;
        triggerKillSwitch(reason);
        await notifyCritical(reason);
        return;
    }
}
async function loop() {
    if (isKilled()) {
        console.error("[circuit-breaker] kill switch 已觸發，程式停止輪詢。請人工檢查 data/kill.flag 後手動移除。");
        return;
    }
    for (const setup of CHAIN_SETUPS) {
        try {
            await pollChain(setup);
        }
        catch (e) {
            console.error(`[circuit-breaker] 監控 ${setup.chain.name} 時發生錯誤:`, e);
        }
    }
    setTimeout(loop, POLL_INTERVAL_MS);
}
console.log("[circuit-breaker] 啟動熔斷監控");
notify("熔斷監控服務已啟動").catch(() => { });
loop();
