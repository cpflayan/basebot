import type { Account, Address, Chain, Client, MaybePromise, Transport } from "viem";

/**
 * Metadata about a price observation, used for staleness filtering
 * in multi-source verified price aggregation.
 */
export interface PriceMeta {
  /** USD price as a floating-point number */
  price: number;
  /** Unix timestamp (seconds) when the price was observed/updated on-chain or by the API.
   *  Undefined when the source cannot provide a timestamp. */
  updatedAt?: number;
}

/**
 * Role of the asset in a liquidation profitability calculation.
 * - "collateral": the asset the bot receives → use Math.min (conservative: underestimate)
 * - "debt":       the asset the bot must repay  → use Math.max (conservative: overestimate cost)
 */
export type PriceRole = "collateral" | "debt";

/**
 * Pricers are used to price an asset in USD.
 * All pricers must implement this interface.
 */
export interface Pricer {
  /**
   * Get the price of the asset in USD.
   * Returns undefined if the price is unavailable or stale.
   */
  price(
    client: Client<Transport, Chain, Account>,
    asset: Address,
  ): MaybePromise<number | undefined>;

  /**
   * Get the price together with metadata (timestamp) for staleness-aware aggregation.
   * Default implementation wraps `price()` with no timestamp — pricers that can provide
   * freshness data should override this method.
   */
  priceWithMeta?(
    client: Client<Transport, Chain, Account>,
    asset: Address,
  ): MaybePromise<PriceMeta | undefined>;
}
