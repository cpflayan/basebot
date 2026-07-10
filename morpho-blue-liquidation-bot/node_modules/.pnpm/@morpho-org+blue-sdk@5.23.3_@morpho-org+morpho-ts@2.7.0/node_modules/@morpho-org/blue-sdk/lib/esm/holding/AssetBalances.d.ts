import type { Token } from "../token/Token.js";
export type PeripheralBalanceType = "base" | "wrapped" | "staked-wrapped" | "vault" | "wrapped-vault" | "unwrapped-staked-wrapped";
/**
 * Represents the balance of a requested token and the balance quoted in the corresponding source token:
 * ```{
 *  type: "staked-wrapped",
 *  srcToken: ETH,
 *  srcAmount: 1 ETH,
 *  dstAmount: 1.2 wstETH
 * }```
 */
export interface PeripheralBalance {
    /**
     * The type of balance conversion.
     */
    type: PeripheralBalanceType;
    /**
     * The source token held corresponding to the type of balance conversion.
     */
    srcToken: Token;
    /**
     * The source amount of source token held.
     */
    srcAmount: bigint;
    /**
     * The corresponding amount of token held after conversion of the whole balance `srcAmount`.
     */
    dstAmount: bigint;
}
export interface IAssetBalances extends Omit<PeripheralBalance, "type"> {
}
export declare class AssetBalances {
    /**
     * The total balance of all types of related tokens.
     */
    total: bigint;
    /**
     * The balance of each type of related tokens and the corresponding underlying balance.
     */
    allocations: {
        base: PeripheralBalance;
    } & {
        [T in Exclude<PeripheralBalanceType, "base">]?: PeripheralBalance;
    };
    constructor(balance: IAssetBalances);
    add(balance: PeripheralBalance): this;
    sub(balance: PeripheralBalance): this;
}
