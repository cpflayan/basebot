import type { ExecutorEncoder } from "executooor-viem";
import { type Address } from "viem";
import type { LiquidityVenue } from "../liquidityVenue";
import type { ToConvert } from "../types";
export declare class AerodromeVenue implements LiquidityVenue {
    private pools;
    supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address): Promise<boolean>;
    convert(encoder: ExecutorEncoder, toConvert: ToConvert): Promise<ToConvert>;
    private getCachedPool;
    private fetchPool;
}
