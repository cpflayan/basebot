import { chainConfigs } from "@morpho-blue-liquidation-bot/config";
import dotenv from "dotenv";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { deploy } from "./utils/deploy-executor.js";
async function run() {
    dotenv.config();
    // SECURITY (NM6): 添加 --chainId 參數限制部署目標鏈
    const argv = yargs(hideBin(process.argv))
        .option("chainId", {
        type: "number",
        description: "Target chain ID to deploy to (if not specified, deploys to all configured chains)",
        demandOption: false,
    })
        .parseSync();
    const targetChainId = argv.chainId;
    const configs = Object.entries(chainConfigs)
        .filter(([id]) => !targetChainId || Number(id) === targetChainId)
        .map(([, config]) => config);
    if (configs.length === 0) {
        console.error(`No chain config found for chainId=${targetChainId}`);
        return;
    }
    for (const config of configs) {
        const chain = config.chain;
        const id = chain.id;
        const rpcUrl = process.env[`RPC_URL_${id}`] ?? chain.rpcUrls.default.http[0];
        const privateKey = process.env[`LIQUIDATION_PRIVATE_KEY_${id}`];
        if (!rpcUrl) {
            throw new Error(`RPC_URL_${id} is not set`);
        }
        if (!privateKey) {
            throw new Error(`LIQUIDATION_PRIVATE_KEY_${id} is not set`);
        }
        const client = createWalletClient({
            chain,
            transport: http(rpcUrl),
            account: privateKeyToAccount(privateKey),
        });
        await deploy(client, privateKeyToAccount(privateKey).address);
    }
}
void run();
