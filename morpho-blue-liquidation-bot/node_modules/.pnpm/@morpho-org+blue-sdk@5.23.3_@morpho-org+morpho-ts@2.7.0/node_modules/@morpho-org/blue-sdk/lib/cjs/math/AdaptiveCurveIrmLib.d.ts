import type { BigIntish } from "../types.js";
/**
 * JS implementation of {@link https://github.com/morpho-org/morpho-blue-irm/blob/main/src/libraries/adaptive-curve/ExpLib.sol ExpLib} used by the Adaptive Curve IRM.
 */
export declare namespace AdaptiveCurveIrmLib {
    const CURVE_STEEPNESS = 4000000000000000000n;
    const TARGET_UTILIZATION = 900000000000000000n;
    const INITIAL_RATE_AT_TARGET: bigint;
    const ADJUSTMENT_SPEED: bigint;
    const MIN_RATE_AT_TARGET: bigint;
    const MAX_RATE_AT_TARGET: bigint;
    /**
     * ln(2), scaled by WAD.
     */
    const LN_2_INT = 693147180559945309n;
    /**
     * ln(1e-18), scaled by WAD.
     */
    const LN_WEI_INT = -41446531673892822312n;
    /**
     * Above this bound, `wExp` is clipped to avoid overflowing when multiplied with 1 ether.
     * This upper bound corresponds to: ln(type(int256).max / 1e36) (scaled by WAD, floored).
     */
    const WEXP_UPPER_BOUND = 93859467695000404319n;
    /**
     * The value of wExp(`WEXP_UPPER_BOUND`).
     */
    const WEXP_UPPER_VALUE = 57716089161558943949701069502944508345128422502756744429568n;
    /**
     * Returns an approximation of exp(x) used by the Adaptive Curve IRM.
     * @param x
     */
    function wExp(x: BigIntish): bigint;
    function getBorrowRate(startUtilization: BigIntish, startRateAtTarget: BigIntish, elapsed: BigIntish): {
        avgBorrowRate: bigint;
        endBorrowRate: bigint;
        endRateAtTarget: bigint;
    };
    function getUtilizationAtBorrowRate(borrowRate: BigIntish, rateAtTarget: BigIntish): bigint;
}
