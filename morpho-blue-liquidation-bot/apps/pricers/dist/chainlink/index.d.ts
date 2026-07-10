import { type Account, type Address, type Chain, type Client, type Transport } from "viem";
import type { Pricer } from "../pricer";
export declare class ChainlinkPricer implements Pricer {
    private readonly CACHE_TIMEOUT_MS;
    private priceCache;
    price(client: Client<Transport, Chain, Account>, asset: Address): Promise<number | undefined>;
}
