import type { DataProviderName } from "@morpho-blue-liquidation-bot/config";
import type { DataProvider } from "./dataProvider";
/**
 * Creates data providers for the given chains.
 * Returns a Map from chainId to DataProvider.
 * Multi-chain providers (morphoApi, hyperIndex) share a single instance across all chains.
 */
export declare function createDataProviders(dataProviderName: DataProviderName, chainIds: number[]): Promise<Map<number, DataProvider>>;
