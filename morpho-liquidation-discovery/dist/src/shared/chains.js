import "dotenv/config";
import { base, mainnet, arbitrum, polygon } from "viem/chains";
// Morpho Blue 核心合約地址在大部分鏈上是同一組（CREATE2 部署）
// 部署前務必到 https://docs.morpho.org/addresses 核對，不要照抄過期地址
export const MORPHO_BLUE_ADDRESS = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
function requireEnv(name) {
    const v = process.env[name];
    if (!v) {
        throw new Error(`缺少環境變數 ${name}，請檢查 .env。該鏈將被跳過（無 RPC 可用）`);
    }
    return v;
}
// SECURITY (H4): 明確區分「已配置」和「未配置」的鏈
// 未配置 RPC 的鏈不會被加入 CHAIN_SETUPS，並輸出警告
export const CHAIN_SETUPS = [
    {
        chainId: base.id,
        chain: base,
        // SECURITY (NL3): 簡化寫法，避免冗餘的 ?? 組合
        rpcUrl: requireEnv("RPC_URL_BASE"),
        liquidationEnabled: true, // 第一階段先只在這裡開放實際清算
    },
    {
        chainId: mainnet.id,
        chain: mainnet,
        rpcUrl: process.env.RPC_URL_MAINNET ?? "",
        liquidationEnabled: false,
    },
    {
        chainId: arbitrum.id,
        chain: arbitrum,
        rpcUrl: process.env.RPC_URL_ARBITRUM ?? "",
        liquidationEnabled: false,
    },
    {
        chainId: polygon.id,
        chain: polygon,
        rpcUrl: process.env.RPC_URL_POLYGON ?? "",
        liquidationEnabled: false,
    },
].filter((c) => {
    if (c.rpcUrl.length === 0) {
        console.warn(`[chains] 鏈 ${c.chainId} 未配置 RPC URL，已跳過`);
        return false;
    }
    return true;
});
export const CREATE_MARKET_EVENT = {
    type: "event",
    name: "CreateMarket",
    inputs: [
        { indexed: true, name: "id", type: "bytes32" },
        {
            indexed: false,
            name: "marketParams",
            type: "tuple",
            components: [
                { name: "loanToken", type: "address" },
                { name: "collateralToken", type: "address" },
                { name: "oracle", type: "address" },
                { name: "irm", type: "address" },
                { name: "lltv", type: "uint256" },
            ],
        },
    ],
};
