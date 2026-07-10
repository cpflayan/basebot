"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SECONDS_PER_YEAR = exports.DEFAULT_SLIPPAGE_TOLERANCE = exports.ORACLE_PRICE_SCALE = exports.MAX_LIQUIDATION_INCENTIVE_FACTOR = exports.LIQUIDATION_CURSOR = void 0;
const morpho_ts_1 = require("@morpho-org/morpho-ts");
/**
 * The liquidation cursor used to calculate the liquidation incentive. Hardcoded to 30%.
 */
exports.LIQUIDATION_CURSOR = 300000000000000000n;
/**
 * The maximum liquidation incentive factor. Hardcoded to 115%.
 */
exports.MAX_LIQUIDATION_INCENTIVE_FACTOR = 1150000000000000000n;
/**
 * The scale of the oracle price. Hardcoded to 1e36.
 */
exports.ORACLE_PRICE_SCALE = 1000000000000000000000000000000000000n;
/**
 * The default slippage tolerance used in the SDK. Hardcoded to 0.03%.
 */
exports.DEFAULT_SLIPPAGE_TOLERANCE = 300000000000000n;
/**
 * The number of seconds in a year.
 */
exports.SECONDS_PER_YEAR = morpho_ts_1.Time.s.from.y(1n);
