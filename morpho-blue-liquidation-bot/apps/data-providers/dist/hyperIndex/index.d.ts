import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import type { DataProvider, LiquidatablePositionsResult } from "../dataProvider";
export interface HyperIndexDataProviderOptions {
    /** URL of an externally hosted HyperIndex instance. If set, selfhost is skipped. */
    url?: string;
}
export declare class HyperIndexDataProvider implements DataProvider {
    private readonly graphqlClient;
    private readonly url;
    private readonly selfhost;
    private indexerProcess?;
    constructor(options?: HyperIndexDataProviderOptions);
    init(): Promise<void>;
    fetchMarkets(client: Client<Transport, Chain, Account>, vaults: Address[]): Promise<Hex[]>;
    fetchLiquidatablePositions(client: Client<Transport, Chain, Account>, marketIds: Hex[]): Promise<LiquidatablePositionsResult>;
    private getChainTip;
    private waitForReady;
}
