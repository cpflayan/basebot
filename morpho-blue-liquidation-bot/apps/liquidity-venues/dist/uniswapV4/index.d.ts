import type { ExecutorEncoder } from "executooor-viem";
import { type Address } from "viem";
import type { LiquidityVenue } from "../liquidityVenue";
import type { ToConvert } from "../types";
export declare class UniswapV4Venue implements LiquidityVenue {
    private STALE_TIME;
    private poolCreationEventsCache;
    supportsRoute(encoder: ExecutorEncoder, _src: Address, _dst: Address): Promise<boolean> | boolean;
    convert(encoder: ExecutorEncoder, toConvert: ToConvert): Promise<ToConvert>;
    private fetchPools;
}
