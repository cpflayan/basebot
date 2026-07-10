import "@morpho-org/blue-sdk-viem/lib/augment";
import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import type { DataProvider, LiquidatablePositionsResult } from "../dataProvider";
export declare class MorphoApiDataProvider implements DataProvider {
    fetchMarkets(client: Client<Transport, Chain, Account>, vaults: Address[]): Promise<Hex[]>;
    fetchLiquidatablePositions(client: Client<Transport, Chain, Account>, marketIds: Hex[]): Promise<LiquidatablePositionsResult>;
    private fetchVaultMarkets;
}
