import { type Account, type Address, type Chain, type Client, type Transport } from "viem";
import type { Pricer } from "../pricer";
export declare class UniswapV3Pricer implements Pricer {
    private pools;
    private decimals;
    price(client: Client<Transport, Chain, Account>, asset: Address): Promise<number | undefined>;
    private getCachedPools;
    private fetchPools;
    private getDecimals;
}
