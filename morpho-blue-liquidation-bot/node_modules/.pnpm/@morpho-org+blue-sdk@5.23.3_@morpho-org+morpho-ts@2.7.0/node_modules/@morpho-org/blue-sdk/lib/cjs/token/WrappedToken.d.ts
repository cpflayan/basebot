import { type RoundingDirection } from "../math/index.js";
import type { Address } from "../types.js";
import { type IToken, Token } from "./Token.js";
export declare abstract class WrappedToken extends Token {
    readonly underlying: Address;
    constructor(token: IToken, underlying: Address);
    /** The expected amount when wrapping `unwrappedAmount` */
    toWrappedExactAmountIn(unwrappedAmount: bigint, slippage?: bigint, rounding?: RoundingDirection): bigint;
    /** The amount of unwrappedTokens that should be wrapped to receive `wrappedAmount` */
    toWrappedExactAmountOut(wrappedAmount: bigint, slippage?: bigint, rounding?: RoundingDirection): bigint;
    /** The expected amount when unwrapping `wrappedAmount` */
    toUnwrappedExactAmountIn(wrappedAmount: bigint, slippage?: bigint, rounding?: RoundingDirection): bigint;
    /** The amount of wrappedTokens that should be unwrapped to receive `unwrappedAmount` */
    toUnwrappedExactAmountOut(unwrappedAmount: bigint, slippage?: bigint, rounding?: RoundingDirection): bigint;
    protected abstract _wrap(amount: bigint, rounding: RoundingDirection): bigint;
    protected abstract _unwrap(amount: bigint, rounding: RoundingDirection): bigint;
}
