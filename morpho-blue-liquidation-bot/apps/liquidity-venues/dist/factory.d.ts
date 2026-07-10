import type { LiquidityVenueName } from "@morpho-blue-liquidation-bot/config";
import { LiquidityVenue } from "./liquidityVenue";
/**
 * Creates a liquidity venue instance based on the liquidity venue name from config.
 * This factory function avoids circular dependencies by keeping liquidity venue
 * class imports in the client package, while config only exports string identifiers.
 */
export declare function createLiquidityVenue(liquidityVenueName: LiquidityVenueName): LiquidityVenue;
