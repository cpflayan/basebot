import type { ExecutorEncoder } from "executooor-viem";
import type { Address } from "viem";

import type { ToConvert } from "./types";

/**
 * Liquidity venues are used to convert an amount from a source token to a destination token.
 * All liquidity venues must implement this interface.
 */
export interface LiquidityVenue {
  /**
   * Whether the venue is adapted to the conversion.
   */
  supportsRoute(encoder: ExecutorEncoder, src: Address, dst: Address): Promise<boolean> | boolean;

  /**
   * Convert the amount from src to dst.
   */
  convert(executor: ExecutorEncoder, toConvert: ToConvert): Promise<ToConvert> | ToConvert;

  /**
   * SECURITY (C2): Only implemented by "naked" venues — those whose swap call has
   * no protocol-level minAmountOut (e.g. raw AMM pool calls like UniswapV3/Aerodrome).
   * Returns the estimated one-sided price impact of the last `convert()` call, in bps,
   * as a byproduct of data already fetched while building the swap (no extra RPC round trip).
   *
   * Venues that route through an aggregator whose own router enforces a minReturn
   * on-chain (1inch, 0x) should leave this undefined — the bot-level dynamic margin
   * treats "undefined" as "already protected upstream" and applies only a small floor.
   */
  estimatePriceImpactBps?(): bigint | undefined;
}
