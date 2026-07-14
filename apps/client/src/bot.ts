import {
  chainConfigs,
  loadApprovedMarketIds,
  type FlashLoanProvider,
} from "@morpho-blue-liquidation-bot/config";
import type { DataProvider } from "@morpho-blue-liquidation-bot/data-providers";
import type { LiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import type { Pricer } from "@morpho-blue-liquidation-bot/pricers";
import {
  AccrualPosition,
  ChainAddresses,
  getChainAddresses,
  MarketUtils,
  PreLiquidationPosition,
  MarketId,
} from "@morpho-org/blue-sdk";
import { fetchMarket } from "@morpho-org/blue-sdk-viem";
import {
  erc20Abi,
  getAddress,
  LocalAccount,
  maxUint256,
  parseUnits,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Transport,
  type WalletClient,
} from "viem";
import { readContract } from "viem/actions";

import { oracleAbi } from "./abis/morpho/oracle.js";
import { PositionCache, type CachedMarketState, type CachedPosition } from "./positionCache.js";
import {
  classifyLiquidationFailure,
  type CooldownClass,
  MarketsFetchingCooldownMechanism,
  PositionLiquidationCooldownMechanism,
} from "./utils/cooldownMechanisms.js";
import { fetchWhitelistedVaults } from "./utils/fetch-whitelisted-vaults.js";
import { logLiquidationDebug } from "./utils/liquidationDebug.js";
import { LiquidationEncoder } from "./utils/LiquidationEncoder.js";
import { liquidationTracker } from "./utils/liquidationState.js";
import { DEFAULT_LIQUIDATION_BUFFER_BPS, WAD, wMulDown } from "./utils/maths.js";
import { RaceMetrics, elapsedMs, nowMs } from "./utils/raceMetrics.js";
import { shouldWarmRoutes } from "./utils/rpcBudget.js";
import {
  type SharedExecutionDeps,
  TOKEN_BLACKLIST,
  convertCollateralToLoan as sharedConvertCollateralToLoan,
  isLiquidationRaceLostError,
  priceAsset,
  simulateAndExec,
  simulateAndExecFlashLoanWithFallback,
  warmVenueRouteCache,
} from "./utils/sharedExecution.js";
import type { DecodedMorphoEvent } from "./webhook.js";
import "@morpho-org/blue-sdk-viem/lib/augment";

/** Morpho Blue healthFactor is WAD (1e18); format for logs / debug UI. */
function healthFactorToNumber(hf: bigint | undefined): number | undefined {
  if (hf === undefined) return undefined;
  return Number(hf) / 1e18;
}

function formatHealthFactor(hf: bigint | undefined): string {
  const n = healthFactorToNumber(hf);
  return n !== undefined ? n.toFixed(4) : "?";
}

/**
 * Dust debt in loan-token base units that cannot cover swap minOut + gas.
 * USDC-like (≤8 decimals): &lt; 0.01 unit; 18-dec assets: &lt; 1e12 wei.
 */
function isDustLoanAmount(amount: bigint, loanToken: Address): boolean {
  if (amount === 0n) return true;
  const t = loanToken.toLowerCase();
  // Base USDC / USDbC
  if (
    t === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" ||
    t === "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca"
  ) {
    return amount < 10_000n; // $0.01
  }
  return amount < 10n ** 12n;
}

/**
 * Estimate loan assets Morpho will pull when liquidating with a given seize amount
 * (repaidShares=0 path). Prefer this over full borrowAssets for flash loan sizing.
 * Falls back to full debt when oracle/math is unavailable.
 */
function estimateRepaidAssets(position: AccrualPosition, seizedCollateral: bigint): bigint {
  const fullDebt = position.borrowAssets ?? 0n;
  if (seizedCollateral === 0n) return 0n;
  try {
    const market = position.market;
    const repaidShares = market.getLiquidationRepaidShares(seizedCollateral);
    if (repaidShares === undefined || repaidShares === 0n) {
      return fullDebt;
    }
    // Round up so flash loan covers on-chain pull
    const repaidAssets = market.toBorrowAssets(repaidShares, "Up");
    if (repaidAssets === 0n) return fullDebt;
    // Cap at full debt (cannot repay more than owed)
    return repaidAssets > fullDebt && fullDebt > 0n ? fullDebt : repaidAssets;
  } catch {
    return fullDebt;
  }
}

export interface LiquidationBotInputs {
  logTag: string;
  chainId: number;
  client: WalletClient<Transport, Chain, Account>;
  wNative: Address;
  vaultWhitelist: Address[] | "morpho-api";
  additionalMarketsWhitelist: Hex[];
  executorAddress: Address;
  treasuryAddress: Address;
  dataProvider: DataProvider;
  liquidityVenues: LiquidityVenue[];
  alwaysRealizeBadDebt: boolean;
  pricers?: Pricer[];
  positionLiquidationCooldownMechanism?: PositionLiquidationCooldownMechanism;
  marketsFetchingCooldownMechanism: MarketsFetchingCooldownMechanism;
  flashbotAccount?: LocalAccount;
  useFlashLoan?: boolean;
  flashLoanProvider?: FlashLoanProvider;
  flashLoanFallbackProviders?: FlashLoanProvider[];
}

export class LiquidationBot {
  private logTag: string;
  private chainId: number;
  private client: WalletClient<Transport, Chain, Account>;
  private chainAddresses: ChainAddresses;
  private wNative: Address;
  private vaultWhitelist: Address[] | "morpho-api";
  private additionalMarketsWhitelist: Hex[];
  private executorAddress: Address;
  private treasuryAddress: Address;
  private dataProvider: DataProvider;
  private liquidityVenues: LiquidityVenue[];
  private pricers?: Pricer[];
  private positionLiquidationCooldownMechanism?: PositionLiquidationCooldownMechanism;
  private marketsFetchingCooldownMechanism: MarketsFetchingCooldownMechanism;
  private flashbotAccount?: LocalAccount;
  private coveredMarkets: Hex[];
  private alwaysRealizeBadDebt: boolean;
  private useFlashLoan: boolean;
  private flashLoanProvider: FlashLoanProvider;
  private flashLoanFallbackProviders: FlashLoanProvider[];
  private positionCache: PositionCache;
  /** Interval for slow-path full refresh (ms). Default: 5 minutes */
  private cacheRefreshInterval: number;
  private cacheRefreshTimer?: ReturnType<typeof setInterval>;
  private raceMetrics = new RaceMetrics(20);
  private slowPathTicks = 0;

  // ─── Health & monitoring stats ───
  private _liquidationsAttempted = 0;
  private _liquidationsSucceeded = 0;
  private _liquidationsFailed = 0;
  private _lastCheckTimestamp = 0;
  private _lastCheckBlock = 0;
  private _rpcErrors = 0;
  private _rpcTotal = 0;
  private _lastError?: string;
  /** True when last data-provider fetch failed (not the same as "0 liquidatable"). */
  private _providerError = false;
  private _lastProviderError?: string;
  private _lastProviderOkAt = 0;

  constructor(inputs: LiquidationBotInputs) {
    this.logTag = inputs.logTag;
    this.chainId = inputs.chainId;
    this.client = inputs.client;
    this.chainAddresses = getChainAddresses(inputs.chainId);
    this.wNative = inputs.wNative;
    this.vaultWhitelist = inputs.vaultWhitelist;
    this.additionalMarketsWhitelist = inputs.additionalMarketsWhitelist;
    this.executorAddress = inputs.executorAddress;
    this.treasuryAddress = inputs.treasuryAddress;
    this.dataProvider = inputs.dataProvider;
    this.liquidityVenues = inputs.liquidityVenues;
    this.pricers = inputs.pricers;
    this.positionLiquidationCooldownMechanism = inputs.positionLiquidationCooldownMechanism;
    this.marketsFetchingCooldownMechanism = inputs.marketsFetchingCooldownMechanism;
    this.flashbotAccount = inputs.flashbotAccount;
    this.coveredMarkets = [];
    this.alwaysRealizeBadDebt = inputs.alwaysRealizeBadDebt;
    this.useFlashLoan = inputs.useFlashLoan ?? false;
    this.flashLoanProvider = inputs.flashLoanProvider ?? "balancer";
    this.flashLoanFallbackProviders = inputs.flashLoanFallbackProviders ?? [];
    this.positionCache = new PositionCache();
    this.cacheRefreshInterval = Number(process.env.CACHE_REFRESH_INTERVAL_MS ?? "300000"); // 5 min
  }

  // ─── Shared execution deps ───

  private get sharedDeps(): SharedExecutionDeps {
    return {
      logTag: this.logTag,
      chainId: this.chainId,
      client: this.client,
      executorAddress: this.executorAddress,
      treasuryAddress: this.treasuryAddress,
      liquidityVenues: this.liquidityVenues,
      pricers: this.pricers,
      wNative: this.wNative,
      flashbotAccount: this.flashbotAccount,
      alwaysRealizeBadDebt: this.alwaysRealizeBadDebt,
      flashLoanProvider: this.flashLoanProvider,
      flashLoanFallbackProviders: this.flashLoanFallbackProviders,
      morphoAddress: this.chainAddresses.morpho,
    };
  }

  // ─── Cache lifecycle ───

  /**
   * Initialize cache: fetch all liquidatable positions + market data from API.
   * Called once at startup, then periodically via slow-path refresh.
   */
  async initializeCache(): Promise<void> {
    // Try to restore from disk snapshot first
    const cachePath = `./data/position-cache.${this.chainId}.json`;
    if (this.positionCache.loadFromFile(cachePath)) {
      console.log(`${this.logTag}🗄️ Cache restored from disk snapshot`);
    }

    await this.fetchMarkets();

    let liquidatablePositions: AccrualPosition[] = [];
    try {
      const result = await this.dataProvider.fetchLiquidatablePositions(
        this.client,
        this.coveredMarkets,
      );
      liquidatablePositions = result.liquidatablePositions;
      this._providerError = false;
      this._lastProviderOkAt = Date.now();
    } catch (e) {
      this._providerError = true;
      this._lastProviderError = e instanceof Error ? e.message : String(e);
      this._lastError = this._lastProviderError;
      this._rpcErrors++;
      console.error(
        `${this.logTag}[Provider] initializeCache fetch failed (not empty): ${this._lastProviderError}`,
      );
    }

    // Cache market state for each covered market — skip fresh cached markets
    const MARKET_CACHE_TTL_MS = Number(process.env.MARKET_CACHE_TTL_MS ?? "60000"); // 1 min default
    const staleMarkets = this.coveredMarkets.filter(
      (marketId) =>
        !this.positionCache.getMarket(marketId) ||
        this.positionCache.isMarketStale(marketId, MARKET_CACHE_TTL_MS),
    );

    if (staleMarkets.length > 0) {
      console.log(
        `${this.logTag}🔄 Refreshing ${staleMarkets.length}/${this.coveredMarkets.length} stale markets`,
      );
    }

    const marketResults = await Promise.allSettled(
      staleMarkets.map(async (marketId) => {
        const market = await fetchMarket(marketId as MarketId, this.client, {
          chainId: this.chainId,
          deployless: false,
        });
        const now = BigInt(Math.floor(Date.now() / 1000));
        const timestamp = now > market.lastUpdate ? now : market.lastUpdate;
        return [marketId, market.accrueInterest(timestamp)] as const;
      }),
    );

    let marketCount = 0;
    for (const result of marketResults) {
      if (result.status === "fulfilled") {
        const [marketId, market] = result.value;
        const state: CachedMarketState = {
          marketId,
          params: {
            loanToken: market.params.loanToken,
            collateralToken: market.params.collateralToken,
            oracle: market.params.oracle,
            irm: market.params.irm,
            lltv: market.params.lltv,
          },
          totalSupplyAssets: market.totalSupplyAssets,
          totalSupplyShares: market.totalSupplyShares,
          totalBorrowAssets: market.totalBorrowAssets,
          totalBorrowShares: market.totalBorrowShares,
          lastUpdate: market.lastUpdate ?? 0n,
          fee: market.fee ?? 0n,
          rateAtTarget: market.rateAtTarget ?? 0n,
          price: market.price ?? 0n,
          fetchedAt: Date.now(),
        };
        this.positionCache.setMarket(state);
        marketCount++;
      }
    }

    // Cache positions
    let posCount = 0;
    for (const pos of liquidatablePositions) {
      const marketId = MarketUtils.getMarketId(pos.market.params);
      const cached: CachedPosition = {
        user: pos.user,
        marketId,
        collateral: pos.collateral,
        borrowShares: pos.borrowShares,
        supplyShares: pos.supplyShares,
        updatedAt: Date.now(),
      };
      this.positionCache.set(cached);
      posCount++;
    }

    console.log(
      `${this.logTag}🗄️ Cache initialized: ${posCount} positions, ${marketCount} markets`,
    );

    // Save snapshot after successful initialization
    this.positionCache.saveToFile(cachePath);

    // Prefill DEX route cache for unique (collateral, loan) pairs in covered markets
    await this.warmDexRoutes();
  }

  /** Warm local-DEX routes for Morpho market pairs (process-lifetime venue cache). */
  private async warmDexRoutes(): Promise<void> {
    if (!shouldWarmRoutes()) {
      console.log(`${this.logTag}🔥 DEX warm skipped (SKIP_ROUTE_WARM=1)`);
      return;
    }
    const pairKeys = new Set<string>();
    const pairs: { src: Address; dst: Address }[] = [];
    const zero = "0x0000000000000000000000000000000000000000";
    for (const marketId of this.coveredMarkets) {
      const m = this.positionCache.getMarket(marketId);
      if (!m) continue;
      // Skip native-ETH (0x0) Morpho markets for ERC-20 route warm
      if (
        m.params.collateralToken.toLowerCase() === zero ||
        m.params.loanToken.toLowerCase() === zero
      ) {
        continue;
      }
      const src = getAddress(m.params.collateralToken);
      const dst = getAddress(m.params.loanToken);
      const key = `${src.toLowerCase()}->${dst.toLowerCase()}`;
      if (pairKeys.has(key)) continue;
      pairKeys.add(key);
      pairs.push({ src, dst });
    }
    if (pairs.length === 0) return;
    console.log(`${this.logTag}🔥 Warming ${pairs.length} Morpho DEX routes (prefer local AMM)…`);
    try {
      await warmVenueRouteCache(this.sharedDeps, pairs);
    } catch (e) {
      console.warn(
        `${this.logTag}⚠️ DEX warm failed (non-fatal): ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /**
   * Start periodic slow-path cache refresh.
   */
  startPeriodicRefresh(): void {
    if (this.cacheRefreshTimer) return;
    this.cacheRefreshTimer = setInterval(() => {
      void (async () => {
        try {
          console.log(`${this.logTag}🔄 Periodic cache refresh...`);
          await this.initializeCache();
        } catch (e) {
          console.error(
            `${this.logTag}Cache refresh failed: ${e instanceof Error ? e.message : e}`,
          );
        }
      })();
    }, this.cacheRefreshInterval);
  }

  stopPeriodicRefresh(): void {
    if (this.cacheRefreshTimer) {
      clearInterval(this.cacheRefreshTimer);
      this.cacheRefreshTimer = undefined;
    }
  }

  // ─── Fast path: event-driven ───

  /**
   * Handle decoded MorphoBlue events from webhook.
   * Updates cache, fetches fresh oracle prices, recalculates HF,
   * and triggers liquidation for positions with HF < 1.
   */
  /**
   * Apply Morpho event stream to position cache and optionally attempt liquidations.
   * @param options.attemptLiquidation - when false, only update cache / resync (webhook cooldown path)
   */
  async handleEvents(
    events: DecodedMorphoEvent[],
    options?: { attemptLiquidation?: boolean },
  ): Promise<void> {
    const attemptLiquidation = options?.attemptLiquidation !== false;

    // Ensure markets are loaded
    if (this.coveredMarkets.length === 0) {
      await this.fetchMarkets();
    }

    // Fast path must only touch whitelisted / vault-covered markets (audit P1)
    const coveredSet = new Set(this.coveredMarkets.map((m) => m.toLowerCase()));

    // Group events by market for efficient processing
    const affectedMarkets = new Set<Hex>();

    for (const event of events) {
      const marketId = event.marketId;
      const user = event.user;

      if (!coveredSet.has(marketId.toLowerCase())) {
        // Do not cache or liquidate markets outside the whitelist
        continue;
      }

      // Skip blacklisted tokens
      const cachedMarket = this.positionCache.getMarket(marketId);
      if (cachedMarket) {
        if (
          TOKEN_BLACKLIST.has(cachedMarket.params.loanToken.toLowerCase()) ||
          TOKEN_BLACKLIST.has(cachedMarket.params.collateralToken.toLowerCase())
        ) {
          continue;
        }
      }

      switch (event.eventName) {
        case "Borrow":
          // Debt increased → update borrowShares
          if (event.shares !== undefined) {
            this.positionCache.upsert(marketId, user, {
              borrowShares:
                (this.positionCache.get(marketId, user)?.borrowShares ?? 0n) + event.shares,
            });
            affectedMarkets.add(marketId);
          }
          break;

        case "WithdrawCollateral":
          // Collateral decreased → update collateral
          if (event.assets !== undefined) {
            const current = this.positionCache.get(marketId, user);
            if (current) {
              const newCollateral =
                current.collateral > event.assets ? current.collateral - event.assets : 0n;
              this.positionCache.upsert(marketId, user, { collateral: newCollateral });
              affectedMarkets.add(marketId);
            }
          }
          break;

        case "Repay":
          // Debt decreased → update borrowShares
          if (event.shares !== undefined) {
            const current = this.positionCache.get(marketId, user);
            if (current) {
              const newShares =
                current.borrowShares > event.shares ? current.borrowShares - event.shares : 0n;
              this.positionCache.upsert(marketId, user, { borrowShares: newShares });
              affectedMarkets.add(marketId);
            }
          }
          break;

        case "SupplyCollateral":
          // Collateral increased → update collateral
          if (event.assets !== undefined) {
            this.positionCache.upsert(marketId, user, {
              collateral: (this.positionCache.get(marketId, user)?.collateral ?? 0n) + event.assets,
            });
            // New collateral = higher HF, no liquidation opportunity, but still track
            affectedMarkets.add(marketId);
          }
          break;

        case "Withdraw":
          // Supply-side withdrawal — may affect market state but not directly position HF
          affectedMarkets.add(marketId);
          break;

        case "Liquidate":
          // Partial liquidation may leave residual debt — drop stale cache entry and
          // force chain resync via affectedMarkets (do not hard-delete without resync).
          this.positionCache.remove(marketId, user);
          affectedMarkets.add(marketId);
          break;
      }
    }

    if (affectedMarkets.size === 0) return;

    console.log(
      `${this.logTag}⚡ ${events.length} event(s) → ${affectedMarkets.size} market(s) affected` +
        (attemptLiquidation ? ", checking HF..." : " (cache/resync only)"),
    );

    // For each affected market: refresh price + resync positions; optionally liquidate
    await Promise.allSettled(
      [...affectedMarkets].map(async (marketId) => {
        try {
          const cachedMarket = this.positionCache.getMarket(marketId);
          if (!cachedMarket) {
            await this.refreshMarketInCache(marketId);
            return;
          }

          const freshPrice = await readContract(this.client, {
            address: cachedMarket.params.oracle,
            abi: oracleAbi,
            functionName: "price",
          });
          this.positionCache.updateOraclePrice(marketId, freshPrice);

          const eventsForMarket = events.filter((e) => e.marketId === marketId);
          for (const event of eventsForMarket) {
            const cached = this.positionCache.get(marketId, event.user);
            // Always resync on Liquidate (partial residual debt); otherwise fill missing cache
            const forceResync = event.eventName === "Liquidate";
            if (forceResync || !cached || cached.collateral === 0n) {
              try {
                const position = await this.readPositionFromChain(marketId, event.user);
                if (position) {
                  this.positionCache.upsert(marketId, event.user, position);
                  console.log(
                    `${this.logTag}  📥 Synced ${event.user} from chain: collateral=${position.collateral}, borrowShares=${position.borrowShares}`,
                  );
                }
              } catch {
                // Ignore chain read errors
              }
            }
          }

          if (!attemptLiquidation) return;

          const atRisk = this.positionCache.findAtRiskPositions(marketId, 1, freshPrice);

          if (atRisk.length === 0) {
            console.log(
              `${this.logTag}  Market ${marketId.slice(0, 10)}... — no at-risk positions`,
            );
            return;
          }

          console.log(
            `${this.logTag}  Market ${marketId.slice(0, 10)}... — ${atRisk.length} at-risk position(s)!`,
          );

          for (const { position: cachedPos } of atRisk) {
            const accrualPos = this.positionCache.buildAccrualPosition(
              marketId,
              cachedPos.user,
              freshPrice,
            );
            if (!accrualPos) continue;

            await this.liquidate(accrualPos);
          }
        } catch (e) {
          this._rpcErrors++;
          this._lastError = e instanceof Error ? e.message : String(e);
          console.error(
            `${this.logTag}Error processing market ${marketId.slice(0, 10)}...: ${this._lastError}`,
          );
        }
      }),
    );
  }

  /**
   * Read a position directly from chain (for positions not in cache).
   */
  private async readPositionFromChain(
    marketId: Hex,
    user: Address,
  ): Promise<{ collateral: bigint; borrowShares: bigint; supplyShares: bigint } | null> {
    const morphoAddress = this.chainAddresses.morpho;
    const positionAbi = [
      {
        inputs: [
          { name: "id", type: "bytes32" },
          { name: "user", type: "address" },
        ],
        name: "position",
        outputs: [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }],
        stateMutability: "view",
        type: "function",
      },
    ] as const;

    const result = await readContract(this.client, {
      address: morphoAddress,
      abi: positionAbi,
      functionName: "position",
      args: [marketId, user],
    });

    return {
      supplyShares: result[0],
      borrowShares: result[1],
      collateral: result[2],
    };
  }

  private async refreshMarketInCache(marketId: Hex): Promise<void> {
    try {
      const market = await fetchMarket(marketId as MarketId, this.client, {
        chainId: this.chainId,
        deployless: false,
      });
      const now = BigInt(Math.floor(Date.now() / 1000));
      const timestamp = now > market.lastUpdate ? now : market.lastUpdate;
      const accrued = market.accrueInterest(timestamp);

      this.positionCache.setMarket({
        marketId,
        params: {
          loanToken: accrued.params.loanToken,
          collateralToken: accrued.params.collateralToken,
          oracle: accrued.params.oracle,
          irm: accrued.params.irm,
          lltv: accrued.params.lltv,
        },
        totalSupplyAssets: accrued.totalSupplyAssets,
        totalSupplyShares: accrued.totalSupplyShares,
        totalBorrowAssets: accrued.totalBorrowAssets,
        totalBorrowShares: accrued.totalBorrowShares,
        lastUpdate: accrued.lastUpdate ?? 0n,
        fee: accrued.fee ?? 0n,
        rateAtTarget: accrued.rateAtTarget ?? 0n,
        price: accrued.price ?? 0n,
        fetchedAt: Date.now(),
      });
    } catch (e) {
      console.error(
        `${this.logTag}Failed to refresh market ${marketId.slice(0, 10)}...: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // ─── Slow path: full API refresh (original behavior) ───

  async run() {
    this._lastCheckTimestamp = Math.floor(Date.now() / 1000);
    this.slowPathTicks += 1;
    const t0 = nowMs();

    await this.fetchMarkets();

    const tFetch = nowMs();
    let liquidatablePositions: AccrualPosition[] = [];
    let preLiquidatablePositions: Awaited<
      ReturnType<DataProvider["fetchLiquidatablePositions"]>
    >["preLiquidatablePositions"] = [];

    try {
      const result = await this.dataProvider.fetchLiquidatablePositions(
        this.client,
        this.coveredMarkets,
      );
      liquidatablePositions = result.liquidatablePositions;
      preLiquidatablePositions = result.preLiquidatablePositions;
      this._providerError = false;
      this._lastProviderOkAt = Date.now();
    } catch (e) {
      // Provider failure must NOT look like "idle / nothing to do"
      this._providerError = true;
      this._lastProviderError = e instanceof Error ? e.message : String(e);
      this._lastError = this._lastProviderError;
      this._rpcErrors++;
      this._rpcTotal++;
      console.error(
        `${this.logTag}[Provider] fetchLiquidatablePositions FAILED (not empty): ${this._lastProviderError}`,
      );
      this.raceMetrics.onTick({
        logTag: this.logTag,
        mode: "full",
        accounts: 0,
        hot: 0,
        liquidatable: 0,
        hfScanMs: elapsedMs(tFetch),
      });
      return;
    }
    this._rpcTotal++;
    const fetchMs = elapsedMs(tFetch);

    // Update cache with fresh data
    for (const pos of liquidatablePositions) {
      const marketId = MarketUtils.getMarketId(pos.market.params);
      this.positionCache.set({
        user: pos.user,
        marketId,
        collateral: pos.collateral,
        borrowShares: pos.borrowShares,
        supplyShares: pos.supplyShares,
        updatedAt: Date.now(),
      });
    }

    // Sort by estimated profit (borrowAssets) descending — high-value positions first
    liquidatablePositions.sort((a, b) => {
      const aProfit = a.borrowAssets ?? 0n;
      const bProfit = b.borrowAssets ?? 0n;
      return bProfit > aProfit ? 1 : bProfit < aProfit ? -1 : 0;
    });

    this.raceMetrics.onTick({
      logTag: this.logTag,
      mode: "full",
      accounts: liquidatablePositions.length,
      hot: liquidatablePositions.length,
      liquidatable: liquidatablePositions.length,
      hfScanMs: fetchMs,
    });

    console.log(
      `${this.logTag}[RaceTick] slow-path fetchMs=${fetchMs} liquidatable=${liquidatablePositions.length} preLiq=${preLiquidatablePositions.length} totalMs=${elapsedMs(t0)}`,
    );

    // Serial execution to ensure high-value positions are prioritized
    for (const position of liquidatablePositions) {
      await this.liquidate(position);
    }
    for (const position of preLiquidatablePositions) {
      await this.preLiquidate(position);
    }
  }

  private async liquidate(position: AccrualPosition) {
    const marketParams = position.market.params;
    const marketId = MarketUtils.getMarketId(marketParams);
    const tTotal = nowMs();

    // Defense in depth: never liquidate outside coveredMarkets (whitelist / vaults)
    if (!this.coveredMarkets.some((m) => m.toLowerCase() === marketId.toLowerCase())) {
      console.warn(
        `${this.logTag}Skipping liquidation outside coveredMarkets: ${marketId.slice(0, 12)}…`,
      );
      return;
    }

    // SECURITY: Skip markets involving blacklisted tokens
    if (
      TOKEN_BLACKLIST.has(marketParams.loanToken.toLowerCase()) ||
      TOKEN_BLACKLIST.has(marketParams.collateralToken.toLowerCase())
    ) {
      this.raceMetrics.recordOutcome("skip_blacklist");
      logLiquidationDebug({
        protocol: this.logTag,
        account: position.user,
        healthFactor: healthFactorToNumber(position.healthFactor),
        collateral: {
          token: marketParams.collateralToken,
          amount: position.collateral,
        },
        debt: {
          token: marketParams.loanToken,
          amount: position.borrowAssets ?? position.borrowShares,
        },
        decision: "skip",
        reason: "Blacklisted token in market",
        details: {
          marketId,
          loanTokenBlacklisted: TOKEN_BLACKLIST.has(marketParams.loanToken.toLowerCase()),
          collateralTokenBlacklisted: TOKEN_BLACKLIST.has(
            marketParams.collateralToken.toLowerCase(),
          ),
        },
      });
      return;
    }

    const seizableCollateral = position.seizableCollateral ?? 0n;
    const badDebtPosition = seizableCollateral === position.collateral;
    const borrowAssets = position.borrowAssets ?? 0n;

    // Bad debt pre-filter — before cooldown so underwater never arms the timer
    if (!this.alwaysRealizeBadDebt && badDebtPosition) {
      this.raceMetrics.recordOutcome("skip_bad_debt");
      logLiquidationDebug({
        protocol: this.logTag,
        account: position.user,
        healthFactor: healthFactorToNumber(position.healthFactor),
        collateral: {
          token: marketParams.collateralToken,
          amount: position.collateral,
        },
        debt: {
          token: marketParams.loanToken,
          amount: borrowAssets || position.borrowShares,
        },
        seizableCollateral,
        isBadDebt: badDebtPosition,
        decision: "skip",
        reason: "Bad debt position (collateral fully seizable, no liquidation bonus)",
        details: {
          marketId,
          alwaysRealizeBadDebt: this.alwaysRealizeBadDebt,
          note: "Position is underwater and bot is configured to skip bad debt",
        },
      });
      return;
    }

    // Peek cooldown first so dust skips don't re-log / re-arm every webhook tick
    if (this.isCoolingDown(marketId, position.user)) {
      this.raceMetrics.recordOutcome("skip_cooldown");
      return;
    }

    // Nothing to seize (dust / rounding) — skip + soft cooldown so webhook won't spam
    if (seizableCollateral === 0n) {
      this.armCooldown(marketId, position.user, "soft", "seizableCollateral=0", "fail_soft_profit");
      logLiquidationDebug({
        protocol: this.logTag,
        account: position.user,
        healthFactor: healthFactorToNumber(position.healthFactor),
        collateral: {
          token: marketParams.collateralToken,
          amount: position.collateral,
        },
        debt: {
          token: marketParams.loanToken,
          amount: borrowAssets || position.borrowShares,
        },
        seizableCollateral,
        isBadDebt: badDebtPosition,
        decision: "skip",
        reason: "Seizable collateral is 0 (dust position or not liquidatable for profit)",
        details: {
          marketId,
          collateral: position.collateral.toString(),
          borrowAssets: borrowAssets.toString(),
        },
      });
      return;
    }

    // Dust debt — swap minOut / gas will fail; soft cooldown
    if (isDustLoanAmount(borrowAssets, getAddress(marketParams.loanToken))) {
      this.armCooldown(
        marketId,
        position.user,
        "soft",
        `dust debt borrowAssets=${borrowAssets}`,
        "fail_soft_profit",
      );
      logLiquidationDebug({
        protocol: this.logTag,
        account: position.user,
        healthFactor: healthFactorToNumber(position.healthFactor),
        collateral: {
          token: marketParams.collateralToken,
          amount: position.collateral,
        },
        debt: {
          token: marketParams.loanToken,
          amount: borrowAssets,
        },
        seizableCollateral,
        isBadDebt: badDebtPosition,
        decision: "skip",
        reason: "Dust debt too small to cover swap + gas",
        details: {
          marketId,
          borrowAssets: borrowAssets.toString(),
        },
      });
      return;
    }

    // All checks passed, proceed with liquidation
    logLiquidationDebug({
      protocol: this.logTag,
      account: position.user,
      healthFactor: healthFactorToNumber(position.healthFactor),
      collateral: {
        token: marketParams.collateralToken,
        amount: position.collateral,
      },
      debt: {
        token: marketParams.loanToken,
        amount: borrowAssets || position.borrowShares,
      },
      seizableCollateral,
      isBadDebt: badDebtPosition,
      decision: "liquidate",
      reason: "All checks passed, proceeding with liquidation",
      details: {
        marketId,
        useFlashLoan: this.useFlashLoan,
        alwaysRealizeBadDebt: this.alwaysRealizeBadDebt,
      },
    });

    this._liquidationsAttempted++;
    console.log(
      `${this.logTag}  🎯 ${position.user} HF=${formatHealthFactor(position.healthFactor)} — attempting liquidation`,
    );

    if (this.useFlashLoan) {
      await this.liquidateWithFlashLoan(position, badDebtPosition);
      this.raceMetrics.recordStage("totalLiq", elapsedMs(tTotal));
      return;
    }

    // Direct liquidation path (no flash loan)
    const { client, executorAddress } = this;

    // Use the same buffered seize amount for both liquidate and swap
    const seizedForLiq = this.decreaseSeizableCollateral(seizableCollateral, badDebtPosition);
    if (seizedForLiq === 0n) {
      this.armCooldown(marketId, position.user, "soft", "seizedForLiq=0", "fail_soft_profit");
      this.raceMetrics.recordStage("totalLiq", elapsedMs(tTotal));
      return;
    }
    const estimatedRepaid = estimateRepaidAssets(position, seizedForLiq);

    console.log(
      `${this.logTag}[Direct Debug] ${position.user}: seizableCollateral=${seizableCollateral}, seizedForLiq=${seizedForLiq}, estimatedRepaid=${estimatedRepaid}, badDebt=${badDebtPosition}`,
    );

    const encoder = new LiquidationEncoder(executorAddress, client);

    const swap = await sharedConvertCollateralToLoan(
      this.sharedDeps,
      getAddress(marketParams.collateralToken),
      getAddress(marketParams.loanToken),
      seizedForLiq,
      encoder,
      { preferLocalDex: true },
    );
    this.recordConvertMetrics(swap);
    if (!swap.success) {
      this._liquidationsFailed++;
      this.armCooldown(marketId, position.user, "soft", "no DEX route", "skip_no_route");
      console.log(
        `${this.logTag}No DEX route for ${marketParams.collateralToken} -> ${marketParams.loanToken}, skip direct`,
      );
      this.raceMetrics.recordStage("totalLiq", elapsedMs(tTotal));
      return;
    }

    // Only approve if allowance is insufficient (loan-token units, not collateral)
    const morphoAddress = this.chainAddresses.morpho;
    const currentAllowance = await readContract(this.client, {
      address: marketParams.loanToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [executorAddress, morphoAddress],
    });
    if (currentAllowance < estimatedRepaid) {
      encoder.erc20Approve(marketParams.loanToken, morphoAddress, maxUint256);
    }

    encoder.morphoBlueLiquidate(
      this.chainAddresses.morpho,
      {
        loanToken: marketParams.loanToken,
        collateralToken: marketParams.collateralToken,
        oracle: marketParams.oracle,
        irm: marketParams.irm,
        lltv: marketParams.lltv,
      },
      position.user,
      seizedForLiq,
      0n,
      encoder.flush(),
    );
    encoder.erc20Skim(marketParams.loanToken, this.treasuryAddress);

    const calls = encoder.flush();

    try {
      const tSim = nowMs();
      const execResult = await simulateAndExec(
        this.sharedDeps,
        encoder,
        calls,
        marketParams.loanToken,
        badDebtPosition,
        undefined,
        undefined,
        getAddress(marketParams.collateralToken),
      );
      this.raceMetrics.recordStage("simExec", elapsedMs(tSim));
      console.log(
        `${this.logTag}[LiqTiming] direct user=${position.user.slice(0, 10)}… simExecMs=${elapsedMs(tSim)} ok=${execResult.success}` +
          (execResult.reason ? ` reason=${execResult.reason}` : ""),
      );

      if (execResult.success) {
        this._liquidationsSucceeded++;
        this.armCooldown(marketId, position.user, "success");
        const collateralUsd =
          (await priceAsset(
            this.sharedDeps,
            getAddress(marketParams.collateralToken),
            seizedForLiq,
          )) ?? 0;
        liquidationTracker.report({
          protocol: this.logTag,
          collateralToken: getAddress(marketParams.collateralToken),
          collateralAmount: seizedForLiq,
          collateralUsdEstimate: collateralUsd,
          timestamp: Date.now(),
        });
        console.log(`${this.logTag}Liquidated ${position.user} on ${marketId}`);
      } else {
        this._liquidationsFailed++;
        const why = execResult.reason ?? "sim_or_profit_fail";
        this.armCooldown(marketId, position.user, "soft", why);
        console.log(`${this.logTag}ℹ️ Skipped ${position.user} on ${marketId} (${why})`);
      }
    } catch (error) {
      this._liquidationsFailed++;
      this._lastError = String(error);
      this.armCooldownFromError(marketId, position.user, error);
      console.error(`${this.logTag}Failed to liquidate ${position.user} on ${marketId}`, error);
    }
    this.raceMetrics.recordStage("totalLiq", elapsedMs(tTotal));
  }

  /**
   * Flash-loan-backed liquidation path.
   * Uses the executor's native balancerFlashLoan() — zero upfront capital needed.
   *
   * Flow (all within a single executor transaction):
   *   1. Borrow loan tokens from Balancer V2 (0% fee)
   *   2. Approve Morpho + liquidate borrower position
   *   3. Swap seized collateral → loan token via DEX
   *   4. Repay Balancer flash loan
   *   5. Leftover loan token stays on executor (skim separately)
   */
  private async liquidateWithFlashLoan(position: AccrualPosition, badDebtPosition: boolean) {
    const marketParams = position.market.params;
    const marketId = MarketUtils.getMarketId(marketParams);
    const seizableCollateral = position.seizableCollateral ?? 0n;
    const { client, executorAddress } = this;

    if (seizableCollateral === 0n) {
      this.armCooldown(marketId, position.user, "soft", "seizableCollateral=0", "fail_soft_profit");
      console.log(`${this.logTag}[FlashLoan] Skip ${position.user}: seizableCollateral=0 (dust)`);
      return;
    }

    // Same buffered seize for liquidate + swap; flash amount = estimated repaid (not full debt)
    const seizedForLiq = this.decreaseSeizableCollateral(seizableCollateral, badDebtPosition);
    if (seizedForLiq === 0n) {
      this.armCooldown(marketId, position.user, "soft", "seizedForLiq=0", "fail_soft_profit");
      return;
    }

    const flashLoanAmount = estimateRepaidAssets(position, seizedForLiq);
    if (flashLoanAmount === 0n) return;

    console.log(
      `${this.logTag}[FlashLoan Debug] ${position.user}: flashLoanAmount=${flashLoanAmount}, seizableCollateral=${seizableCollateral}, seizedForLiq=${seizedForLiq}, collateral=${position.collateral}, collateralValue=${position.collateralValue ?? "undefined"}, badDebt=${badDebtPosition}`,
    );

    // ── Profitability pre-filter: seizable value vs estimated repaid (not full debt) ──
    const collateralValue = position.collateralValue;
    if (collateralValue !== undefined) {
      const totalCollateral = position.collateral;
      const seizableValue =
        totalCollateral > 0n ? (collateralValue * seizedForLiq) / totalCollateral : 0n;

      // Full-position underwater only matters when we seize everything
      if (
        badDebtPosition &&
        !this.alwaysRealizeBadDebt &&
        collateralValue < (position.borrowAssets ?? 0n)
      ) {
        this.raceMetrics.recordOutcome("skip_bad_debt");
        if (this.positionLiquidationCooldownMechanism) {
          const seconds = this.positionLiquidationCooldownMechanism.markClass(
            marketId,
            position.user,
            "soft",
          );
          console.log(
            `${this.logTag}⏳ Cooldown soft ${seconds}s for ${position.user.slice(0, 10)}… (full bad debt)`,
          );
        }
        console.log(
          `${this.logTag}[FlashLoan] Skip ${position.user}: bad debt — full collateral value (${collateralValue}) < full debt (${position.borrowAssets})`,
        );
        return;
      }

      if (seizableValue < flashLoanAmount) {
        this.armCooldown(
          marketId,
          position.user,
          "soft",
          `seizable value ${seizableValue} < repaid ${flashLoanAmount}`,
          "fail_soft_profit",
        );
        console.log(
          `${this.logTag}[FlashLoan] Skip ${position.user}: seizable value (${seizableValue}) < estimated repaid (${flashLoanAmount}) — not enough collateral to seize for profit`,
        );
        return;
      }
    }

    // Build flash loan callback: approve → liquidate → swap (same encoder, no double wrap)
    const callbackEncoder = new LiquidationEncoder(executorAddress, client);

    const currentAllowance = await readContract(this.client, {
      address: marketParams.loanToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [executorAddress, this.chainAddresses.morpho],
    });
    if (currentAllowance < flashLoanAmount) {
      callbackEncoder.erc20Approve(marketParams.loanToken, this.chainAddresses.morpho, maxUint256);
    }
    // Flush approve into liquidate's onMorphoLiquidate data (if any), then liquidate
    const approveData = callbackEncoder.flush();
    callbackEncoder.morphoBlueLiquidate(
      this.chainAddresses.morpho,
      {
        loanToken: marketParams.loanToken,
        collateralToken: marketParams.collateralToken,
        oracle: marketParams.oracle,
        irm: marketParams.irm,
        lltv: marketParams.lltv,
      },
      position.user,
      seizedForLiq,
      0n,
      approveData,
    );

    const swap = await sharedConvertCollateralToLoan(
      this.sharedDeps,
      getAddress(marketParams.collateralToken),
      getAddress(marketParams.loanToken),
      seizedForLiq,
      callbackEncoder,
      { preferLocalDex: true },
    );
    this.recordConvertMetrics(swap);

    if (!swap.success) {
      this._liquidationsFailed++;
      this.armCooldown(marketId, position.user, "soft", "no DEX route", "skip_no_route");
      console.log(
        `${this.logTag}No DEX route for ${marketParams.collateralToken} -> ${marketParams.loanToken}, skipping flash loan liquidation`,
      );
      return;
    }

    const venueImpactBps = swap.impactBps;
    console.log(
      `${this.logTag}[FlashLoan Debug] DEX route via=${swap.via} ${swap.elapsedMs ?? "?"}ms`,
    );

    // Do NOT erc20Skim before flash repay (appended after callbacks).
    const callbackCalls = callbackEncoder.flush();

    // Step 3: simulate + execute
    try {
      const tSim = nowMs();
      const execResult = await simulateAndExecFlashLoanWithFallback(
        this.sharedDeps,
        callbackCalls,
        marketParams.loanToken,
        badDebtPosition,
        flashLoanAmount,
        getAddress(marketParams.collateralToken),
        undefined,
        venueImpactBps,
      );
      const simMs = elapsedMs(tSim);
      this.raceMetrics.recordStage("simExec", simMs);
      console.log(
        `${this.logTag}[LiqTiming] flash user=${position.user.slice(0, 10)}… simExecMs=${simMs} ok=${execResult.success}` +
          (execResult.reason ? ` reason=${execResult.reason}` : ""),
      );

      if (execResult.success) {
        this._liquidationsSucceeded++;
        this.armCooldown(marketId, position.user, "success");
        const collateralUsd =
          (await priceAsset(
            this.sharedDeps,
            getAddress(marketParams.collateralToken),
            seizedForLiq,
          )) ?? 0;
        liquidationTracker.report({
          protocol: this.logTag,
          collateralToken: getAddress(marketParams.collateralToken),
          collateralAmount: seizedForLiq,
          collateralUsdEstimate: collateralUsd,
          timestamp: Date.now(),
        });
        console.log(`${this.logTag}[FlashLoan] Liquidated ${position.user} on ${marketId}`);
      } else {
        this._liquidationsFailed++;
        const why = execResult.reason ?? "sim_or_profit_fail";
        this.armCooldown(marketId, position.user, "soft", why);
        console.log(`${this.logTag}[FlashLoan] Skipped ${position.user} on ${marketId} (${why})`);
      }
    } catch (error) {
      this._liquidationsFailed++;
      this._lastError = String(error);
      this.armCooldownFromError(marketId, position.user, error);
      console.error(
        `${this.logTag}[FlashLoan] Failed to liquidate ${position.user} on ${marketId}`,
        error,
      );
    }
  }

  private async preLiquidate(position: PreLiquidationPosition) {
    const marketParams = position.market.params;
    const marketId = MarketUtils.getMarketId(marketParams);

    if (!this.coveredMarkets.some((m) => m.toLowerCase() === marketId.toLowerCase())) {
      console.warn(
        `${this.logTag}Skipping pre-liquidate outside coveredMarkets: ${marketId.slice(0, 12)}…`,
      );
      return;
    }

    // SECURITY: Skip markets involving blacklisted tokens
    if (
      TOKEN_BLACKLIST.has(marketParams.loanToken.toLowerCase()) ||
      TOKEN_BLACKLIST.has(marketParams.collateralToken.toLowerCase())
    ) {
      console.log(
        `${this.logTag}⛔ Skip pre-liquidate ${position.user}: blacklisted token in market ${marketId.slice(0, 10)}...`,
      );
      return;
    }
    const seizableCollateral = this.decreaseSeizableCollateral(
      position.seizableCollateral ?? 0n,
      false,
    );

    if (this.isCoolingDown(marketId, position.user)) {
      this.raceMetrics.recordOutcome("skip_cooldown");
      return;
    }

    this._liquidationsAttempted++;

    const { client, executorAddress } = this;

    const encoder = new LiquidationEncoder(executorAddress, client);

    const swap = await sharedConvertCollateralToLoan(
      this.sharedDeps,
      getAddress(marketParams.collateralToken),
      getAddress(marketParams.loanToken),
      seizableCollateral,
      encoder,
      { preferLocalDex: true },
    );
    this.recordConvertMetrics(swap);
    if (!swap.success) {
      this._liquidationsFailed++;
      this.armCooldown(marketId, position.user, "soft", "no DEX route", "skip_no_route");
      return;
    }

    // Only approve if allowance is insufficient (loan-token units for repaid amount)
    const currentAllowance = await readContract(this.client, {
      address: marketParams.loanToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [executorAddress, position.preLiquidation],
    });
    // Pre-liq repaid is roughly seizable-linked; use full debt as safe upper bound
    const preLiqRepayBound = position.borrowAssets ?? seizableCollateral;
    if (currentAllowance < preLiqRepayBound) {
      encoder.erc20Approve(marketParams.loanToken, position.preLiquidation, maxUint256);
    }

    encoder.preLiquidate(
      position.preLiquidation,
      position.user,
      seizableCollateral,
      0n,
      encoder.flush(),
    );
    encoder.erc20Skim(marketParams.loanToken, this.treasuryAddress);

    const calls = encoder.flush();

    try {
      const tSim = nowMs();
      const execResult = await simulateAndExec(
        this.sharedDeps,
        encoder,
        calls,
        marketParams.loanToken,
        false,
        undefined,
        undefined,
        getAddress(marketParams.collateralToken),
      );
      this.raceMetrics.recordStage("simExec", elapsedMs(tSim));

      if (execResult.success) {
        this._liquidationsSucceeded++;
        this.armCooldown(marketId, position.user, "success");
        const collateralUsd =
          (await priceAsset(
            this.sharedDeps,
            getAddress(marketParams.collateralToken),
            seizableCollateral,
          )) ?? 0;
        liquidationTracker.report({
          protocol: this.logTag,
          collateralToken: getAddress(marketParams.collateralToken),
          collateralAmount: seizableCollateral,
          collateralUsdEstimate: collateralUsd,
          timestamp: Date.now(),
        });
        console.log(`${this.logTag}Pre-liquidated ${position.user} on ${marketId}`);
      } else {
        this._liquidationsFailed++;
        const why = execResult.reason ?? "sim_or_profit_fail";
        this.armCooldown(marketId, position.user, "soft", why);
        console.log(`${this.logTag}ℹ️ Skipped ${position.user} on ${marketId} (${why})`);
      }
    } catch (error) {
      this._liquidationsFailed++;
      this._lastError = String(error);
      this.armCooldownFromError(marketId, position.user, error);
      console.error(`${this.logTag}Failed to pre-liquidate ${position.user} on ${marketId}`, error);
    }
  }

  private decreaseSeizableCollateral(seizableCollateral: bigint, badDebtPosition: boolean) {
    if (badDebtPosition) return seizableCollateral;

    const liquidationBufferBps =
      chainConfigs[this.chainId]?.options.liquidationBufferBps ?? DEFAULT_LIQUIDATION_BUFFER_BPS;

    return wMulDown(seizableCollateral, WAD - parseUnits(liquidationBufferBps.toString(), 14));
  }

  private isCoolingDown(marketId: Hex, account: Address): boolean {
    return this.positionLiquidationCooldownMechanism?.isCoolingDown(marketId, account) ?? false;
  }

  private armCooldown(
    marketId: Hex,
    account: Address,
    cls: CooldownClass,
    detail?: string,
    metricsOutcome?: "success" | "fail_race" | "fail_soft_profit" | "fail_hard" | "skip_no_route",
  ): void {
    if (metricsOutcome) {
      this.raceMetrics.recordOutcome(metricsOutcome);
    } else if (cls === "race") {
      this.raceMetrics.recordOutcome("fail_race");
    } else if (cls === "soft") {
      this.raceMetrics.recordOutcome("fail_soft_profit");
    } else if (cls === "success") {
      this.raceMetrics.recordOutcome("success");
    } else if (cls === "hard") {
      this.raceMetrics.recordOutcome("fail_hard");
    }

    if (!this.positionLiquidationCooldownMechanism) return;
    const seconds = this.positionLiquidationCooldownMechanism.markClass(marketId, account, cls);
    console.log(
      `${this.logTag}⏳ Cooldown ${cls} ${seconds}s for ${account.slice(0, 10)}…` +
        (detail ? ` (${detail.slice(0, 100)})` : ""),
    );
  }

  private armCooldownFromError(marketId: Hex, account: Address, error: unknown): void {
    if (isLiquidationRaceLostError(error) || classifyLiquidationFailure(error) === "race") {
      this.armCooldown(
        marketId,
        account,
        "race",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const cls = classifyLiquidationFailure(error);
    this.armCooldown(
      marketId,
      account,
      cls,
      error instanceof Error ? error.message : String(error),
    );
  }

  private recordConvertMetrics(swap: { success: boolean; via?: string; elapsedMs?: number }): void {
    const ms = swap.elapsedMs ?? 0;
    const via = !swap.success
      ? "fail"
      : swap.via === "cache" || swap.via === "probe" || swap.via === "same"
        ? swap.via
        : "probe";
    this.raceMetrics.recordConvert(ms, via);
  }

  private async fetchMarkets() {
    if (!this.marketsFetchingCooldownMechanism.isFetchingReady()) return;

    if (this.vaultWhitelist === "morpho-api")
      this.vaultWhitelist = await fetchWhitelistedVaults(this.chainId);

    const vaultWhitelist = this.vaultWhitelist;
    console.log(`${this.logTag}📝 Watching markets in the following vaults:`, vaultWhitelist);

    try {
      this._rpcTotal++;
      const whitelistedMarketsFromVaults = await this.dataProvider.fetchMarkets(
        this.client,
        vaultWhitelist,
      );

      // SECURITY (NH2): 動態重新載入 discovery 層批准的市場，而非僅啟動時靜態載入
      const dynamicApprovedMarkets = loadApprovedMarketIds(this.chainId);
      const allAdditional = [
        ...new Set([...this.additionalMarketsWhitelist, ...dynamicApprovedMarkets]),
      ];

      this.coveredMarkets = [...whitelistedMarketsFromVaults, ...allAdditional];

      console.log(
        `${this.logTag}📝 Covered markets: ${this.coveredMarkets.length} (vault: ${whitelistedMarketsFromVaults.length}, additional: ${allAdditional.length})`,
      );
    } catch (e) {
      this._rpcErrors++;
      this._lastError = String(e);
      console.error(`${this.logTag}Failed to fetch markets: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Get current bot health status for monitoring endpoints.
   */
  getHealthStatus() {
    const rpcErrorRate = this._rpcTotal > 0 ? this._rpcErrors / this._rpcTotal : 0;
    const providerOk = !this._providerError;
    return {
      protocol: "morpho" as const,
      lastCheckTimestamp: this._lastCheckTimestamp,
      lastCheckBlock: this._lastCheckBlock,
      registryAccountCount: this.positionCache.stats.positions,
      cachedReservesCount: this.coveredMarkets.length,
      liquidationsAttempted: this._liquidationsAttempted,
      liquidationsSucceeded: this._liquidationsSucceeded,
      liquidationsFailed: this._liquidationsFailed,
      rpcErrors: this._rpcErrors,
      rpcTotal: this._rpcTotal,
      rpcErrorRate,
      lastError: this._lastError,
      providerError: this._providerError,
      lastProviderError: this._lastProviderError,
      lastProviderOkAt: this._lastProviderOkAt || undefined,
      // Provider outage is unhealthy even when "0 liquidatable" would look idle
      isHealthy: providerOk && rpcErrorRate < 0.3,
      raceMetrics: this.raceMetrics.snapshot(),
    };
  }
}
