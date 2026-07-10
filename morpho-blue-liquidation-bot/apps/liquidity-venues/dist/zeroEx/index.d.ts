import { ExecutorEncoder } from "executooor-viem";
import { Address } from "viem";
import { LiquidityVenue } from "../liquidityVenue";
import { ToConvert } from "../types";
export declare class ZeroEx implements LiquidityVenue {
    private apiKey;
    constructor();
    supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address): boolean;
    convert(encoder: ExecutorEncoder, toConvert: ToConvert): Promise<{
        src: `0x${string}`;
        dst: `0x${string}`;
        srcAmount: bigint;
    }>;
    private fetchSwap;
}
