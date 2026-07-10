import { PYTH_CONTRACT_ADDRESS, PYTH_TOKEN_TO_FEED } from "@morpho-blue-liquidation-bot/config";
import { type Account, type Address, type Chain, type Client, type Transport } from "viem";
import { readContract } from "viem/actions";

import { pythAbi } from "../abis/pyth";
import type { Pricer } from "../pricer";

type FeedKey = `${string}:0x${string}`;

interface CachedPrice {
  price: number;
  fetchTimestamp: number;
}

/**
 * Pyth Network pricer — reads prices directly from the Pyth contract on-chain.
 *
 * Advantages over DefiLlama:
 * - No rate limiting (on-chain read, not HTTP API)
 * - Lower latency (no third-party server dependency)
 * - Sponsored feeds on Base keep prices fresh without on-chain update txns
 *
 * Limitations:
 * - Only supports assets with a mapped Pyth feed ID (see PYTH_TOKEN_TO_FEED)
 * - Returns undefined for unmapped assets, allowing fallback to next pricer
 */
export class PythPricer implements Pricer {
  private readonly CACHE_TIMEOUT_MS = 15_000; // 15 seconds
  private readonly MAX_PRICE_AGE_SECS = 120; // 2 minutes — generous for sponsored feeds
  private readonly MAX_CONFIDENCE_BPS = 500; // 5% max confidence interval (1σ)

  private priceCache = new Map<FeedKey, CachedPrice>();

  async price(
    client: Client<Transport, Chain, Account>,
    asset: Address,
  ): Promise<number | undefined> {
    const contractAddress = PYTH_CONTRACT_ADDRESS[client.chain.id];
    if (!contractAddress) return undefined;

    const feedId = PYTH_TOKEN_TO_FEED[client.chain.id]?.[asset];
    if (!feedId) return undefined;

    const cacheKey: FeedKey = `${client.chain.id}:${asset}`;
    const cached = this.priceCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchTimestamp < this.CACHE_TIMEOUT_MS) {
      return cached.price;
    }

    try {
      const pythPrice = await readContract(client, {
        address: contractAddress,
        abi: pythAbi,
        functionName: "getPriceUnsafe",
        args: [feedId],
      });

      const { price: rawPrice, conf, expo, publishTime } = pythPrice;

      // Staleness check
      const nowSecs = Math.floor(Date.now() / 1000);
      if (nowSecs - Number(publishTime) > this.MAX_PRICE_AGE_SECS) {
        return undefined;
      }

      // rawPrice is int64, expo is int32 (typically -8)
      // price = rawPrice * 10^expo
      const price = Number(rawPrice) * Math.pow(10, expo);

      if (price <= 0) return undefined;

      // Confidence check: reject if confidence interval is too wide
      // conf is uint64 in same units as price, check conf/price < threshold
      const confBps = (Number(conf) / Number(rawPrice)) * 10_000;
      if (confBps > this.MAX_CONFIDENCE_BPS) {
        return undefined;
      }

      this.priceCache.set(cacheKey, { price, fetchTimestamp: Date.now() });

      return price;
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error fetching Pyth price for ${asset}:`, error.message);
      } else {
        console.error(`Error fetching Pyth price for ${asset}:`, String(error));
      }
      return undefined;
    }
  }
}
