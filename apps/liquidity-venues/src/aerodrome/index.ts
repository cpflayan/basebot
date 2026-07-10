import { AERODROME_FACTORY } from "@morpho-blue-liquidation-bot/config";
import type { ExecutorEncoder } from "executooor-viem";
import { type Address, encodeFunctionData, erc20Abi, zeroAddress } from "viem";
import { readContract } from "viem/actions";

import { aerodromeFactoryAbi, aerodromePoolAbi } from "../abis/aerodrome";
import type { LiquidityVenue } from "../liquidityVenue";
import type { ToConvert } from "../types";

interface PoolInfo {
  address: Address;
  stable: boolean;
}

export class AerodromeVenue implements LiquidityVenue {
  private pools: Record<Address, Record<Address, PoolInfo | null>> = {};

  async supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address) {
    if (src === dst) return false;

    const pool = this.getCachedPool(src, dst) ?? (await this.fetchPool(encoder, src, dst));

    return pool !== null;
  }

  async convert(encoder: ExecutorEncoder, toConvert: ToConvert) {
    const { src, dst, srcAmount } = toConvert;

    const poolInfo = this.getCachedPool(src, dst);

    if (poolInfo === undefined || poolInfo === null) {
      return toConvert;
    }

    try {
      const pool = poolInfo.address;

      // Step 1: Transfer collateral to the pool
      encoder.pushCall(
        src,
        0n,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [pool, srcAmount],
        }),
      );

      // Step 2: Call pool.swap — Solidly style
      // swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)
      // Pass 0, 0 — pool calculates output automatically based on AMM formula
      // (balance0 * balance1 >= reserve0 * reserve1) after the input transfer above.
      encoder.pushCall(
        pool,
        0n,
        encodeFunctionData({
          abi: aerodromePoolAbi,
          functionName: "swap",
          args: [0n, 0n, encoder.address, "0x"],
        }),
      );

      // Assumed to be the last liquidity venue
      return {
        src: dst,
        dst: dst,
        srcAmount: 0n,
      };
    } catch (error) {
      throw new Error(
        `(Aerodrome) Error swapping: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getCachedPool(src: Address, dst: Address): PoolInfo | null | undefined {
    if (this.pools[src]?.[dst] !== undefined) return this.pools[src][dst];
    if (this.pools[dst]?.[src] !== undefined) return this.pools[dst][src];
    return undefined;
  }

  private async fetchPool(
    encoder: ExecutorEncoder,
    src: Address,
    dst: Address,
  ): Promise<PoolInfo | null> {
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
      let poolInfo: PoolInfo | null = null;
      if (volatilePool !== zeroAddress) {
        poolInfo = { address: volatilePool, stable: false };
      } else if (stablePool !== zeroAddress) {
        poolInfo = { address: stablePool, stable: true };
      }

      // Cache the result
      if (this.pools[src]?.[dst] === undefined) {
        this.pools[src] = { ...this.pools[src], [dst]: poolInfo };
      }

      return poolInfo;
    } catch (error) {
      throw new Error(
        `(Aerodrome) Error fetching pool: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
