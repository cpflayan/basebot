import type { Account, Address, Chain, Client, Transport } from "viem";
import type { Pricer } from "../pricer";
export declare class DefiLlamaPricer implements Pricer {
    private priceCache;
    private readonly cacheTimeoutMs;
    price(client: Client<Transport, Chain, Account>, asset: Address): Promise<number | undefined>;
    private fetchPrice;
    private getCoinKey;
}
