import { chainConfigs } from "@morpho-blue-liquidation-bot/config";
import dotenv from "dotenv";
import { createWalletClient, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { deploy } from "./utils/deploy-executor.js";

/** Match getSecrets() aliases so RPC_URL_BASE / RPC_URL_MAINNET work. */
const CHAIN_NAME_ALIASES: Record<number, string> = {
  1: "MAINNET",
  8453: "BASE",
};

function resolveRpcUrl(chainId: number, fallback?: string): string | undefined {
  const alias = CHAIN_NAME_ALIASES[chainId];
  return (
    process.env[`RPC_URL_${chainId}`] ??
    (alias ? process.env[`RPC_URL_${alias}`] : undefined) ??
    fallback
  );
}

async function run() {
  dotenv.config();

  // SECURITY (NM6): --chainId limits deployment target.
  // Strip bare `--` — `pnpm run script -- --chainId X` sometimes leaves a lone
  // `--` in argv, which makes yargs stop parsing options (chainId stays undefined).
  const argv = yargs(hideBin(process.argv).filter((a) => a !== "--"))
    .option("chainId", {
      type: "number",
      description:
        "Target chain ID to deploy to (if not specified, deploys to all configured chains)",
      demandOption: false,
    })
    .parseSync();

  const targetChainId = argv.chainId;
  if (targetChainId !== undefined) {
    console.log(`Deploying executor to chainId=${targetChainId} only`);
  } else {
    console.warn("No --chainId given; deploying to ALL configured chains that have keys set");
  }

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

    const rpcUrl = resolveRpcUrl(id, chain.rpcUrls.default.http[0]);
    const privateKey = process.env[`LIQUIDATION_PRIVATE_KEY_${id}`];

    if (!rpcUrl) {
      throw new Error(`RPC_URL_${id} (or RPC_URL_${CHAIN_NAME_ALIASES[id] ?? "ALIAS"}) is not set`);
    }
    if (!privateKey) {
      if (targetChainId) {
        throw new Error(`LIQUIDATION_PRIVATE_KEY_${id} is not set`);
      }
      console.warn(`Skipping chain ${id}: LIQUIDATION_PRIVATE_KEY_${id} is not set`);
      continue;
    }

    console.log(`Deploying on chain ${id} via ${rpcUrl.replace(/\/v2\/.*/, "/v2/***")}…`);

    const account = privateKeyToAccount(privateKey as Hex);
    const client = createWalletClient({
      chain,
      transport: http(rpcUrl),
      account,
    });

    await deploy(client, account.address);
  }
}

void run();
