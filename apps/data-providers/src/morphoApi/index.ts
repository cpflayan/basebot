import { AccrualPosition, Market, MarketId } from "@morpho-org/blue-sdk";
import "@morpho-org/blue-sdk-viem/lib/augment";
import { fetchMarket, metaMorphoAbi } from "@morpho-org/blue-sdk-viem";
import { Time } from "@morpho-org/morpho-ts";
import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import { readContract } from "viem/actions";

import {
  DataProviderError,
  type DataProvider,
  type LiquidatablePositionsResult,
} from "../dataProvider";

import { apiSdk } from "./api/index";

export class MorphoApiDataProvider implements DataProvider {
  async fetchMarkets(client: Client<Transport, Chain, Account>, vaults: Address[]): Promise<Hex[]> {
    try {
      const vaultMarkets = await Promise.all(
        vaults.map(async (vault) => this.fetchVaultMarkets(client, vault)),
      );

      return [...new Set(vaultMarkets.flat())];
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Chain ${client.chain.id}] Error fetching markets for vaults: ${msg}`);
      throw new DataProviderError(
        `Morpho API fetchMarkets failed (chain ${client.chain.id}): ${msg}`,
        error,
      );
    }
  }

  async fetchLiquidatablePositions(
    client: Client<Transport, Chain, Account>,
    marketIds: Hex[],
  ): Promise<LiquidatablePositionsResult> {
    try {
      const PAGE_SIZE = 100;
      const MARKET_BATCH_SIZE = 100;
      const allPositions: NonNullable<
        Awaited<ReturnType<typeof apiSdk.getLiquidatablePositions>>["marketPositions"]["items"]
      > = [];

      // Batch market IDs into chunks of 100 (API limit)
      for (let i = 0; i < marketIds.length; i += MARKET_BATCH_SIZE) {
        const marketIdsBatch = marketIds.slice(i, i + MARKET_BATCH_SIZE);

        let skip = 0;
        while (true) {
          const positionsQuery = await apiSdk.getLiquidatablePositions({
            chainId: client.chain.id,
            marketIds: marketIdsBatch,
            skip,
            first: PAGE_SIZE,
          });

          const items = positionsQuery.marketPositions.items;
          if (!items || items.length === 0) break;

          allPositions.push(...items);

          if (items.length < PAGE_SIZE) break;
          skip += PAGE_SIZE;
        }
      }

      const positions = allPositions.filter(
        (position) =>
          position.market.uniqueKey !== undefined &&
          position.market.oracle !== null &&
          position.state !== null,
      );

      if (positions.length === 0)
        return { liquidatablePositions: [], preLiquidatablePositions: [] };

      const marketsNeeded = new Set(positions.map((p) => p.market.uniqueKey).filter(Boolean));

      const marketResults = await Promise.allSettled(
        [...marketsNeeded].map(async (marketId) => {
          const market = await fetchMarket(marketId, client, {
            chainId: client.chain.id,
            deployless: false,
          });

          const now = Time.timestamp();
          const timestamp = now > market.lastUpdate ? now : market.lastUpdate;
          return [marketId, market.accrueInterest(timestamp)] as const;
        }),
      );

      const marketsMap = new Map(
        marketResults
          .filter(
            (r): r is PromiseFulfilledResult<readonly [MarketId, Market]> =>
              r.status === "fulfilled",
          )
          .map((r) => r.value),
      );

      for (const r of marketResults) {
        if (r.status === "rejected") {
          const msg = r.reason instanceof Error ? r.reason.message : r.reason;
          console.error(`[Chain ${client.chain.id}] Error fetching market: ${msg}`);
        }
      }

      const accruedPositions = positions
        .map((position) => {
          const market = marketsMap.get(position.market.uniqueKey);
          if (!market) return;

          const accrualPosition = new AccrualPosition(
            {
              user: position.user.address,
              // NOTE: These come as strings when mocking GraphQL response in tests, so we cast manually
              supplyShares: BigInt(position.state?.supplyShares ?? "0"),
              borrowShares: BigInt(position.state?.borrowShares ?? "0"),
              collateral: BigInt(position.state?.collateral ?? "0"),
            },
            market,
          );

          return accrualPosition;
        })
        .filter((position) => position !== undefined);

      return {
        // Align with HyperIndex: drop dust / undefined seizable (cannot size a swap)
        liquidatablePositions: accruedPositions.filter(
          (position) =>
            position.seizableCollateral !== undefined && position.seizableCollateral > 0n,
        ),
        preLiquidatablePositions: [],
      };
    } catch (error) {
      if (error instanceof DataProviderError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Chain ${client.chain.id}] Error fetching liquidatable positions: ${msg}`);
      throw new DataProviderError(
        `Morpho API fetchLiquidatablePositions failed (chain ${client.chain.id}): ${msg}`,
        error,
      );
    }
  }

  private async fetchVaultMarkets(
    client: Client<Transport, Chain, Account>,
    vaultAddress: Address,
  ): Promise<Hex[]> {
    try {
      const withdrawQueueLength = await readContract(client, {
        address: vaultAddress,
        abi: metaMorphoAbi,
        functionName: "withdrawQueueLength",
      });

      const indices = Array.from({ length: Number(withdrawQueueLength) }, (_, i) => BigInt(i));

      return await Promise.all(
        indices.map(async (index) => {
          const marketId = await readContract(client, {
            address: vaultAddress,
            abi: metaMorphoAbi,
            functionName: "withdrawQueue",
            args: [index],
          });
          return marketId;
        }),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(
        `[Chain ${client.chain.id}] Error fetching vault markets for ${vaultAddress}: ${msg}`,
      );
      // Per-vault failure: rethrow so fetchMarkets surfaces provider error (not silent empty)
      throw new DataProviderError(
        `Morpho API vault markets failed for ${vaultAddress}: ${msg}`,
        error,
      );
    }
  }
}
