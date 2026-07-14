import type { AccrualPosition, PreLiquidationPosition } from "@morpho-org/blue-sdk";
import type { Account, Address, Chain, Client, Hex, Transport } from "viem";

export interface LiquidatablePositionsResult {
  liquidatablePositions: AccrualPosition[];
  preLiquidatablePositions: PreLiquidationPosition[];
}

/**
 * Thrown when a data provider fails (API/indexer down).
 * Callers must NOT treat this as "zero liquidatable / idle".
 */
export class DataProviderError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "DataProviderError";
    this.cause = cause;
  }
}

/**
 * Data providers are used to fetch market and position data.
 * All data providers must implement this interface.
 *
 * On hard failures, implementations should throw {@link DataProviderError}
 * (or rethrow) — never silently return empty arrays.
 */
export interface DataProvider {
  /**
   * Optional async initialization (e.g. spinning up an indexer, waiting for backfill).
   * Called once before the provider is used.
   */
  init?(): Promise<void>;

  /**
   * Fetch the market IDs for the given vaults.
   * @throws {DataProviderError} when the provider cannot be reached
   */
  fetchMarkets(client: Client<Transport, Chain, Account>, vaults: Address[]): Promise<Hex[]>;

  /**
   * Fetch liquidatable and pre-liquidatable positions for the given market IDs.
   * Empty arrays mean "nothing liquidatable". Failures must throw.
   * @throws {DataProviderError} when the provider cannot be reached
   */
  fetchLiquidatablePositions(
    client: Client<Transport, Chain, Account>,
    marketIds: Hex[],
  ): Promise<LiquidatablePositionsResult>;
}
