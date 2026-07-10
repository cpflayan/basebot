import type { Address, Chain, Hex } from "viem";
import { chainConfigs } from "./config";
import type { ChainConfig, DataProviderName, LiquidityVenueName, PricerName } from "./types";
export declare function chainConfig(chainId: number): ChainConfig;
export declare function getSecrets(chainId: number, chain?: Chain): {
    rpcUrl: string;
    executorAddress: Address;
    liquidationPrivateKey: Hex;
};
export * from "./chains";
export { chainConfigs, type ChainConfig, type DataProviderName, type LiquidityVenueName, type PricerName, };
export * from "./dataProviders";
export * from "./liquidityVenues";
export * from "./pricers";
export { POSITION_LIQUIDATION_COOLDOWN_PERIOD, POSITION_LIQUIDATION_COOLDOWN_ENABLED, MARKETS_FETCHING_COOLDOWN_PERIOD, ALWAYS_REALIZE_BAD_DEBT, loadApprovedMarketIds, } from "./config";
