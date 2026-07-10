import { HyperIndexDataProvider } from "./hyperIndex";
import { MorphoApiDataProvider } from "./morphoApi";
/**
 * Creates data providers for the given chains.
 * Returns a Map from chainId to DataProvider.
 * Multi-chain providers (morphoApi, hyperIndex) share a single instance across all chains.
 */
export async function createDataProviders(dataProviderName, chainIds) {
    let provider;
    switch (dataProviderName) {
        case "morphoApi":
            provider = new MorphoApiDataProvider();
            break;
        case "hyperIndex":
            provider = new HyperIndexDataProvider();
            break;
        default:
            throw new Error(`Unknown data provider: ${dataProviderName}`);
    }
    if (provider.init) {
        await provider.init();
    }
    const map = new Map();
    for (const chainId of chainIds) {
        map.set(chainId, provider);
    }
    return map;
}
