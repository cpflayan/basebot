import fs from "node:fs";
import path from "node:path";

import { AccrualPosition, Market } from "@morpho-org/blue-sdk";
import type { Address, Hex } from "viem";

/**
 * Cached position entry — raw state from API or events
 */
export interface CachedPosition {
  user: Address;
  marketId: Hex;
  collateral: bigint;
  borrowShares: bigint;
  supplyShares: bigint;
  updatedAt: number;
}

/**
 * Cached market state — everything needed to construct a Market object
 * for HF calculation, except the oracle price (fetched fresh on demand).
 */
export interface CachedMarketState {
  marketId: Hex;
  params: {
    loanToken: Address;
    collateralToken: Address;
    oracle: Address;
    irm: Address;
    lltv: bigint;
  };
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
  rateAtTarget: bigint;
  /** Last known oracle price (updated on each fetch) */
  price: bigint;
  fetchedAt: number;
}

/**
 * In-memory cache for positions and market state.
 *
 * Fast path: on-chain event → update cache → fetch oracle price → calc HF → liquidate if needed
 * Slow path: periodic full refresh from Morpho API → rebuild cache
 */
export class PositionCache {
  /** `${marketId}-${user}` → CachedPosition */
  private positions = new Map<string, CachedPosition>();

  /** marketId → CachedMarketState */
  private markets = new Map<Hex, CachedMarketState>();

  /** marketId → Set<positionKey> */
  private marketPositions = new Map<Hex, Set<string>>();

  // ─── Position operations ───

  set(pos: CachedPosition): void {
    const key = this.key(pos.marketId, pos.user);
    this.positions.set(key, pos);
    let set = this.marketPositions.get(pos.marketId);
    if (!set) {
      set = new Set();
      this.marketPositions.set(pos.marketId, set);
    }
    set.add(key);
  }

  /** Bulk-load positions (from API or events) */
  setMany(positions: CachedPosition[]): void {
    for (const p of positions) this.set(p);
  }

  get(marketId: Hex, user: Address): CachedPosition | undefined {
    return this.positions.get(this.key(marketId, user));
  }

  /**
   * Overwrite position state from event data.
   * If position doesn't exist in cache, creates it.
   */
  upsert(
    marketId: Hex,
    user: Address,
    state: Partial<Omit<CachedPosition, "user" | "marketId">>,
  ): CachedPosition {
    const key = this.key(marketId, user);
    const existing = this.positions.get(key);
    const updated: CachedPosition = {
      user,
      marketId,
      collateral: state.collateral ?? existing?.collateral ?? 0n,
      borrowShares: state.borrowShares ?? existing?.borrowShares ?? 0n,
      supplyShares: state.supplyShares ?? existing?.supplyShares ?? 0n,
      updatedAt: Date.now(),
    };
    this.positions.set(key, updated);

    let set = this.marketPositions.get(marketId);
    if (!set) {
      set = new Set();
      this.marketPositions.set(marketId, set);
    }
    set.add(key);

    return updated;
  }

  remove(marketId: Hex, user: Address): void {
    const key = this.key(marketId, user);
    this.positions.delete(key);
    this.marketPositions.get(marketId)?.delete(key);
  }

  getPositionsForMarket(marketId: Hex): CachedPosition[] {
    const keys = this.marketPositions.get(marketId);
    if (!keys) return [];
    return [...keys].map((k) => this.positions.get(k)!).filter(Boolean);
  }

  getAllPositions(): CachedPosition[] {
    return [...this.positions.values()];
  }

  // ─── Market operations ───

  setMarket(state: CachedMarketState): void {
    this.markets.set(state.marketId, state);
  }

  getMarket(marketId: Hex): CachedMarketState | undefined {
    return this.markets.get(marketId);
  }

  /** Update just the oracle price for a market */
  updateOraclePrice(marketId: Hex, price: bigint): void {
    const m = this.markets.get(marketId);
    if (m) {
      m.price = price;
      m.fetchedAt = Date.now();
    }
  }

  isMarketStale(marketId: Hex, maxAgeMs = 120_000): boolean {
    const m = this.markets.get(marketId);
    if (!m) return true;
    return Date.now() - m.fetchedAt > maxAgeMs;
  }

  // ─── HF calculation ───

  /**
   * Build an AccrualPosition from cached data + a fresh oracle price.
   * This is the core of the incremental HF calculation.
   */
  buildAccrualPosition(
    marketId: Hex,
    user: Address,
    freshPrice?: bigint,
  ): AccrualPosition | undefined {
    const pos = this.positions.get(this.key(marketId, user));
    const mkt = this.markets.get(marketId);
    if (!pos || !mkt) return undefined;
    if (pos.borrowShares === 0n) return undefined; // No debt

    const price = freshPrice ?? mkt.price;
    if (!price) return undefined;

    const market = new Market({
      params: mkt.params,
      totalSupplyAssets: mkt.totalSupplyAssets,
      totalSupplyShares: mkt.totalSupplyShares,
      totalBorrowAssets: mkt.totalBorrowAssets,
      totalBorrowShares: mkt.totalBorrowShares,
      lastUpdate: mkt.lastUpdate,
      fee: mkt.fee,
      rateAtTarget: mkt.rateAtTarget,
      price,
    });

    const now = BigInt(Math.floor(Date.now() / 1000));
    const timestamp = now > market.lastUpdate ? now : market.lastUpdate;
    const accruedMarket = market.accrueInterest(timestamp);

    return new AccrualPosition(
      {
        user: pos.user,
        supplyShares: pos.supplyShares,
        borrowShares: pos.borrowShares,
        collateral: pos.collateral,
      },
      accruedMarket,
    );
  }

