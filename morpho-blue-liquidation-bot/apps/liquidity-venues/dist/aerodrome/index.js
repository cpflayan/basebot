import { AERODROME_FACTORY } from "@morpho-blue-liquidation-bot/config";
import { encodeFunctionData, erc20Abi, fromHex, zeroAddress } from "viem";
import { readContract } from "viem/actions";
import { aerodromeFactoryAbi, aerodromePoolAbi } from "../abis/aerodrome";
export class AerodromeVenue {
    pools = {};
    async supportsRoute(encoder, src, dst) {
        if (src === dst)
            return false;
        const pool = this.getCachedPool(src, dst) ?? (await this.fetchPool(encoder, src, dst));
        return pool !== null;
    }
    async convert(encoder, toConvert) {
        const { src, dst, srcAmount } = toConvert;
        const poolInfo = this.getCachedPool(src, dst);
        if (poolInfo === undefined || poolInfo === null) {
            return toConvert;
        }
        try {
            const pool = poolInfo.address;
            // Determine token ordering
            const isSrcToken0 = fromHex(src, "bigint") < fromHex(dst, "bigint");
            const amount0Out = isSrcToken0 ? 0n : srcAmount;
            const amount1Out = isSrcToken0 ? srcAmount : 0n;
            // Step 1: Transfer collateral to the pool
            encoder.pushCall(src, 0n, encodeFunctionData({
                abi: erc20Abi,
                functionName: "transfer",
                args: [pool, srcAmount],
            }));
            // Step 2: Call pool.swap - Solidly style
            // swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)
            encoder.pushCall(pool, 0n, encodeFunctionData({
                abi: aerodromePoolAbi,
                functionName: "swap",
                args: [amount0Out, amount1Out, encoder.address, "0x"],
            }));
            // Assumed to be the last liquidity venue
            return {
                src: dst,
                dst: dst,
                srcAmount: 0n,
            };
        }
        catch (error) {
            throw new Error(`(Aerodrome) Error swapping: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    getCachedPool(src, dst) {
        if (this.pools[src]?.[dst] !== undefined)
            return this.pools[src][dst];
        if (this.pools[dst]?.[src] !== undefined)
            return this.pools[dst][src];
        return undefined;
    }
    async fetchPool(encoder, src, dst) {
        const factoryAddress = AERODROME_FACTORY[encoder.client.chain.id];
        if (!factoryAddress) {
            return null;
        }
        try {
            // Check both volatile (false) and stable (true) pools
            const [volatilePool, stablePool] = await Promise.all([
                readContract(encoder.client, {
                    address: factoryAddress,
                    abi: aerodromeFactoryAbi,
                    functionName: "getPool",
                    args: [src, dst, false],
                }),
                readContract(encoder.client, {
                    address: factoryAddress,
                    abi: aerodromeFactoryAbi,
                    functionName: "getPool",
                    args: [src, dst, true],
                }),
            ]);
            // Prefer volatile pool (more liquidity typically), fallback to stable
            let poolInfo = null;
            if (volatilePool !== zeroAddress) {
                poolInfo = { address: volatilePool, stable: false };
            }
            else if (stablePool !== zeroAddress) {
                poolInfo = { address: stablePool, stable: true };
            }
            // Cache the result
            if (this.pools[src]?.[dst] === undefined) {
                this.pools[src] = { ...this.pools[src], [dst]: poolInfo };
            }
            return poolInfo;
        }
        catch (error) {
            throw new Error(`(Aerodrome) Error fetching pool: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
