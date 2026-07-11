import {
  FEE_TIERS,
  DEFAULT_FACTORY_ADDRESS,
  specificFactoryAddresses,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
} from "@morpho-blue-liquidation-bot/config";
import { executorAbi, type ExecutorEncoder } from "executooor-viem";
import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  fromHex,
  zeroAddress,
} from "viem";
import { readContract, multicall } from "viem/actions";

import { uniswapV3FactoryAbi, uniswapV3PoolAbi } from "../abis/uniswapV3";
import type { LiquidityVenue } from "../liquidityVenue";
import type { ToConvert } from "../types";

const Q96 = 2n ** 96n;
const BPS_DENOMINATOR = 10_000n;

export class UniswapV3Venue implements LiquidityVenue {
  private pools: Record<Address, Record<Address, Address[]>> = {};
  // SECURITY (C2): set as a byproduct of convert(), consumed by estimatePriceImpactBps()
  private lastImpactBps: bigint | undefined;

  async supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address) {
    if (src === dst) return false;

    const pools = this.getCachedPools(src, dst) ?? (await this.fetchPools(encoder, src, dst));

    return pools.length > 0;
  }

  async convert(encoder: ExecutorEncoder, toConvert: ToConvert) {
    const { src, dst, srcAmount } = toConvert;

    const pools = this.getCachedPools(src, dst);

    if (pools === undefined) {
      this.lastImpactBps = undefined;
      return toConvert;
    }

    try {
      const liquidityResults = await multicall(encoder.client, {
        contracts: pools.map((pool) => ({
          address: pool,
          abi: uniswapV3PoolAbi,
          functionName: "liquidity" as const,
        })),
        allowFailure: true,
      });

      const liquidities = pools.map((pool, i) => ({
        pool,
        amount: liquidityResults[i]?.status === "success" ? liquidityResults[i].result : 0n,
      }));

      const biggestPool = liquidities.reduce(
        (max, liquidity) => (max !== null && liquidity.amount > max.amount ? liquidity : max),
        liquidities[0] ?? null,
      )?.pool;

      if (!biggestPool) {
        throw new Error("(UniswapV3) No Uniswap pool found");
      }

      // SECURITY (C2): swap() below passes MIN/MAX_SQRT_RATIO — no protocol-level
      // minAmountOut. Approximate price impact from the pool's current liquidity (L)
      // and sqrtPriceX96, using the standard single-tick virtual-reserve formula:
      //   virtualReserve0 = L * Q96 / sqrtPriceX96
      //   virtualReserve1 = L * sqrtPriceX96 / Q96
      // This ignores tick-crossing for large trades, so it under-estimates impact
      // for trades that eat through the active tick's liquidity — treat it as a
      // floor, not an exact figure.
      const liquidity = liquidities.find((l) => l.pool === biggestPool)?.amount ?? 0n;
      const [sqrtPriceX96] = await readContract(encoder.client, {
        address: biggestPool,
        abi: uniswapV3PoolAbi,
        functionName: "slot0",
      });

      const zeroForOne = fromHex(src, "bigint") < fromHex(dst, "bigint");

      if (liquidity > 0n && sqrtPriceX96 > 0n) {
        const virtualReserveSrc = zeroForOne
          ? (liquidity * Q96) / sqrtPriceX96 // reserve0
          : (liquidity * sqrtPriceX96) / Q96; // reserve1
        this.lastImpactBps =
          virtualReserveSrc > 0n
            ? (srcAmount * BPS_DENOMINATOR) / (virtualReserveSrc + srcAmount)
            : undefined;
      } else {
        this.lastImpactBps = undefined;
      }

      const encodedContext =
        `0x${0n.toString(16).padStart(24, "0") + zeroAddress.substring(2)}` as const;
      const callbacks = [
        encodeFunctionData({
          abi: executorAbi,
          functionName: "call_g0oyU7o",
          args: [
            src,
            0n,
            encodedContext,
            encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [biggestPool, srcAmount],
            }),
          ],
        }),
      ];

      encoder.pushCall(
        biggestPool,
        0n,
        encodeFunctionData({
          abi: uniswapV3PoolAbi,
          functionName: "swap",
          args: [
            encoder.address,
            zeroForOne,
            srcAmount,
            zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n,
            encodeAbiParameters([{ type: "bytes[]" }, { type: "bytes" }], [callbacks, "0x"]),
          ],
        }),
        {
          sender: biggestPool,
          dataIndex: 2n, // uniswapV3SwapCallback(int256,int256,bytes)
        },
      );

      /// assumed to be the last liquidity venue
      return {
        src: dst,
        dst: dst,
        srcAmount: 0n,
      };
    } catch (error) {
      throw new Error(
        `(UniswapV3) Error swapping: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  estimatePriceImpactBps(): bigint | undefined {
    return this.lastImpactBps;
  }

  private getCachedPools(src: Address, dst: Address) {
    if (this.pools[src]?.[dst] !== undefined) return this.pools[src][dst];
    if (this.pools[dst]?.[src] !== undefined) return this.pools[dst][src];
    return undefined;
  }

  private async fetchPools(encoder: ExecutorEncoder, src: Address, dst: Address) {
    const factoryAddress =
      specificFactoryAddresses[encoder.client.chain.id] ?? DEFAULT_FACTORY_ADDRESS;

    try {
      const newPools = (
        await Promise.all(
          FEE_TIERS.map(async (fee) =>
            readContract(encoder.client, {
              address: factoryAddress,
              abi: uniswapV3FactoryAbi,
              functionName: "getPool",
              args: [src, dst, fee],
            }),
          ),
        )
      ).filter((pool) => pool !== zeroAddress);

      if (this.pools[src]?.[dst] === undefined) {
        this.pools[src] = { ...this.pools[src], [dst]: newPools };
      }

      return newPools;
    } catch (error) {
      throw new Error(
        `(UniswapV3) Error fetching pools: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
