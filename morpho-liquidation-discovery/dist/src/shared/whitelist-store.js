import fs from "node:fs";
import path from "node:path";
// 這個資料夾要跟官方 morpho-blue-liquidation-bot 的 config-patch 共用
// 建議用 symlink 或直接設在同一個 volume（見 README）
const DATA_DIR = process.env.WHITELIST_DATA_DIR ?? path.resolve(process.cwd(), "data");
function filePath(chainId) {
    return path.join(DATA_DIR, `discovered-markets.${chainId}.json`);
}
export function loadDiscovered(chainId) {
    const p = filePath(chainId);
    if (!fs.existsSync(p))
        return [];
    try {
        const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
        // SECURITY (NM8): 驗證數據結構，防止損壞文件導致運行時錯誤
        if (!Array.isArray(raw)) {
            console.warn(`[whitelist-store] ⚠️ ${p} 頂層不是陣列，返回空列表`);
            return [];
        }
        return raw.filter((item) => {
            if (typeof item !== "object" || item === null)
                return false;
            const obj = item;
            return (typeof obj.marketId === "string" &&
                typeof obj.chainId === "number" &&
                typeof obj.oracle === "string" &&
                typeof obj.collateralToken === "string" &&
                typeof obj.loanToken === "string" &&
                typeof obj.approved === "boolean");
        });
    }
    catch (e) {
        console.error(`[whitelist-store] 讀取 ${p} 失敗:`, e);
        return [];
    }
}
export function saveDiscoveredMarket(market) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const list = loadDiscovered(market.chainId);
    const existingIdx = list.findIndex((m) => m.marketId === market.marketId);
    if (existingIdx >= 0) {
        list[existingIdx] = market;
    }
    else {
        list.push(market);
    }
    // SECURITY (M4): 原子寫入 — 先寫臨時檔案再 rename，防止崩潰導致數據損壞
    const target = filePath(market.chainId);
    const tmp = target + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, target);
}
// 官方 bot 的 config.ts patch 會呼叫這個邏輯的等價版本
// 只回傳通過安全審查的市場 ID，餵給 additionalMarketsWhitelist
export function getApprovedMarketIds(chainId) {
    return loadDiscovered(chainId)
        .filter((m) => m.approved)
        .map((m) => m.marketId);
}
