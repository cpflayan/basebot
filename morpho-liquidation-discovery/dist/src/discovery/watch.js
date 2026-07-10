import { createPublicClient, http, decodeEventLog } from "viem";
import fs from "node:fs";
import path from "node:path";
import { MORPHO_BLUE_ADDRESS, CREATE_MARKET_EVENT } from "../shared/chains.js";
import { runSafetyChecks } from "../safety/checks.js";
import { saveDiscoveredMarket } from "../shared/whitelist-store.js";
import { notify } from "../notifier/webhook.js";
// QuickNode 等負載均衡 RPC 不支援 eth_newFilter / eth_getFilterChanges
// 改用 polling + eth_getLogs 方式監聽事件
const POLL_INTERVAL_MS = 8_000; // Base 出塊 ~2s，8 秒約 4-5 區塊，配合 QuickNode 5 區塊限制
const BLOCK_RANGE = 5; // QuickNode discover 計劃限制 eth_getLogs 最多 5 個區塊
// SECURITY (M3): 持久化 lastBlock 防止進程重啟時遺漏事件
const CHECKPOINT_DIR = process.env.WHITELIST_DATA_DIR ?? path.resolve(process.cwd(), "data");
function loadLastBlock(chainId) {
    const p = path.join(CHECKPOINT_DIR, `watch-checkpoint.${chainId}.json`);
    try {
        if (fs.existsSync(p)) {
            const data = JSON.parse(fs.readFileSync(p, "utf-8"));
            return { lastBlock: BigInt(data.lastBlock), blockHash: data.blockHash ?? "" };
        }
    }
    catch {
        // 損壞的 checkpoint 忽略，從當前區塊開始
    }
    return null;
}
function saveLastBlock(chainId, block, blockHash) {
    const p = path.join(CHECKPOINT_DIR, `watch-checkpoint.${chainId}.json`);
    try {
        fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
        // SECURITY (M4): 使用原子寫入（write-temp-then-rename）
        const tmp = p + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify({ lastBlock: block.toString(), blockHash, updatedAt: new Date().toISOString() }));
        fs.renameSync(tmp, p);
    }
    catch (e) {
        console.warn(`[discovery] 無法保存 checkpoint:`, e);
    }
}
export function watchChain(chainSetup) {
    const client = createPublicClient({
        chain: chainSetup.chain,
        transport: http(chainSetup.rpcUrl),
    });
    console.log(`[discovery] 開始監聽 ${chainSetup.chain.name} (chainId=${chainSetup.chainId})，polling 模式`);
    // SECURITY (M3): 從持久化 checkpoint 恢復 lastBlock，避免重啟遺漏事件
    const checkpoint = loadLastBlock(chainSetup.chainId);
    let lastBlock = checkpoint?.lastBlock ?? null;
    let lastBlockHash = checkpoint?.blockHash ?? "";
    // SECURITY (NH3): 啟動時驗證鏈連續性，檢測重組（在首次 poll 中執行）
    let needsReorgCheck = true;
    async function poll() {
        try {
            // SECURITY (NH3): 首次 poll 時驗證 checkpoint 的 block hash
            if (needsReorgCheck && lastBlock !== null && lastBlockHash) {
                needsReorgCheck = false;
                try {
                    const savedBlock = await client.getBlock({ blockNumber: lastBlock });
                    if (savedBlock.hash && savedBlock.hash !== lastBlockHash) {
                        console.warn(`[discovery] ⚠️ 鏈重組檢測：checkpoint block ${lastBlock} hash 不匹配 ` +
                            `(saved=${lastBlockHash}, actual=${savedBlock.hash})。回溯 50 區塊重新掃描`);
                        lastBlock = lastBlock - 50n > 0n ? lastBlock - 50n : null;
                    }
                }
                catch {
                    console.warn(`[discovery] 無法驗證 checkpoint block ${lastBlock}，回溯 20 區塊`);
                    lastBlock = lastBlock !== null && lastBlock - 20n > 0n ? lastBlock - 20n : null;
                }
            }
            else {
                needsReorgCheck = false;
            }
            const currentBlock = await client.getBlockNumber();
            let fromBlock = lastBlock !== null ? lastBlock + 1n : currentBlock - BigInt(BLOCK_RANGE);
            const toBlock = currentBlock;
            // QuickNode 限制每次最多 5 區塊，超過則分批處理
            while (fromBlock <= toBlock) {
                const batchTo = fromBlock + BigInt(BLOCK_RANGE) - 1n > toBlock ? toBlock : fromBlock + BigInt(BLOCK_RANGE) - 1n;
                const logs = await client.getLogs({
                    address: MORPHO_BLUE_ADDRESS,
                    event: CREATE_MARKET_EVENT,
                    fromBlock,
                    toBlock: batchTo,
                });
                if (logs.length > 0) {
                    console.log(`[discovery] block ${fromBlock}-${batchTo}: 發現 ${logs.length} 個新市場`);
                }
                for (const log of logs) {
                    try {
                        const decoded = decodeEventLog({
                            abi: [CREATE_MARKET_EVENT],
                            data: log.data,
                            topics: log.topics,
                        });
                        const { id, marketParams } = decoded.args;
                        console.log(`[discovery] 發現新市場 ${id} on ${chainSetup.chain.name} (block ${log.blockNumber})`);
                        const result = await runSafetyChecks({
                            chainSetup,
                            oracle: marketParams.oracle,
                            loanToken: marketParams.loanToken,
                            collateralToken: marketParams.collateralToken,
                            lltv: marketParams.lltv,
                        });
                        saveDiscoveredMarket({
                            marketId: id,
                            chainId: chainSetup.chainId,
                            loanToken: marketParams.loanToken,
                            collateralToken: marketParams.collateralToken,
                            oracle: marketParams.oracle,
                            irm: marketParams.irm,
                            lltv: marketParams.lltv.toString(),
                            discoveredAt: new Date().toISOString(),
                            safetyScore: result.score,
                            safetyNotes: result.notes,
                            approved: result.approved,
                        });
                        const statusEmoji = result.approved ? "✅" : "⛔";
                        await notify(`${statusEmoji} [${chainSetup.chain.name}] 新市場 ${id.slice(0, 10)}...\n` +
                            `分數: ${result.score}/100\n` +
                            `${result.notes.join("\n")}`);
                    }
                    catch (e) {
                        console.error(`[discovery] 處理事件 log 失敗:`, e);
                    }
                }
                fromBlock = batchTo + 1n;
            }
            lastBlock = toBlock;
            // SECURITY (M3/NH3): 持久化 lastBlock + block hash
            try {
                const blockData = await client.getBlock({ blockNumber: toBlock });
                saveLastBlock(chainSetup.chainId, toBlock, blockData.hash ?? "");
            }
            catch {
                saveLastBlock(chainSetup.chainId, toBlock, "");
            }
        }
        catch (e) {
            console.error(`[discovery] ${chainSetup.chain.name} polling 錯誤:`, e.message);
        }
        setTimeout(poll, POLL_INTERVAL_MS);
    }
    poll();
}
