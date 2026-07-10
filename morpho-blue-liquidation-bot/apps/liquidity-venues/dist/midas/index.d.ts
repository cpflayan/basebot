import { type ExecutorEncoder } from "executooor-viem";
import { type Address } from "viem";
import type { LiquidityVenue } from "../liquidityVenue";
import type { ToConvert } from "../types";
import { PreviewRedeemInstantParams } from "./types";
export declare class MidasVenue implements LiquidityVenue {
    supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address): boolean;
    convert(encoder: ExecutorEncoder, toConvert: ToConvert): Promise<{
        src: `0x${string}`;
        srcAmount: bigint;
        dst: `0x${string}`;
    }>;
    private isMidasToken;
    private postRedeemToken;
    private redemptionVault;
    previewRedeemInstant(params: PreviewRedeemInstantParams): {
        amountTokenOutWithoutFee: bigint;
        feeAmount: bigint;
    };
    private _calcAndValidateRedeem;
    private _getFeeAmount;
    private _requireAndUpdateLimit;
    private _convertMTokenToUsd;
    private _convertUsdToToken;
    private _truncate;
    private _convertFromBase18;
    private _convertToBase18;
    private _convert;
    getRedemptionParams(vault: Address, tokenOut: Address, seizedCollateral: bigint, encoder: ExecutorEncoder): Promise<PreviewRedeemInstantParams>;
    getMidasRate(dataFeed: Address, encoder: ExecutorEncoder): Promise<bigint>;
}
