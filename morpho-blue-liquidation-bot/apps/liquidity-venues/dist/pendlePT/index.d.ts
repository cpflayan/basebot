import { type ExecutorEncoder } from "executooor-viem";
import { type Address } from "viem";
import type { LiquidityVenue } from "../liquidityVenue";
import type { ToConvert } from "../types";
export declare class PendlePTVenue implements LiquidityVenue {
    private pendleMarkets;
    private lastPoolRefresh;
    supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address): Promise<boolean>;
    convert(encoder: ExecutorEncoder, toConvert: ToConvert): Promise<{
        src: `0x${string}`;
        dst: `0x${string}`;
        srcAmount: bigint;
    }>;
    private redeemPToUnderlying;
    private swapPTToUnderlying;
    private isPT;
}
