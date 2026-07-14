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

/**
 * Slippage tolerance applied on top of the quoted getAmountOut.
 * getAmountOut is a point-in-time read; between that RPC and the actual
 * swap execution (simulation or on-chain) reserves may shift slightly.
 * 0.5% buffer prevents InsufficientOutputAmount reverts from minor reserve drift.
 */
const AERODROME_SLIPPAGE_BPS = 50n; // 0.5%

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

      // Solidly/Aerodrome swap requires amount0Out or amount1Out > 0.
      // Passing (0,0) reverts or is a no-op — never treat it as a successful conversion
      // (that dead-ends the venue chain and caches a broken route).
      const [token0, amountOut] = await Promise.all([
        readContract(encoder.client, {
          address: pool,
          abi: aerodromePoolAbi,
          functionName: "token0",
        }),
        readContract(encoder.client, {
          address: pool,
          abi: aerodromePoolAbi,
          functionName: "getAmountOut",
          args: [srcAmount, src],
        }),
      ]);

      if (amountOut === 0n) {
        this.lastImpactBps = undefined;
        // Fail closed: leave toConvert unchanged so hop continues to next venue
        return toConvert;
      }

      // SECURITY (C2): no protocol-level minAmountOut on swap(). Use reserves as a
      // proxy for price impact so the caller can size a dynamic slippage margin.
      // Constant-product approximation over-estimates impact on stable pools (safe).
      const [reserve0, reserve1] = await readContract(encoder.client, {
        address: pool,
        abi: aerodromePoolAbi,
        functionName: "getReserves",
      });
      const srcIsToken0 = src.toLowerCase() === token0.toLowerCase();
      const srcReserve = srcIsToken0 ? reserve0 : reserve1;
      this.lastImpactBps =
        srcReserve > 0n ? (srcAmount * BPS_DENOMINATOR) / (srcReserve + srcAmount) : undefined;

      // Apply slippage tolerance to the quoted output to prevent
      // InsufficientOutputAmount() reverts from minor reserve drift between
      // the getAmountOut read and the actual swap execution.
      const minAmountOut =
        (amountOut * (BPS_DENOMINATOR - AERODROME_SLIPPAGE_BPS)) / BPS_DENOMINATOR;

      const amount0Out = srcIsToken0 ? 0n : minAmountOut;
      const amount1Out = srcIsToken0 ? minAmountOut : 0n;

      // Step 1: Transfer input token to the pool
      encoder.pushCall(
        src,
        0n,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [pool, srcAmount],
        }),
      );

      // Step 2: swap(amount0Out, amount1Out, to, data) — exact Solidly style
      encoder.pushCall(
        pool,
        0n,
        encodeFunctionData({
          abi: aerodromePoolAbi,
          functionName: "swap",
          args: [amount0Out, amount1Out, encoder.address, "0x"],
        }),
      );

      return {
        src: dst,
        dst: dst,
        srcAmount: amountOut,
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
