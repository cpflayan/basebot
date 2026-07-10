import { type RoundingDirection } from "../math/index.js";
import type { Address } from "../types.js";
import type { IToken } from "./Token.js";
import { WrappedToken } from "./WrappedToken.js";
export declare class ExchangeRateWrappedToken extends WrappedToken {
    readonly underlying: Address;
    wrappedTokenExchangeRate: bigint;
    constructor(token: IToken, underlying: Address, wrappedTokenExchangeRate: bigint);
    protected _wrap(amount: bigint, rounding: RoundingDirection): bigint;
    protected _unwrap(amount: bigint, rounding: RoundingDirection): bigint;
}
