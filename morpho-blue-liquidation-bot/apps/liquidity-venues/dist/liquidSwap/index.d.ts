import { ExecutorEncoder } from "executooor-viem";
import { Address } from "viem";
import { LiquidityVenue } from "../liquidityVenue";
import { ToConvert } from "../types";
export declare class LiquidSwapVenue implements LiquidityVenue {
    private assetsDecimals;
    private baseApiUrl;
    supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address): boolean;
    convert(encoder: ExecutorEncoder, toConvert: ToConvert): Promise<ToConvert>;
    private apiUrl;
    private getAssetsDecimals;
}
