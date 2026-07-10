import { erc4626Abi, zeroAddress } from "viem";
import { readContract } from "viem/actions";
export class Erc4626 {
    underlying = {};
    async supportsRoute(encoder, src, dst) {
        if (src === dst)
            return false;
        if (this.underlying[src] !== undefined) {
            return this.underlying[src] !== zeroAddress;
        }
        try {
            const underlying = await readContract(encoder.client, {
                address: src,
                abi: erc4626Abi,
                functionName: "asset",
            });
            this.underlying[src] = underlying;
            return underlying !== zeroAddress;
        }
        catch {
            this.underlying[src] = zeroAddress;
            return false;
        }
    }
    async convert(encoder, toConvert) {
        const { src, dst, srcAmount } = toConvert;
        const underlying = this.underlying[src];
        if (underlying === undefined) {
            return toConvert;
        }
        try {
            const withdrawAmount = await readContract(encoder.client, {
                address: src,
                abi: erc4626Abi,
                functionName: "previewRedeem",
                args: [srcAmount],
            });
            if (withdrawAmount === 0n)
                return toConvert;
            encoder.erc4626Redeem(src, srcAmount, encoder.address, encoder.address);
            return { src: underlying, dst, srcAmount: withdrawAmount };
        }
        catch (error) {
            throw new Error(`(ERC4626) Error previewing redeem: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
