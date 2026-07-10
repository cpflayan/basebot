import type { Account, Address, Chain, Client, Transport } from "viem";
import type { Pricer } from "../pricer";
export declare class MorphoApi implements Pricer {
    private readonly API_URL;
    private supportedChains;
    private initialized;
    price(client: Client<Transport, Chain, Account>, asset: Address): Promise<number | undefined>;
    private initialize;
    private query;
}
