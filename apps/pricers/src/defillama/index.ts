import type { Account, Address, Chain, Client, Transport } from "viem";

import type { Pricer, PriceMeta } from "../pricer";

type CoinKey = `${string}:0x${string}`;

interface CachedPrice {
  price: number;
  fetchTimestamp: number;
  apiTimestamp: number;
}

interface DefiLlamaPriceResponse {
  coins: Record<
    CoinKey,
    {
      decimals: number;
      price: number;
      symbol: string;
      timestamp: number;
    }
  >;
}

/**
 * Maximum acceptable staleness of the DefiLlama API-reported timestamp (seconds).
 * If the API says the price is older than this, treat it as stale and return undefined.
 * 5 minutes — conservative for a service that claims near-real-time data.
 */
const MAX_API_STALENESS_SEC = 300; // 5 minutes

export class DefiLlamaPricer implements Pricer {
  private priceCache = new Map<CoinKey, CachedPrice>();
  private readonly cacheTimeoutMs: number = 10_000; // 10 seconds

  async price(client: Client<Transport, Chain, Account>, asset: Address) {
    const meta = await this.priceWithMeta(client, asset);
    return meta?.price;
  }

  async priceWithMeta(
    client: Client<Transport, Chain, Account>,
    asset: Address,
  ): Promise<PriceMeta | undefined> {
    const cacheKey = this.getCoinKey(client, asset);
    const cachedResult = this.priceCache.get(cacheKey);

    if (cachedResult && Date.now() - cachedResult.fetchTimestamp < this.cacheTimeoutMs) {
      // Check staleness of the API-reported timestamp even for cached results
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec - cachedResult.apiTimestamp > MAX_API_STALENESS_SEC) {
        console.warn(
          `DefiLlama price for ${asset} is stale: ${nowSec - cachedResult.apiTimestamp}s old, skipping`,
        );
        return undefined;
      }
      return { price: cachedResult.price, updatedAt: cachedResult.apiTimestamp };
    }

    return this.fetchPrice(client, asset);
  }

  private async fetchPrice(
    client: Client<Transport, Chain, Account>,
    asset: Address,
  ): Promise<PriceMeta | undefined> {
    const coinKey = this.getCoinKey(client, asset);
    const url = `https://coins.llama.fi/prices/current/${coinKey}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        return undefined;
      }

      const data = (await response.json()) as DefiLlamaPriceResponse;
      const coinData = data.coins[coinKey];

      if (!coinData) {
        return undefined;
      }

      // Staleness check: use the API-reported timestamp, not our cache TTL
      const nowSec = Math.floor(Date.now() / 1000);
      const staleness = nowSec - coinData.timestamp;

      if (staleness > MAX_API_STALENESS_SEC) {
        console.warn(
          `DefiLlama price for ${asset} is stale: ${staleness}s old (max=${MAX_API_STALENESS_SEC}s), skipping`,
        );
        return undefined;
      }

      this.priceCache.set(coinKey, {
        price: coinData.price,
        fetchTimestamp: Date.now(),
        apiTimestamp: coinData.timestamp,
      });

      return { price: coinData.price, updatedAt: coinData.timestamp };
    } catch {
      return undefined;
    }
  }

  private getCoinKey(client: Client<Transport, Chain, Account>, asset: Address): CoinKey {
    return `${client.chain.name}:${asset}`;
  }
}
