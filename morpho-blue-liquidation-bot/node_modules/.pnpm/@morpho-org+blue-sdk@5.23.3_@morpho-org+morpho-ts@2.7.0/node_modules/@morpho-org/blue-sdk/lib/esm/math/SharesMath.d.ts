import type { BigIntish } from "../types.js";
import { type RoundingDirection } from "./MathLib.js";
/**
 * JS implementation of {@link https://github.com/morpho-org/morpho-blue/blob/main/src/libraries/SharesMathLib.sol SharesMathLib} used by Morpho Blue
 * & MetaMorpho (via {@link https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/token/ERC20/extensions/ERC4626.sol ERC4626}).
 */
export declare namespace SharesMath {
    const VIRTUAL_SHARES = 1000000n;
    const VIRTUAL_ASSETS = 1n;
    function toAssets(shares: BigIntish, totalAssets: BigIntish, totalShares: BigIntish, rounding: RoundingDirection): bigint;
    function toShares(assets: BigIntish, totalAssets: BigIntish, totalShares: BigIntish, rounding: RoundingDirection): bigint;
}
