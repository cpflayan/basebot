import type { Config } from "./types";
export declare function loadApprovedMarketIds(chainId: number): `0x${string}`[];
export declare const ALWAYS_REALIZE_BAD_DEBT = false;
export declare const MARKETS_FETCHING_COOLDOWN_PERIOD: number;
export declare const POSITION_LIQUIDATION_COOLDOWN_ENABLED = true;
export declare const POSITION_LIQUIDATION_COOLDOWN_PERIOD: number;
export declare const chainConfigs: Record<number, Config>;
