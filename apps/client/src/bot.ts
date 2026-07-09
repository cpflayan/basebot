import { chainConfigs, loadApprovedMarketIds } from "@morpho-blue-liquidation-bot/config";
import type { DataProvider } from "@morpho-blue-liquidation-bot/data-providers";
import type { LiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import type { Pricer } from "@morpho-blue-liquidation-bot/pricers";
import {
  AccrualPosition,
  ChainAddresses,
  getChainAddresses,
  type IMarketParams,
  MarketUtils,
  PreLiquidationPosition,
  MarketId,
} from "@morpho-org/blue-sdk";
import { fetchMarket } from "@morpho-org/blue-sdk-viem";
import { executorAbi } from "executooor-viem";
import {
  erc20Abi,
  formatUnits,
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
import {
  getBlockNumber,
  getGasPrice,
  readContract,
  simulateCalls,
  writeContract,
} from "viem/actions";

import { BALANCER_FLASH_LOAN_FEE_BPS, BALANCER_VAULT_ADDRESS } from "./abis/BalancerVault.js";
import { oracleAbi } from "./abis/morpho/oracle.js";
import { PositionCache, type CachedMarketState, type CachedPosition } from "./positionCache.js";
import {
  MarketsFetchingCooldownMechanism,
  PositionLiquidationCooldownMechanism,
} from "./utils/cooldownMechanisms.js";
import { fetchWhitelistedVaults } from "./utils/fetch-whitelisted-vaults.js";
import { Flashbots } from "./utils/flashbots.js";
import { LiquidationEncoder } from "./utils/LiquidationEncoder.js";
import { DEFAULT_LIQUIDATION_BUFFER_BPS, WAD, wMulDown } from "./utils/maths.js";
import type { DecodedMorphoEvent } from "./webhook.js";
import "@morpho-org/blue-sdk-viem/lib/augment";

/**
 * Slippage tolerance for DEX swaps within flash loan path.
 * 1% = 100 bps. Protects against sandwich attacks in public mempool.
 */
const FLASH_LOAN_SLIPPAGE_BPS = 100n; // 1%
const BPS_DENOMINATOR = 10_000n;

/**
 * SECURITY: Token blacklist — markets involving these tokens are skipped entirely.
 * Prevents liquidation of positions with depegged/risky tokens (e.g. USR).
 */
const TOKEN_BLACKLIST = new Set<string>([
  "0x35e5db674d8e93a03d814fa0ada70731efe8a4b9", // USR (Resolv USD) on Base — depegged
]);

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
  flashLoanProvider?: "balancer" | "aave";
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
  private flashLoanProvider: "balancer" | "aave";
  private positionCache: PositionCache;
  /** Interval for slow-path full refresh (ms). Default: 5 minutes */
  private cacheRefreshInterval: number;
  private cacheRefreshTimer?: ReturnType<typeof setInterval>;

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
    this.positionCache = new PositionCache();
    this.cacheRefreshInterval = Number(process.env.CACHE_REFRESH_INTERVAL_MS ?? "300000"); // 5 min
  }

  // ─── Cache lifecycle ───

  /**
   * Initialize cache: fetch all liquidatable positions + market data from API.
   * Called once at startup, then periodically via slow-path refresh.
   */
  async initializeCache(): Promise<void> {
    await this.fetchMarkets();

    const { liquidatablePositions } = await this.dataProvider.fetchLiquidatablePositions(
      this.client,
      this.coveredMarkets,
    );

    // Cache market state for each covered market
    const marketResults = await Promise.allSettled(
      this.coveredMarkets.map(async (marketId) => {
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
          console.error(`${this.logTag}Cache refresh failed:`, e);
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

    // For each affected market, fetch fresh oracle price and check HF
    for (const marketId of affectedMarkets) {
      try {
        const cachedMarket = this.positionCache.getMarket(marketId);
        if (!cachedMarket) {
          // Market not in cache — might be new. Do a full fetch.
          await this.refreshMarketInCache(marketId);
          continue;
        }

        // Fetch fresh oracle price (single on-chain read)
        const freshPrice = await readContract(this.client, {
          address: cachedMarket.params.oracle,
          abi: oracleAbi,
          functionName: "price",
        });
        this.positionCache.updateOraclePrice(marketId, freshPrice);

        // Sync any unknown positions from chain before checking HF
        const eventsForMarket = events.filter((e) => e.marketId === marketId);
        for (const event of eventsForMarket) {
          const cached = this.positionCache.get(marketId, event.user);
          if (!cached || cached.collateral === 0n) {
            // Position not in cache — read from chain
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

        // Check all positions in this market for HF < 1
        const atRisk = this.positionCache.findAtRiskPositions(marketId, 1, freshPrice);

        if (atRisk.length === 0) {
          console.log(`${this.logTag}  Market ${marketId.slice(0, 10)}... — no at-risk positions`);
          continue;
        }

        console.log(
          `${this.logTag}  Market ${marketId.slice(0, 10)}... — ${atRisk.length} at-risk position(s)!`,
        );

        // For each at-risk position, build a full AccrualPosition and attempt liquidation
        for (const { position: cachedPos, hf } of atRisk) {
          const accrualPos = this.positionCache.buildAccrualPosition(
            marketId,
            cachedPos.user,
            freshPrice,
          );
          if (!accrualPos) continue;

          console.log(
            `${this.logTag}  🎯 ${cachedPos.user} HF=${hf.toFixed(4)} — attempting liquidation`,
          );

          // Use existing liquidation path (with full profit checks)
          await this.liquidate(accrualPos);
        }
      } catch (e) {
        console.error(`${this.logTag}Error processing market ${marketId.slice(0, 10)}...:`, e);
      }
    }
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
      console.error(`${this.logTag}Failed to refresh market ${marketId.slice(0, 10)}...:`, e);
    }
  }

  // ─── Slow path: full API refresh (original behavior) ───

  async run() {
    await this.fetchMarkets();

    const { liquidatablePositions, preLiquidatablePositions } =
      await this.dataProvider.fetchLiquidatablePositions(this.client, this.coveredMarkets);

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

    await Promise.all([
      ...liquidatablePositions.map((position) => this.liquidate(position)),
      ...preLiquidatablePositions.map((position) => this.preLiquidate(position)),
    ]);
  }

  private async liquidate(position: AccrualPosition) {
    const marketParams = position.market.params;

    // SECURITY: Skip markets involving blacklisted tokens
    if (
      TOKEN_BLACKLIST.has(marketParams.loanToken.toLowerCase()) ||
      TOKEN_BLACKLIST.has(marketParams.collateralToken.toLowerCase())
    ) {
      console.log(
        `${this.logTag}⛔ Skip ${position.user}: blacklisted token in market ${MarketUtils.getMarketId(marketParams).slice(0, 10)}...`,
      );
      return;
    }

    const seizableCollateral = position.seizableCollateral ?? 0n;
    const badDebtPosition = seizableCollateral === position.collateral;

    if (!this.checkCooldown(MarketUtils.getMarketId(marketParams), position.user)) return;

    if (this.useFlashLoan) {
      await this.liquidateWithFlashLoan(position, badDebtPosition);
      return;
    }

    const { client, executorAddress } = this;

    const encoder = new LiquidationEncoder(executorAddress, client);

    if (
      !(await this.convertCollateralToLoan(
        marketParams,
        this.decreaseSeizableCollateral(seizableCollateral, badDebtPosition),
        encoder,
      ))
    )
      return;

    encoder.erc20Approve(marketParams.loanToken, this.chainAddresses.morpho, maxUint256);

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
      const success = await this.handleTx(encoder, calls, marketParams, badDebtPosition);

      if (success)
        console.log(
          `${this.logTag}Liquidated ${position.user} on ${MarketUtils.getMarketId(marketParams)}`,
        );
      else
        console.log(
          `${this.logTag}ℹ️ Skipped ${position.user} on ${MarketUtils.getMarketId(marketParams)} (not profitable)`,
        );
    } catch (error) {
      console.error(
        `${this.logTag}Failed to liquidate ${position.user} on ${MarketUtils.getMarketId(marketParams)}`,
        error,
      );
    }
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
    const seizableCollateral = position.seizableCollateral ?? 0n;
    const { client, executorAddress } = this;

    const encoder = new LiquidationEncoder(executorAddress, client);

    // Flash loan amount = the debt to repay
    const flashLoanAmount = position.borrowAssets ?? 0n;
    if (flashLoanAmount === 0n) return;

    // ── Profitability pre-filter ──
    // Position is already confirmed liquidatable (HF < 1) by the data provider.
    // HF = (collateralValue × LLTV) / borrowAssets, so HF < 1 means:
    //   collateralValue < borrowAssets / LLTV
    // But collateralValue can still EXCEED borrowAssets (since LLTV < 1).
    //
    // Truly profitable: HF < 1 (liquidatable) AND collateralValue > debt.
    //   → You borrow `debt` via flash loan, seize collateral worth MORE than debt,
    //     swap it, repay flash loan, keep the difference.
    //
    // Bad debt (unprofitable): collateralValue < debt.
    //   → Seized collateral won't cover the flash loan, skip.
    const collateralValue = position.collateralValue;
    if (collateralValue !== undefined) {
      if (collateralValue < flashLoanAmount) {
        console.log(
          `${this.logTag}[FlashLoan] Skip ${position.user}: bad debt — collateral value (${collateralValue}) < debt (${flashLoanAmount})`,
        );
        return;
      }

      // Proportional seizable value: the loan-token value of collateral we can
      // actually seize. Must exceed the flash loan amount (debt) to be profitable.
      // seizableValue = collateralValue × (seizableCollateral / totalCollateral)
      const totalCollateral = position.collateral;
      const seizableValue =
        totalCollateral > 0n ? (collateralValue * seizableCollateral) / totalCollateral : 0n;

      if (seizableValue < flashLoanAmount) {
        console.log(
          `${this.logTag}[FlashLoan] Skip ${position.user}: seizable value (${seizableValue}) < debt (${flashLoanAmount}) — not enough collateral to seize for profit`,
        );
        return;
      }
    }

    // Step 1: Build DEX swap calls (collateral → loan token)
    // These are built on a temporary encoder to capture the raw calls
    const tempEncoder = new LiquidationEncoder(executorAddress, client);
    const swapSuccess = await this.convertCollateralToLoan(
      marketParams,
      this.decreaseSeizableCollateral(seizableCollateral, badDebtPosition),
      tempEncoder,
    );

    if (!swapSuccess) {
      console.log(
        `${this.logTag}No DEX route for ${marketParams.collateralToken} -> ${marketParams.loanToken}, skipping flash loan liquidation`,
      );
      return;
    }

    const dexSwapCalls = tempEncoder.flush();

    // Step 2: Build flash loan callback calls on a temp encoder.
    // These execute INSIDE the Balancer callback, BEFORE the auto-appended repayment transfers.
    // Order: approve → liquidate → DEX swap → skim profit to treasury
    const callbackEncoder = new LiquidationEncoder(executorAddress, client);

    callbackEncoder.erc20Approve(marketParams.loanToken, this.chainAddresses.morpho, maxUint256);
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

    // Add DEX swap calls after liquidation
    // SECURITY (C2): DEX swap currently has no explicit minAmountOut at the venue level.
    // The erc20Skim to treasury captures whatever remains, acting as an implicit floor.
    // For full sandwich-attack protection, the executor contract should enforce minAmountOut
    // on the swap. Until then, the simulation-based profit check in handleFlashLoanSimulationAndExec
    // provides a pre-execution safety net.
    for (const call of dexSwapCalls) {
      callbackEncoder.pushCall(executorAddress, 0n, call);
    }

    // Skim profit to treasury — MUST be inside callback, before Vault repayment
    // (erc20Skim uses a dynamic balance placeholder, so it transfers whatever the
    //  executor holds AFTER swap but BEFORE the auto-appended repayment transfers)
    callbackEncoder.erc20Skim(marketParams.loanToken, this.treasuryAddress);

    const callbackCalls = callbackEncoder.flush();

    // Step 3: Wrap everything in a single Balancer flash loan call.
    // The executor auto-appends ERC20 transfers back to the Vault after callbackCalls.
    encoder.balancerFlashLoan(
      BALANCER_VAULT_ADDRESS,
      [{ asset: marketParams.loanToken, amount: flashLoanAmount }],
      callbackCalls,
    );

    const calls = encoder.flush();

    try {
      const success = await this.handleFlashLoanSimulationAndExec(
        encoder,
        calls,
        marketParams,
        badDebtPosition,
        flashLoanAmount,
      );

      if (success)
        console.log(
          `${this.logTag}[FlashLoan] Liquidated ${position.user} on ${MarketUtils.getMarketId(marketParams)}`,
        );
      else
        console.log(
          `${this.logTag}[FlashLoan] Skipped ${position.user} on ${MarketUtils.getMarketId(marketParams)} (not profitable)`,
        );
    } catch (error) {
      console.error(
        `${this.logTag}[FlashLoan] Failed to liquidate ${position.user} on ${MarketUtils.getMarketId(marketParams)}`,
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

    const seizableCollateral = this.decreaseSeizableCollateral(
      position.seizableCollateral ?? 0n,
      false,
    );

    if (!this.checkCooldown(MarketUtils.getMarketId(marketParams), position.user)) return;

    const { client, executorAddress } = this;

    const encoder = new LiquidationEncoder(executorAddress, client);

    if (!(await this.convertCollateralToLoan(marketParams, seizableCollateral, encoder))) return;

    encoder.erc20Approve(marketParams.loanToken, position.preLiquidation, maxUint256);

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
      const success = await this.handleTx(encoder, calls, marketParams, false);

      if (success)
        console.log(
          `${this.logTag}Pre-liquidated ${position.user} on ${MarketUtils.getMarketId(marketParams)}`,
        );
      else
        console.log(
          `${this.logTag}ℹ️ Skipped ${position.user} on ${MarketUtils.getMarketId(marketParams)} (not profitable)`,
        );
    } catch (error) {
      console.error(
        `${this.logTag}Failed to pre-liquidate ${position.user} on ${MarketUtils.getMarketId(marketParams)}`,
        error,
      );
    }
  }

  private async handleTx(
    encoder: LiquidationEncoder,
    calls: Hex[],
    marketParams: IMarketParams,
    badDebtPosition: boolean,
    flashLoanAmount?: bigint,
  ) {
    const functionData = {
      abi: executorAbi,
      functionName: "exec_606BaXt",
      args: [calls],
    } as const;

    const [{ results }, gasPrice] = await Promise.all([
      simulateCalls(this.client, {
        account: this.client.account.address,
        calls: [
          {
            to: marketParams.loanToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [this.client.account.address],
          },
          { to: encoder.address, ...functionData },
          {
            to: marketParams.loanToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [this.client.account.address],
          },
        ],
      }),
      getGasPrice(this.client),
    ]);

    if (results[1].status !== "success") {
      console.warn(`${this.logTag}Transaction failed in simulation: ${results[1].error}`);
      return;
    }

    if (
      !(await this.checkProfit(
        marketParams.loanToken,
        {
          beforeTx: results[0].result,
          afterTx: results[2].result,
        },
        {
          used: results[1].gasUsed,
          price: gasPrice,
        },
        badDebtPosition,
        flashLoanAmount,
      ))
    )
      return false;

    // TX EXECUTION

    if (this.flashbotAccount) {
      const signedBundle = await Flashbots.signBundle([
        {
          transaction: { to: encoder.address, ...functionData },
          client: this.client,
        },
      ]);

      await Flashbots.sendRawBundle(
        signedBundle,
        (await getBlockNumber(this.client)) + 1n,
        this.flashbotAccount,
      );
      return true;
    } else {
      await writeContract(this.client, { address: encoder.address, ...functionData });
    }

    return true;
  }

  /**
   * Simulate flash loan tx, check profit (treasury balance change), then execute.
   * Unlike handleTx, this checks the TREASURY balance (not EOA) because erc20Skim
   * sends profit to treasury.
   */
  private async handleFlashLoanSimulationAndExec(
    encoder: LiquidationEncoder,
    calls: Hex[],
    marketParams: IMarketParams,
    badDebtPosition: boolean,
    flashLoanAmount: bigint,
  ) {
    const functionData = {
      abi: executorAbi,
      functionName: "exec_606BaXt",
      args: [calls],
    } as const;

    // Simulate: check treasury balance before/after (profit lands at treasury via erc20Skim)
    const [{ results }, gasPrice] = await Promise.all([
      simulateCalls(this.client, {
        account: this.client.account.address,
        calls: [
          {
            to: marketParams.loanToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [this.treasuryAddress],
          },
          { to: encoder.address, ...functionData },
          {
            to: marketParams.loanToken,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [this.treasuryAddress],
          },
        ],
      }),
      getGasPrice(this.client),
    ]);

    if (results[1].status !== "success") {
      console.warn(`${this.logTag}[FlashLoan] Simulation failed: ${results[1].error}`);
      return false;
    }

    if (
      !(await this.checkProfit(
        marketParams.loanToken,
        {
          beforeTx: results[0].result,
          afterTx: results[2].result,
        },
        {
          used: results[1].gasUsed,
          price: gasPrice,
        },
        badDebtPosition,
        flashLoanAmount,
      ))
    )
      return false;

    // SECURITY (C3/NC2): Apply slippage safety margin to simulated profit.
    // Between simulation and execution, on-chain state may change (price moves, competing liquidations).
    // Require that simulated profit exceeds BOTH slippage margin AND estimated gas cost.
    const simulatedProfit = (results[2].result ?? 0n) - (results[0].result ?? 0n);
    const slippageMargin = (flashLoanAmount * FLASH_LOAN_SLIPPAGE_BPS) / BPS_DENOMINATOR;
    // SECURITY (NC2): Include gas cost in threshold to prevent loss in high-gas environments
    const estimatedGasCost = results[1].gasUsed * gasPrice;
    const minProfitThreshold =
      slippageMargin > estimatedGasCost ? slippageMargin : estimatedGasCost;
    if (simulatedProfit < minProfitThreshold) {
      console.warn(
        `${this.logTag}[FlashLoan] Simulated profit (${simulatedProfit}) below threshold (${minProfitThreshold}), ` +
          `slippageMargin=${slippageMargin}, gasCost=${estimatedGasCost}, skipping`,
      );
      return false;
    }

    // Execute via executor
    if (this.flashbotAccount) {
      const signedBundle = await Flashbots.signBundle([
        {
          transaction: { to: encoder.address, ...functionData },
          client: this.client,
        },
      ]);
      await Flashbots.sendRawBundle(
        signedBundle,
        (await getBlockNumber(this.client)) + 1n,
        this.flashbotAccount,
      );
    } else {
      await writeContract(this.client, { address: encoder.address, ...functionData });
    }

    return true;
  }

  private async convertCollateralToLoan(
    marketParams: IMarketParams,
    seizableCollateral: bigint,
    encoder: LiquidationEncoder,
  ) {
    let toConvert = {
      src: getAddress(marketParams.collateralToken),
      dst: getAddress(marketParams.loanToken),
      srcAmount: seizableCollateral,
    };

    for (const venue of this.liquidityVenues) {
      // SECURITY (NH1): Snapshot encoder state before each venue attempt.
      // flush() is destructive (returns calls + clears internal buffer).
      // We re-add savedCalls immediately, then try the venue.
      // If the venue throws, we flush (discard dirty state) and re-add savedCalls.
      const savedCalls = encoder.flush();
      // Re-add saved calls to encoder
      for (const call of savedCalls) {
        encoder.pushCall(encoder.address, 0n, call);
      }

      try {
        const routeSupported = await venue.supportsRoute(encoder, toConvert.src, toConvert.dst);
        if (routeSupported) {
          const snapshot = { ...toConvert };
          toConvert = await venue.convert(encoder, toConvert);
          // If convert was a no-op, the encoder state is unchanged — continue to next venue
          if (toConvert.src === snapshot.src && toConvert.dst === snapshot.dst) {
            continue;
          }
        } else {
          // SECURITY (NM7): supportsRoute may have pushed calls to encoder internally.
          // Flush to discard any residual calls, then restore clean state.
          encoder.flush();
          for (const call of savedCalls) {
            encoder.pushCall(encoder.address, 0n, call);
          }
        }
      } catch (error) {
        console.error(`${this.logTag}Error converting ${toConvert.src} to ${toConvert.dst}`, error);
        // SECURITY (NH1): Encoder may be dirty — flush to discard dirty state, then restore
        encoder.flush();
        for (const call of savedCalls) {
          encoder.pushCall(encoder.address, 0n, call);
        }
        continue;
      }

      if (toConvert.src === toConvert.dst) return true;
    }

    return false;
  }

  private async price(asset: Address, amount: bigint, pricers: Pricer[]) {
    let price: number | undefined = undefined;

    for (const pricer of pricers) {
      price = await pricer.price(this.client, asset);
      if (price !== undefined) break;
    }

    if (price === undefined) return undefined;

    const decimals =
      asset === this.wNative
        ? 18
        : await readContract(this.client, {
            address: asset,
            abi: erc20Abi,
            functionName: "decimals",
          });

    return parseFloat(formatUnits(amount, decimals)) * price;
  }

  private async checkProfit(
    loanAsset: Address,
    loanAssetBalance: {
      beforeTx: bigint | undefined;
      afterTx: bigint | undefined;
    },
    gas: {
      used: bigint;
      price: bigint;
    },
    badDebtPosition: boolean,
    flashLoanAmount?: bigint,
  ) {
    if (this.alwaysRealizeBadDebt && badDebtPosition) return true;
    // SECURITY (H3): If no pricers configured, REFUSE to execute — do not skip profit check.
    // Running without price feeds means we cannot verify profitability, so treat as unsafe.
    if (this.pricers === undefined || this.pricers.length === 0) {
      console.error(
        `${this.logTag}⛔ No pricers configured — refusing to execute trade (cannot verify profitability). ` +
          `Please configure pricers in chain config or set ALWAYS_REALIZE_BAD_DEBT=true to bypass.`,
      );
      return false;
    }

    if (loanAssetBalance.beforeTx === undefined || loanAssetBalance.afterTx === undefined)
      return false;

    let loanAssetProfit = loanAssetBalance.afterTx - loanAssetBalance.beforeTx;

    // Deduct flash loan fee from profit
    if (flashLoanAmount !== undefined && flashLoanAmount > 0n) {
      const flashLoanFee = this.calculateFlashLoanFee(flashLoanAmount);
      loanAssetProfit -= flashLoanFee;
    }

    if (loanAssetProfit <= 0n) return false;

    const [loanAssetProfitUsd, gasUsedUsd] = await Promise.all([
      this.price(loanAsset, loanAssetProfit, this.pricers),
      this.price(this.wNative, gas.used * gas.price, this.pricers),
    ]);

    if (loanAssetProfitUsd === undefined || gasUsedUsd === undefined) return false;

    const profitUsd = loanAssetProfitUsd - gasUsedUsd;

    return profitUsd > 0;
  }

  /**
   * Calculate flash loan fee based on provider.
   * Balancer V2: 0% fee (protocol currently charges nothing)
   * Aave V3: 0.05% (5 bps) fee
   */
  private calculateFlashLoanFee(amount: bigint): bigint {
    if (this.flashLoanProvider === "balancer") {
      // Balancer V2 flash loans have 0% fee — BALANCER_FLASH_LOAN_FEE_BPS is 0n
      return (amount * BALANCER_FLASH_LOAN_FEE_BPS) / BPS_DENOMINATOR;
    }
    // Aave V3: 0.05% = 5 / 10000
    return (amount * 5n) / 10000n;
  }

  private decreaseSeizableCollateral(seizableCollateral: bigint, badDebtPosition: boolean) {
    if (badDebtPosition) return seizableCollateral;

    const liquidationBufferBps =
      chainConfigs[this.chainId]?.options.liquidationBufferBps ?? DEFAULT_LIQUIDATION_BUFFER_BPS;

    return wMulDown(seizableCollateral, WAD - parseUnits(liquidationBufferBps.toString(), 14));
  }

  private checkCooldown(marketId: Hex, account: Address) {
    if (
      this.positionLiquidationCooldownMechanism !== undefined &&
      !this.positionLiquidationCooldownMechanism.isPositionReady(marketId, account)
    ) {
      return false;
    }
    return true;
  }

  private async fetchMarkets() {
    if (!this.marketsFetchingCooldownMechanism.isFetchingReady()) return;

    if (this.vaultWhitelist === "morpho-api")
      this.vaultWhitelist = await fetchWhitelistedVaults(this.chainId);

    const vaultWhitelist = this.vaultWhitelist;
    console.log(`${this.logTag}📝 Watching markets in the following vaults:`, vaultWhitelist);

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
  }
}
