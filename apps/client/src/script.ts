import {
  chainConfigs,
  chainConfig,
  type DataProviderName,
} from "@morpho-blue-liquidation-bot/config";
import {
  createDataProviders,
  type DataProvider,
} from "@morpho-blue-liquidation-bot/data-providers";

import { startHealthServer } from "./health";
import { WebhookServer } from "./webhook";

import { launchBot } from ".";

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

async function run() {
  const configs = Object.keys(chainConfigs)
    .map((config) => {
      try {
        return chainConfig(Number(config));
      } catch {
        return undefined;
      }
    })
    .filter((config) => config !== undefined);

  // Group chains by data provider name
  const chainsByProvider = new Map<DataProviderName, number[]>();
  for (const config of configs) {
    const existing = chainsByProvider.get(config.dataProvider) ?? [];
    existing.push(config.chainId);
    chainsByProvider.set(config.dataProvider, existing);
  }

  // Create data providers (one per provider type, shared across chains)
  const providersByChain = new Map<number, DataProvider>();
  for (const [providerName, chainIds] of chainsByProvider) {
    const providers = await createDataProviders(providerName, chainIds);
    for (const [chainId, provider] of providers) {
      providersByChain.set(chainId, provider);
    }
  }

  try {
    await startHealthServer();
  } catch (err) {
    console.error("Failed to start health server:", err);
  }

  // Webhook server for Alchemy event-driven triggering
  const webhookPort = Number.parseInt(process.env.WEBHOOK_PORT ?? "3001", 10);
  const webhookServer = new WebhookServer(webhookPort);
  try {
    await webhookServer.start();
  } catch (err) {
    console.error("Failed to start webhook server:", err);
  }

  for (const config of configs) {
    const dataProvider = providersByChain.get(config.chainId);
    if (!dataProvider) {
      console.error(`No data provider for chain ${config.chainId}, skipping`);
      continue;
    }
    try {
      await launchBot(config, dataProvider, webhookServer);
    } catch (err) {
      console.error(`Failed to launch bot for chain ${config.chainId}:`, err);
    }
  }
}

void run();
