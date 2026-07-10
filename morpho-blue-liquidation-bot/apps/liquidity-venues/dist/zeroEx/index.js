import { ZERO_EX_API_BASE_URL, zeroExSlippageBps, zeroExSupportedNetworks, } from "@morpho-blue-liquidation-bot/config";
export class ZeroEx {
    apiKey;
    constructor() {
        this.apiKey = process.env.ZERO_EX_API_KEY;
    }
    supportsRoute(encoder, src, dst) {
        if (src === dst)
            return false;
        if (!zeroExSupportedNetworks.includes(encoder.client.chain.id))
            return false;
        return this.apiKey !== undefined;
    }
    async convert(encoder, toConvert) {
        try {
            const swapResponse = await this.fetchSwap({
                chainId: encoder.client.chain.id,
                sellToken: toConvert.src,
                buyToken: toConvert.dst,
                sellAmount: toConvert.srcAmount,
                taker: encoder.address,
                txOrigin: encoder.client.account.address,
                slippageBps: zeroExSlippageBps,
            });
            if (!swapResponse.liquidityAvailable) {
                throw new Error("no liquidity available");
            }
            const spender = swapResponse.issues?.allowance?.spender ?? swapResponse.transaction.to;
            encoder
                .erc20Approve(toConvert.src, spender, toConvert.srcAmount)
                .pushCall(swapResponse.transaction.to, BigInt(swapResponse.transaction.value), swapResponse.transaction.data);
            /// assumed to be the last liquidity venue
            return {
                src: toConvert.dst,
                dst: toConvert.dst,
                srcAmount: 0n,
            };
        }
        catch (error) {
            throw new Error(`(0x) Error fetching swap response: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async fetchSwap(swapParams) {
        const url = new URL("/swap/allowance-holder/quote", ZERO_EX_API_BASE_URL);
        Object.entries(swapParams).forEach(([key, value]) => {
            if (value == null)
                return;
            url.searchParams.set(key, String(value));
        });
        const res = await fetch(url, {
            headers: {
                accept: "application/json",
                "0x-api-key": this.apiKey ?? "",
                "0x-version": "v2",
            },
        });
        if (!res.ok)
            throw Error(`${res.status} ${res.statusText}`);
        return (await res.json());
    }
}
