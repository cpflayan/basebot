import { PricerName } from "@morpho-blue-liquidation-bot/config";
import { Pricer } from "./pricer";
/**
 * Creates a pricer instance based on the pricer name from config.
 * This factory function avoids circular dependencies by keeping pricer
 * class imports in the client package, while config only exports string identifiers.
 */
export declare function createPricer(pricerName: PricerName): Pricer;
