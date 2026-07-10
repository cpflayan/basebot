import { type RoundingDirection } from "../math/index.js";
import type { Address, BigIntish } from "../types.js";
import type { IToken } from "./Token.js";
import { WrappedToken } from "./WrappedToken.js";
export declare class ConstantWrappedToken extends WrappedToken {
    readonly underlyingDecimals: bigint;
    constructor(token: IToken, underlying: Address, underlyingDecimals?: BigIntish);
    toWrappedExactAmountIn(unwrappedAmount: bigint, _slippage?: bigint, rounding?: RoundingDirection): bigint;
    /** The amount of unwrappedTokens that should be wrapped to receive `wrappedAmount` */
    toWrappedExactAmountOut(wrappedAmount: bigint, _slippage?: bigint, rounding?: RoundingDirection): bigint;
    /** The expected amount when unwrapping `wrappedAmount` */
    toUnwrappedExactAmountIn(wrappedAmount: bigint, _slippage?: bigint, rounding?: RoundingDirection): bigint;
    /** The amount of wrappedTokens that should be unwrapped to receive `unwrappedAmount` */
    toUnwrappedExactAmountOut(unwrappedAmount: bigint, _slippage?: bigint, rounding?: RoundingDirection): bigint;
    protected _wrap(amount: bigint): bigint;
    protected _unwrap(amount: bigint): bigint;
}
