import { chainConfigs } from "@morpho-blue-liquidation-bot/config";
import dotenv from "dotenv";
import { type Address, createWalletClient, type Hex, http, getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { skim } from "./utils/skim.js";

async function run() {
  dotenv.config();

  const argv = yargs(hideBin(process.argv))
    .option("chainId", {
      type: "number",
      description: "Chain ID to use",
      demandOption: true,
    })
    .option("token", {
      type: "string",
      description: "Token address",
      demandOption: true,
    })
    .option("recipient", {
      type: "string",
      description: "Recipient address",
      demandOption: false,
    })
    .parseSync();

  // SECURITY (NL4): 驗證 token 地址格式
  if (!isAddress(argv.token)) {
    throw new Error(`Invalid token address: ${argv.token}`);
  }
  const token = getAddress(argv.token);
  const chainId = argv.chainId;

  const rpcUrl = process.env[`RPC_URL_${chainId}`];
  const privateKey = process.env[`LIQUIDATION_PRIVATE_KEY_${chainId}`];
  const executorAddress = process.env[`EXECUTOR_ADDRESS_${chainId}`];

  if (!rpcUrl) {
    throw new Error(`RPC_URL_${chainId} is not set`);
  }
  if (!privateKey) {
    throw new Error(`LIQUIDATION_PRIVATE_KEY_${chainId} is not set`);
  }
  if (!executorAddress) {
    throw new Error(`EXECUTOR_ADDRESS_${chainId} is not set`);
  }

  const chainConfig = chainConfigs[chainId];
  if (!chainConfig) {
    throw new Error(`Chain config for ${chainId} is not set`);
  }

  const client = createWalletClient({
    chain: chainConfig.chain,
    transport: http(rpcUrl),
    account: privateKeyToAccount(privateKey as Hex),
  });

  // SECURITY (NL4): 驗證 recipient 地址格式和 checksum
  const rawRecipient = argv.recipient;
  let recipient: Address;
  if (rawRecipient) {
    if (!isAddress(rawRecipient)) {
      throw new Error(`Invalid recipient address: ${rawRecipient}`);
    }
    recipient = getAddress(rawRecipient); // checksum 驗證
  } else {
    recipient = client.account.address;
  }

  await skim(client, token, executorAddress as Address, recipient);
}

void run();
