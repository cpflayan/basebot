import type { ExecutorEncoder } from "executooor-viem";
import { type Address } from "viem";
import type { LiquidityVenue } from "../liquidityVenue";
import type { ToConvert } from "../types";
export declare class Erc20Wrapper implements LiquidityVenue {
    private underlying;
    supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address): boolean;
    convert(encoder: ExecutorEncoder, toConvert: ToConvert): ToConvert;
    private getUnderlying;
}