  /**
   * Calculate HF for a specific position.
   * @param freshPrice - optional fresh oracle price; if omitted, uses cached price
   * @returns HF value, or undefined if data is missing
   */
  calculateHF(marketId: Hex, user: Address, freshPrice?: bigint): number | undefined {
    const accrualPos = this.buildAccrualPosition(marketId, user, freshPrice);
    if (!accrualPos) return undefined;

    // Use SDK's healthFactor which correctly computes:
    //   HF = wDivDown(wMulDown(collateralValue, lltv), borrowAssets)
    // Returns bigint scaled by WAD (1e18), or undefined if price is missing.
    const hfBigInt = accrualPos.healthFactor;
    if (hfBigInt === undefined) return undefined;

    // MaxUint256 means no debt → treat as Infinity
    if (hfBigInt > 10n ** 30n) return Infinity;

    return Number(hfBigInt) / 1e18;
  }

  /**
   * Find all positions in a market with HF < threshold.
   * Uses cached oracle prices (may be slightly stale).
   */
  findAtRiskPositions(
    marketId: Hex,
    threshold = 1,
    freshPrice?: bigint,
  ): { position: CachedPosition; hf: number }[] {
    const positions = this.getPositionsForMarket(marketId);
    const atRisk: { position: CachedPosition; hf: number }[] = [];

    for (const pos of positions) {
      const hf = this.calculateHF(marketId, pos.user, freshPrice);
      if (hf !== undefined && hf < threshold) {
        atRisk.push({ position: pos, hf });
      }
    }

    return atRisk;
  }

  // ─── Lifecycle ───

  clear(): void {
    this.positions.clear();
    this.markets.clear();
    this.marketPositions.clear();
  }

  get stats() {
    return {
      positions: this.positions.size,
      markets: this.markets.size,
    };
  }

  // ─── Serialization / Persistence ───

  serialize(): string {
    const data = {
      version: 1,
      timestamp: Date.now(),
      positions: [...this.positions.entries()].map(([key, pos]) => ({
        key,
        user: pos.user,
        marketId: pos.marketId,
        collateral: pos.collateral.toString(),
        borrowShares: pos.borrowShares.toString(),
        supplyShares: pos.supplyShares.toString(),
        updatedAt: pos.updatedAt,
      })),
      markets: [...this.markets.entries()].map(([marketId, m]) => ({
        marketId,
        params: m.params,
        totalSupplyAssets: m.totalSupplyAssets.toString(),
        totalSupplyShares: m.totalSupplyShares.toString(),
        totalBorrowAssets: m.totalBorrowAssets.toString(),
        totalBorrowShares: m.totalBorrowShares.toString(),
        lastUpdate: m.lastUpdate.toString(),
        fee: m.fee.toString(),
        rateAtTarget: m.rateAtTarget.toString(),
        price: m.price.toString(),
        fetchedAt: m.fetchedAt,
      })),
    };
    return JSON.stringify(data);
  }

  deserialize(json: string): void {
    const data = JSON.parse(json);
    this.clear();

    for (const pos of data.positions) {
      this.set({
        user: pos.user,
        marketId: pos.marketId,
        collateral: BigInt(pos.collateral),
        borrowShares: BigInt(pos.borrowShares),
        supplyShares: BigInt(pos.supplyShares),
        updatedAt: pos.updatedAt,
      });
    }

    for (const m of data.markets) {
      this.setMarket({
        marketId: m.marketId,
        params: m.params,
        totalSupplyAssets: BigInt(m.totalSupplyAssets),
        totalSupplyShares: BigInt(m.totalSupplyShares),
        totalBorrowAssets: BigInt(m.totalBorrowAssets),
        totalBorrowShares: BigInt(m.totalBorrowShares),
        lastUpdate: BigInt(m.lastUpdate),
        fee: BigInt(m.fee),
        rateAtTarget: BigInt(m.rateAtTarget),
        price: BigInt(m.price),
        fetchedAt: m.fetchedAt,
      });
    }
  }

  saveToFile(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, this.serialize(), "utf-8");
    fs.renameSync(tmpPath, filePath); // atomic replace
  }

  loadFromFile(filePath: string): boolean {
    if (!fs.existsSync(filePath)) return false;
    try {
      const json = fs.readFileSync(filePath, "utf-8");
      this.deserialize(json);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Helpers ───

  private key(marketId: Hex, user: Address): string {
    return `${marketId.toLowerCase()}-${user.toLowerCase()}`;
  }
}
