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

const BPS_DENOMINATOR = 10_000n;

export class AerodromeVenue implements LiquidityVenue {
  private pools: Record<Address, Record<Address, PoolInfo | null>> = {};
  // SECURITY (C2): set as a byproduct of convert(), consumed by estimatePriceImpactBps()
  private lastImpactBps: bigint | undefined;

  async supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address) {
    if (src === dst) return false;

    const pool = this.getCachedPool(src, dst) ?? (await this.fetchPool(encoder, src, dst));

    return pool !== null;
  }

  async convert(encoder: ExecutorEncoder, toConvert: ToConvert) {
    const { src, dst, srcAmount } = toConvert;

    const poolInfo = this.getCachedPool(src, dst);

    if (poolInfo === undefined || poolInfo === null) {
      this.lastImpactBps = undefined;
      return toConvert;
    }

    try {
      const pool = poolInfo.address;

      // SECURITY (C2): pool.swap() below passes amount0Out=0, amount1Out=0 — no
      // protocol-level minAmountOut. Fetch reserves as a proxy for price impact so
      // the caller can size a dynamic slippage margin instead of a flat guess.
      // NOTE: this is a constant-product (x*y=k) approximation. Aerodrome "stable"
      // pools use a different curve (x^3*y + y^3*x = k), which has lower slippage
      // near the peg — so for stable pools this over-estimates impact. That's the
      // safe direction to be wrong in (bigger margin, not a false sense of safety).
      const [reserve0, reserve1] = await readContract(encoder.client, {
        address: pool,
        abi: aerodromePoolAbi,
        functionName: "getReserves",
      });
      const token0 = await readContract(encoder.client, {
        address: pool,
        abi: aerodromePoolAbi,
        functionName: "token0",
      });
      const srcReserve = src.toLowerCase() === token0.toLowerCase() ? reserve0 : reserve1;
      this.lastImpactBps =
        srcReserve > 0n ? (srcAmount * BPS_DENOMINATOR) / (srcReserve + srcAmount) : undefined;

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

  estimatePriceImpactBps(): bigint | undefined {
    return this.lastImpactBps;
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
