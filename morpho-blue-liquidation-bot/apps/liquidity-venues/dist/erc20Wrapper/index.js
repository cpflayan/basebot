import { wrappers } from "@morpho-blue-liquidation-bot/config";
import { zeroAddress } from "viem";
export class Erc20Wrapper {
    underlying = {};
    supportsRoute(encoder, src, dst) {
        if (src === dst)
            return false;
        if (this.underlying[src] !== undefined) {
            return this.underlying[src] !== zeroAddress;
        }
        const underlying = this.getUnderlying(src, encoder.client.chain.id);
        this.underlying[src] = underlying ?? zeroAddress;
        return this.underlying[src] !== zeroAddress;
    }
    convert(encoder, toConvert) {
        const { src, dst, srcAmount } = toConvert;
        const underlying = this.underlying[src];
        if (underlying === undefined) {
            return toConvert;
        }
        encoder.erc20WrapperWithdrawTo(src, encoder.address, srcAmount);
        return { src: underlying, dst, srcAmount };
    }
    getUnderlying(src, chainId) {
        return wrappers[chainId]?.[src];
    }
}
