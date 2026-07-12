import type { Account, Address, Chain, Client, Transport } from "viem";

import type { Pricer } from "../pricer";

interface CachedPrice {
  price: number;
  fetchTimestamp: number;
}

export class MorphoApi implements Pricer {
  private readonly API_URL = "https://blue-api.morpho.org/graphql";
  private supportedChains: number[] = [];
  private initialized = false;
  /** Short TTL cache — same asset is often priced many times per poll tick */
  private priceCache = new Map<string, CachedPrice>();
  private readonly cacheTimeoutMs = 15_000; // 15 seconds

  async price(client: Client<Transport, Chain, Account>, asset: Address) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.supportedChains.includes(client.chain.id)) return;

    const cacheKey = `${client.chain.id}:${asset.toLowerCase()}`;
    const cached = this.priceCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchTimestamp < this.cacheTimeoutMs) {
      return cached.price;
    }

    try {
      const response = await fetch(this.API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: this.query(client.chain.id, asset) }),
      });

      const data = (await response.json()) as {
        data: { assets: { items: { address: Address; priceUsd: number }[] } };
      };

      const items = data.data.assets.items;

      // Case-insensitive match — API may return checksummed addresses
      const assetLower = asset.toLowerCase();
      const priceUsd =
        items.find((item) => item.address.toLowerCase() === assetLower)?.priceUsd ?? null;

      if (priceUsd != null) {
        this.priceCache.set(cacheKey, { price: priceUsd, fetchTimestamp: Date.now() });
        return priceUsd;
      }
      return undefined;
    } catch (error) {
      console.error(error);
      return undefined;
    }
  }

  private async initialize() {
    const initilizationQuery = `
      query {
        chains{
            id
        }
      }
      `;

    try {
      const response = await fetch(this.API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: initilizationQuery }),
      });

      const data = (await response.json()) as { data: { chains: { id: number }[] } };
      this.supportedChains = data.data.chains.map((chain) => chain.id);
      this.initialized = true;
    } catch (error) {
      console.error(error);
    }
  }

  private query(chainId: number, asset: Address) {
    return `
    query {
        assets(where: { address_in: ["${asset}"], chainId_in: [${chainId}]} ) {
            items {
                address
                priceUsd
            }
        }
    }
    `;
  }
}
