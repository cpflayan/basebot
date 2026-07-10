import { API_REFRESH_INTERVAL, PENDLE_API_URL, PENDLE_SLIPPAGE, } from "@morpho-blue-liquidation-bot/config";
import { getAddress, maxUint256 } from "viem";
async function getApiData(chainId, endpoint, params, api = "sdk") {
    const queryParams = new URLSearchParams(
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
    const apiPath = api === "sdk" ? `v2/sdk/${chainId}` : `v2/${chainId}`;
    const url = `${PENDLE_API_URL}${apiPath}${endpoint}?${queryParams}`;
    const res = await fetch(url, {
        method: "GET",
        headers: {
            Accept: "application/json",
        },
    });
    if (!res.ok)
        throw new Error(res.statusText);
    return res.json();
}
async function getMarkets(chainId) {
    const url = `${PENDLE_API_URL}v1/markets/all?chainId=${chainId}`;
    const res = await fetch(url, {
        method: "GET",
        headers: {
            accept: "application/json",
        },
    });
    if (!res.ok)
        throw new Error(res.statusText);
    return res.json();
}
async function getSwapCallData(chainId, marketAddress, params) {
    return getApiData(chainId, `/markets/${marketAddress}/swap`, params);
}
async function getRedeemCallData(chainId, params) {
    return getApiData(chainId, "/redeem", params);
}
export class PendlePTVenue {
    pendleMarkets = {};
    lastPoolRefresh = {};
    async supportsRoute(encoder, src, dst) {
        if (src === dst)
            return false;
        if (this.pendleMarkets[encoder.client.chain.id] === undefined ||
            this.lastPoolRefresh[encoder.client.chain.id] === undefined ||
            Date.now() - (this.lastPoolRefresh[encoder.client.chain.id] ?? 0) > API_REFRESH_INTERVAL) {
            try {
                this.pendleMarkets[encoder.client.chain.id] = await getMarkets(encoder.client.chain.id);
                this.lastPoolRefresh[encoder.client.chain.id] = Date.now();
            }
            catch (error) {
                this.lastPoolRefresh[encoder.client.chain.id] = Date.now(); // prevent infinite retries
                throw new Error(`(PendlePT) Error fetching pendle tokens: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return this.isPT(src, encoder.client.chain.id);
    }
    async convert(encoder, toConvert) {
        const { src, dst, srcAmount } = toConvert;
        const chainMarkets = this.pendleMarkets[encoder.client.chain.id];
        if (!chainMarkets)
            throw new Error("(PendlePT) Markets not loaded");
        const pendleMarket = chainMarkets.markets.find((marketInfo) => {
            const ptAddress = marketInfo.pt.split("-")[1];
            return ptAddress === src.toLowerCase();
        });
        if (pendleMarket === undefined) {
            throw Error("Invalid Pendle market result");
        }
        const maturity = pendleMarket.expiry;
        if (!maturity) {
            throw Error("Pendle market not found");
        }
        const underlyingToken = pendleMarket.underlyingAsset.split("-")[1];
        if (!underlyingToken)
            throw new Error("(PendlePT) Invalid underlying asset format");
        let amountOut = 0n;
        if (new Date(maturity) < new Date()) {
            // Pendle market is expired, we can directly redeem the collateral
            // If called before YT's expiry, both PT & YT of equal amounts are needed and will be burned. Else, only PT is needed and will be burned.
            try {
                amountOut = await this.redeemPToUnderlying(encoder, pendleMarket, srcAmount, src, underlyingToken);
            }
            catch (error) {
                throw new Error(`(PendlePT) Error redeeming PT to underlying: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        else {
            // Pendle market is not expired, we need to swap the collateral token (PT) to the underlying token
            try {
                amountOut = await this.swapPTToUnderlying(encoder, pendleMarket, srcAmount, src, underlyingToken);
            }
            catch (error) {
                throw new Error(`(PendlePT) Error swapping PT to underlying: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return {
            src: getAddress(underlyingToken),
            dst,
            srcAmount: amountOut,
        };
    }
    async redeemPToUnderlying(encoder, pendleMarket, srcAmount, src, underlyingToken) {
        const redeemCallData = await getRedeemCallData(encoder.client.chain.id, {
            receiver: encoder.address,
            slippage: PENDLE_SLIPPAGE,
            yt: pendleMarket.yt.split("-")[1] ?? "",
            amountIn: srcAmount.toString(),
            tokenOut: underlyingToken,
            enableAggregator: true,
        });
        encoder
            .erc20Approve(src, redeemCallData.tx.to, maxUint256)
            .pushCall(redeemCallData.tx.to, redeemCallData.tx.value ? BigInt(redeemCallData.tx.value) : 0n, redeemCallData.tx.data);
        return BigInt(redeemCallData.data.amountOut);
    }
    async swapPTToUnderlying(encoder, pendleMarket, srcAmount, src, underlyingToken) {
        const swapCallData = await getSwapCallData(encoder.client.chain.id, pendleMarket.address, {
            receiver: encoder.address,
            slippage: PENDLE_SLIPPAGE,
            tokenIn: src.toLowerCase(),
            tokenOut: underlyingToken,
            amountIn: srcAmount.toString(),
        });
        encoder
            .erc20Approve(src, swapCallData.tx.to, maxUint256)
            .pushCall(swapCallData.tx.to, swapCallData.tx.value ? BigInt(swapCallData.tx.value) : 0n, swapCallData.tx.data);
        return BigInt(swapCallData.data.amountOut);
    }
    isPT(token, chainId) {
        return (this.pendleMarkets[Number(chainId)]?.markets.some((marketInfo) => {
            const ptAddress = marketInfo.pt.split("-")[1];
            return ptAddress === token.toLowerCase();
        }) ?? false);
    }
}
