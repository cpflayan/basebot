import { CHAIN_SETUPS } from "../shared/chains.js";
import { watchChain } from "./watch.js";
console.log(`[discovery] 啟動，共 ${CHAIN_SETUPS.length} 條鏈`);
for (const setup of CHAIN_SETUPS) {
    watchChain(setup);
}
// 保持程式存活
process.stdin.resume();
