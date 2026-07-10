import {
  CHAINLINK_PROXY,
  DENOMINATIONS,
  FEED_REGISTRY_ADDRESS,
  MAPPINGS,
} from "@morpho-blue-liquidation-bot/config";
import {
  formatUnits,
  type Account,
  type Address,
  type Chain,
  type Client,
  type Transport,
} from "viem";
import { readContract } from "viem/actions";
import { mainnet } from "viem/chains";

import { aggregatorV3Abi } from "../abis/aggregator";
import { feedRegistryAbi } from "../abis/feedRegistry";
import type { Pricer, PriceMeta } from "../pricer";

type CoinKey = `${string}:${Address}`;

interface CachedPrice {
  price: number;
  fetchTimestamp: number;
}

/**
 * Per-asset heartbeat intervals (seconds) from Chainlink documentation.
 * Volatile assets update more frequently; stablecoins less so.
 * Used to detect stale on-chain price data.
 */
const FEED_HEARTBEAT_SEC: Record<Address, number> = {
  // ETH-denominated feeds
  ["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"]: 3_600, // WETH → 1h
  // BTC-denominated feeds
  ["0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"]: 3_600, // WBTC → 1h
};

/** Default heartbeat for assets not in the map above (conservative 1h) */
const DEFAULT_HEARTBEAT_SEC = 3_600;

export class ChainlinkPricer implements Pricer {
  private readonly CACHE_TIMEOUT_MS = 30_000; // 30 seconds

  private priceCache = new Map<CoinKey, CachedPrice>();

  async price(
    client: Client<Transport, Chain, Account>,
    asset: Address,
  ): Promise<number | undefined> {
    const meta = await this.priceWithMeta(client, asset);
    return meta?.price;
  }

  async priceWithMeta(
    client: Client<Transport, Chain, Account>,
    asset: Address,
  ): Promise<PriceMeta | undefined> {
    // On mainnet, apply Feed Registry denomination mapping (WETH→ETH, WBTC→BTC)
    if (client.chain.id === mainnet.id) {
      asset = MAPPINGS[asset] ?? asset;
    }

    const coinKey: CoinKey = `${client.chain.name}:${asset}`;
    const cachedPrice = this.priceCache.get(coinKey);

    // Return cached price if available and not expired
    if (cachedPrice && Date.now() - cachedPrice.fetchTimestamp < this.CACHE_TIMEOUT_MS) {
      return { price: cachedPrice.price };
    }

    try {
      if (client.chain.id === mainnet.id) {
        return await this.fetchFromFeedRegistry(client, asset, coinKey);
      }
      return await this.fetchFromProxy(client, asset, coinKey);
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error fetching Chainlink price for ${asset}:`, error);
      } else {
        console.error(`Error fetching Chainlink price for ${asset}:`, String(error));
      }
      return undefined;
    }
  }

  /**
   * Mainnet path: query price via Feed Registry (asset + denomination).
   */
  private async fetchFromFeedRegistry(
    client: Client<Transport, Chain, Account>,
    asset: Address,
    coinKey: CoinKey,
  ): Promise<PriceMeta | undefined> {
    const [roundData, decimals] = await Promise.all([
      readContract(client, {
        address: FEED_REGISTRY_ADDRESS,
        abi: feedRegistryAbi,
        functionName: "latestRoundData",
        args: [asset, DENOMINATIONS.USD],
      }),
      readContract(client, {
        address: FEED_REGISTRY_ADDRESS,
        abi: feedRegistryAbi,
        functionName: "decimals",
        args: [asset, DENOMINATIONS.USD],
      }),
    ]);

    return this.processRoundData(roundData, decimals, asset, coinKey);
  }

  /**
   * Non-mainnet path: query price via individual AggregatorV3 proxy.
   * Returns undefined if no proxy is configured for this chain/asset.
   */
  private async fetchFromProxy(
    client: Client<Transport, Chain, Account>,
    asset: Address,
    coinKey: CoinKey,
  ): Promise<PriceMeta | undefined> {
    const proxyMap = CHAINLINK_PROXY[client.chain.id];
    if (!proxyMap) {
      return undefined;
    }

    const proxyAddress = proxyMap[asset];
    if (!proxyAddress) {
      // No Chainlink proxy configured for this asset on this chain — fallback to next pricer
      return undefined;
    }

    const [roundData, decimals] = await Promise.all([
      readContract(client, {
        address: proxyAddress,
        abi: aggregatorV3Abi,
        functionName: "latestRoundData",
      }),
      readContract(client, {
        address: proxyAddress,
        abi: aggregatorV3Abi,
        functionName: "decimals",
      }),
    ]);

    return this.processRoundData(roundData, decimals, asset, coinKey);
  }

  /**
   * Shared logic: validate round data, staleness check, cache, and return PriceMeta.
   */
  private processRoundData(
    roundData: readonly [bigint, bigint, bigint, bigint, bigint],
    decimals: number,
    asset: Address,
    coinKey: CoinKey,
  ): PriceMeta | undefined {
    const rawPrice = roundData[1];
    const updatedAt = roundData[3];

    if (rawPrice <= 0n) {
      return undefined;
    }

    // Staleness check: compare updatedAt against per-feed heartbeat
    const heartbeatSec = FEED_HEARTBEAT_SEC[asset] ?? DEFAULT_HEARTBEAT_SEC;
    const nowSec = Math.floor(Date.now() / 1000);
    const staleness = nowSec - Number(updatedAt);

    if (staleness > heartbeatSec) {
      console.warn(
        `Chainlink price for ${asset} is stale: ${staleness}s old (heartbeat=${heartbeatSec}s), skipping`,
      );
      return undefined;
    }

    const price = Number(formatUnits(rawPrice, decimals));
    this.priceCache.set(coinKey, { price, fetchTimestamp: Date.now() });

    return { price, updatedAt: Number(updatedAt) };
  }
}
