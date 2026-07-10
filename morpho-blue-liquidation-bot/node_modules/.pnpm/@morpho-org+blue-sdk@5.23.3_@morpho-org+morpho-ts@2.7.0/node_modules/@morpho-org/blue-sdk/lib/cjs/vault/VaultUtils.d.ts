import { type RoundingDirection } from "../math/index.js";
import type { BigIntish } from "../types.js";
export declare namespace VaultUtils {
    const VIRTUAL_ASSETS = 1n;
    function decimalsOffset(decimals: BigIntish): bigint;
    function toAssets(shares: BigIntish, { totalAssets, totalSupply, decimalsOffset, }: {
        totalAssets: BigIntish;
        totalSupply: BigIntish;
        decimalsOffset: BigIntish;
    }, rounding?: RoundingDirection): bigint;
    function toShares(assets: BigIntish, { totalAssets, totalSupply, decimalsOffset, }: {
        totalAssets: BigIntish;
        totalSupply: BigIntish;
        decimalsOffset: BigIntish;
    }, rounding?: RoundingDirection): bigint;
}
