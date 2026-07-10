import { type ChainId } from "../chain.js";
import { type RoundingDirection } from "../math/index.js";
import type { Address, BigIntish } from "../types.js";
import type { Eip5267Domain } from "./Eip5267Domain.js";
export interface IToken {
    address: Address;
    name?: string;
    symbol?: string;
    decimals?: BigIntish;
    price?: BigIntish;
    eip5267Domain?: Eip5267Domain;
}
export declare class Token implements IToken {
    static native(chainId: ChainId): Token;
    /**
     * The token's address.
     */
    readonly address: Address;
    /**
     * The token's name.
     */
    readonly name?: string;
    /**
     * The token's symbol.
     */
    readonly symbol?: string;
    /**
     * The token's number of decimals. Defaults to 0.
     */
    readonly decimals: number;
    /**
     * The eip712 domain of the token if it can be directly queried onchain
     */
    readonly eip5267Domain?: Eip5267Domain;
    /**
     * Price of the token in USD (scaled by WAD).
     */
    price?: bigint;
    constructor({ address, name, symbol, decimals, price, eip5267Domain, }: IToken);
    /**
     * Quotes an amount in USD (scaled by WAD) in this token.
     * Returns `undefined` iff the token's price is undefined.
     * @param amount The amount of USD to quote.
     */
    fromUsd(amount: bigint, rounding?: RoundingDirection): bigint | undefined;
    /**
     * Quotes an amount of tokens in USD (scaled by WAD).
     * Returns `undefined` iff the token's price is undefined.
     * @param amount The amount of tokens to quote.
     */
    toUsd(amount: bigint, rounding?: RoundingDirection): bigint | undefined;
}
