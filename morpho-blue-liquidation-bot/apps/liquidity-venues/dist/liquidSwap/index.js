import { LIQUID_SWAP_SUPPORTED_NETWORKS } from "@morpho-blue-liquidation-bot/config";
import { erc20Abi, parseUnits } from "viem";
import { readContract } from "viem/actions";
export class LiquidSwapVenue {
    assetsDecimals = {};
    baseApiUrl = "https://api.liqd.ag/v2/route";
    supportsRoute(encoder, src, dst) {
        if (src === dst)
            return false;
        return LIQUID_SWAP_SUPPORTED_NETWORKS.includes(encoder.client.chain.id);
    }
    async convert(encoder, toConvert) {
        const { src, dst, srcAmount } = toConvert;
        try {
            const srcDecimals = await this.getAssetsDecimals(encoder.client, src);
            const url = this.apiUrl(src, dst, Math.floor(Number(srcAmount) / 10 ** srcDecimals));
            const response = await fetch(url);
            const data = (await response.json());
            if (!data.success || !data.execution) {
                throw new Error("failed to fetch liquid swap route");
            }
            encoder.erc20Approve(src, data.execution.to, srcAmount);
            encoder.pushCall(data.execution.to, 0n, data.execution.calldata);
            return {
                src: dst,
                dst,
                srcAmount: parseUnits(data.amountOut, data.tokens.tokenOut.decimals),
            };
        }
        catch (error) {
            console.error("failed to fetch assets decimals or liquid swap route", error);
            return toConvert;
        }
    }
    apiUrl(src, dst, amount) {
        return `${this.baseApiUrl}?tokenIn=${src}&tokenOut=${dst}&amountIn=${amount}`;
    }
    async getAssetsDecimals(client, asset) {
        const chainId = client.chain.id;
        this.assetsDecimals[chainId] ??= {};
        const chainDecimals = this.assetsDecimals[chainId];
        if (chainDecimals[asset] === undefined) {
            chainDecimals[asset] = await readContract(client, {
                address: asset,
                abi: erc20Abi,
                functionName: "decimals",
            });
        }
        return chainDecimals[asset];
    }
}
