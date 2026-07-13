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

    const { liquidatablePositions } = await this.dataProvider.fetchLiquidatablePositions(
      this.client,
      this.coveredMarkets,
    );

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
    for (const marketId of this.coveredMarkets) {
      const m = this.positionCache.getMarket(marketId);
      if (!m) continue;
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
  async handleEvents(events: DecodedMorphoEvent[]): Promise<void> {
    // Ensure markets are loaded
    if (this.coveredMarkets.length === 0) {
      await this.fetchMarkets();
    }

    // Group events by market for efficient processing
    const affectedMarkets = new Set<Hex>();

    for (const event of events) {
      const marketId = event.marketId;
      const user = event.user;

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
          // Position was liquidated (by us or someone else) → remove from cache
          this.positionCache.remove(marketId, user);
          break;
      }
    }

    if (affectedMarkets.size === 0) return;

    console.log(
      `${this.logTag}⚡ ${events.length} event(s) → ${affectedMarkets.size} market(s) affected, checking HF...`,
    );

    // For each affected market, fetch fresh oracle price and check HF (in parallel)
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
            if (!cached || cached.collateral === 0n) {
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
    const { liquidatablePositions, preLiquidatablePositions } =
      await this.dataProvider.fetchLiquidatablePositions(this.client, this.coveredMarkets);
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

    // SECURITY: Skip markets involving blacklisted tokens
    if (
      TOKEN_BLACKLIST.has(marketParams.loanToken.toLowerCase()) ||
      TOKEN_BLACKLIST.has(marketParams.collateralToken.toLowerCase())
    ) {
      this.raceMetrics.recordOutcome("skip_blacklist");
      logLiquidationDebug({
        protocol: this.logTag,
        account: position.user,
        healthFactor:
          position.healthFactor !== undefined ? Number(position.healthFactor) / 1e18 : undefined,
        collateral: {
          token: marketParams.collateralToken,
          amount: position.collateral,
        },
        debt: {
          token: marketParams.loanToken,
          amount: position.borrowShares,
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

    // Bad debt pre-filter — before cooldown so underwater never arms the timer
    if (!this.alwaysRealizeBadDebt && badDebtPosition) {
      this.raceMetrics.recordOutcome("skip_bad_debt");
      logLiquidationDebug({
        protocol: this.logTag,
        account: position.user,
        healthFactor:
          position.healthFactor !== undefined ? Number(position.healthFactor) / 1e18 : undefined,
        collateral: {
          token: marketParams.collateralToken,
          amount: position.collateral,
        },
        debt: {
          token: marketParams.loanToken,
          amount: position.borrowShares,
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

    // Peek only — arm after real attempt (graded race/soft/hard)
    if (this.isCoolingDown(marketId, position.user)) {
      this.raceMetrics.recordOutcome("skip_cooldown");
      logLiquidationDebug({
        protocol: this.logTag,
        account: position.user,
        healthFactor:
          position.healthFactor !== undefined ? Number(position.healthFactor) / 1e18 : undefined,
        collateral: {
          token: marketParams.collateralToken,
          amount: position.collateral,
        },
        debt: {
          token: marketParams.loanToken,
          amount: position.borrowShares,
        },
        seizableCollateral,
        isBadDebt: badDebtPosition,
        decision: "skip",
        reason: "Position is in cooldown period",
        details: {
          marketId,
          note: "Recently attempted liquidation, waiting before retry",
        },
      });
      return;
    }

    // All checks passed, proceed with liquidation
    logLiquidationDebug({
      protocol: this.logTag,
      account: position.user,
      healthFactor:
        position.healthFactor !== undefined ? Number(position.healthFactor) / 1e18 : undefined,
      collateral: {
        token: marketParams.collateralToken,
        amount: position.collateral,
      },
      debt: {
        token: marketParams.loanToken,
        amount: position.borrowShares,
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
    const hf = position.healthFactor;
    console.log(
      `${this.logTag}  🎯 ${position.user} HF=${hf !== undefined ? Number(hf).toFixed(4) : "?"} — attempting liquidation`,
    );

    if (this.useFlashLoan) {
      await this.liquidateWithFlashLoan(position, badDebtPosition);
      this.raceMetrics.recordStage("totalLiq", elapsedMs(tTotal));
      return;
    }

    // Direct liquidation path (no flash loan)
    const { client, executorAddress } = this;

    console.log(
      `${this.logTag}[Direct Debug] ${position.user}: seizableCollateral=${seizableCollateral}, badDebt=${badDebtPosition}`,
    );

    const encoder = new LiquidationEncoder(executorAddress, client);

    const swap = await sharedConvertCollateralToLoan(
      this.sharedDeps,
      getAddress(marketParams.collateralToken),
      getAddress(marketParams.loanToken),
      this.decreaseSeizableCollateral(seizableCollateral, badDebtPosition),
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

    // Only approve if allowance is insufficient (saves ~5k-21k gas per tx)
    const morphoAddress = this.chainAddresses.morpho;
    const currentAllowance = await readContract(this.client, {
      address: marketParams.loanToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [executorAddress, morphoAddress],
    });
    if (currentAllowance < seizableCollateral) {
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
      seizableCollateral,
      0n,
      encoder.flush(),
    );
    encoder.erc20Skim(marketParams.loanToken, this.treasuryAddress);

    const calls = encoder.flush();

    try {
      const tSim = nowMs();
      const success = await simulateAndExec(
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
        `${this.logTag}[LiqTiming] direct user=${position.user.slice(0, 10)}… simExecMs=${elapsedMs(tSim)} ok=${success}`,
      );

      if (success) {
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
        console.log(`${this.logTag}Liquidated ${position.user} on ${marketId}`);
      } else {
        this._liquidationsFailed++;
        this.armCooldown(marketId, position.user, "soft", "not profitable");
        console.log(`${this.logTag}ℹ️ Skipped ${position.user} on ${marketId} (not profitable)`);
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
   *   5. Skim remaining profit to treasury
   */
  private async liquidateWithFlashLoan(position: AccrualPosition, badDebtPosition: boolean) {
    const marketParams = position.market.params;
    const marketId = MarketUtils.getMarketId(marketParams);
    const seizableCollateral = position.seizableCollateral ?? 0n;
    const { client, executorAddress } = this;

    // Flash loan amount = the debt to repay
    const flashLoanAmount = position.borrowAssets ?? 0n;
    if (flashLoanAmount === 0n) return;

    console.log(
      `${this.logTag}[FlashLoan Debug] ${position.user}: flashLoanAmount=${flashLoanAmount}, seizableCollateral=${seizableCollateral}, collateral=${position.collateral}, collateralValue=${position.collateralValue ?? "undefined"}, badDebt=${badDebtPosition}`,
    );

    // ── Profitability pre-filter (collateral value vs debt) ──
    const collateralValue = position.collateralValue;
    if (collateralValue !== undefined) {
      if (collateralValue < flashLoanAmount) {
        this.raceMetrics.recordOutcome("skip_bad_debt");
        console.log(
          `${this.logTag}[FlashLoan] Skip ${position.user}: bad debt — collateral value (${collateralValue}) < debt (${flashLoanAmount})`,
        );
        return;
      }

      const totalCollateral = position.collateral;
      const seizableValue =
        totalCollateral > 0n ? (collateralValue * seizableCollateral) / totalCollateral : 0n;

      if (seizableValue < flashLoanAmount) {
        this.raceMetrics.recordOutcome("fail_soft_profit");
        console.log(
          `${this.logTag}[FlashLoan] Skip ${position.user}: seizable value (${seizableValue}) < debt (${flashLoanAmount}) — not enough collateral to seize for profit`,
        );
        return;
      }
    }

    // Step 1: Build DEX swap (local AMM first)
    const tempEncoder = new LiquidationEncoder(executorAddress, client);
    const swap = await sharedConvertCollateralToLoan(
      this.sharedDeps,
      getAddress(marketParams.collateralToken),
      getAddress(marketParams.loanToken),
      this.decreaseSeizableCollateral(seizableCollateral, badDebtPosition),
      tempEncoder,
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
    const dexSwapCalls = tempEncoder.flush();
    console.log(
      `${this.logTag}[FlashLoan Debug] DEX route via=${swap.via} ${swap.elapsedMs ?? "?"}ms: ${dexSwapCalls.length} swap call(s)`,
    );

    // Step 2: Build flash loan callback
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
      seizableCollateral,
      0n,
      callbackEncoder.flush(),
    );

    for (const call of dexSwapCalls) {
      callbackEncoder.pushCall(executorAddress, 0n, call);
    }

    callbackEncoder.erc20Skim(marketParams.loanToken, this.treasuryAddress);

    const callbackCalls = callbackEncoder.flush();

    // Step 3: simulate + execute
    try {
      const tSim = nowMs();
      const success = await simulateAndExecFlashLoanWithFallback(
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
        `${this.logTag}[LiqTiming] flash user=${position.user.slice(0, 10)}… simExecMs=${simMs} ok=${success}`,
      );

      if (success) {
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
        console.log(`${this.logTag}[FlashLoan] Liquidated ${position.user} on ${marketId}`);
      } else {
        this._liquidationsFailed++;
        this.armCooldown(marketId, position.user, "soft", "not profitable");
        console.log(
          `${this.logTag}[FlashLoan] Skipped ${position.user} on ${marketId} (not profitable)`,
        );
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

    // SECURITY: Skip markets involving blacklisted tokens
    if (
      TOKEN_BLACKLIST.has(marketParams.loanToken.toLowerCase()) ||
      TOKEN_BLACKLIST.has(marketParams.collateralToken.toLowerCase())
    ) {
      console.log(
        `${this.logTag}⛔ Skip pre-liquidate ${position.user}: blacklisted token in market ${MarketUtils.getMarketId(marketParams).slice(0, 10)}...`,
      );
      return;
    }

    const marketId = MarketUtils.getMarketId(marketParams);
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

    // Only approve if allowance is insufficient (saves ~5k-21k gas per tx)
    const currentAllowance = await readContract(this.client, {
      address: marketParams.loanToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [executorAddress, position.preLiquidation],
    });
    if (currentAllowance < seizableCollateral) {
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
      const success = await simulateAndExec(
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

      if (success) {
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
        this.armCooldown(marketId, position.user, "soft", "not profitable");
        console.log(`${this.logTag}ℹ️ Skipped ${position.user} on ${marketId} (not profitable)`);
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
      isHealthy: rpcErrorRate < 0.3,
      raceMetrics: this.raceMetrics.snapshot(),
    };
  }
}
