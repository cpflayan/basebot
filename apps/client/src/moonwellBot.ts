/**
 * MoonwellLiquidationBot — monitors Moonwell (Compound V2) markets for liquidatable accounts
 * and executes liquidations via liquidateBorrow + redeemUnderlying with optional flash loan support.
 *
 * Architecture (mirrors CometLiquidationBot):
 *   - MoonwellAccountRegistry: discovers accounts via Borrow event scanning
 *   - getAccountLiquidity polling: checks each account on each block interval
 *   - Flash loan path: Balancer flash → liquidateBorrow → redeemUnderlying → DEX swap → repay
 *   - Reuses shared execution utilities (profit check, simulation, encoder)
 *
 * Key differences from Comet (V3):
 *   - No absorb() needed — liquidateBorrow directly seizes collateral
 *   - Seized collateral is mToken — must redeemUnderlying() to get underlying before swap
 *   - Liquidation check: getAccountLiquidity → shortfall > 0 (not isLiquidatable)
 *   - Repay amount: min(borrowBalance × closeFactor, availableBalance)
 */
import type {
  MoonwellWatchlistConfig,
  FlashLoanProvider,
} from "@morpho-blue-liquidation-bot/config";
import type { LiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import type { Pricer } from "@morpho-blue-liquidation-bot/pricers";
import { getChainAddresses } from "@morpho-org/blue-sdk";
import {
  type Address,
  type Transport,
  type Chain,
  type Account,
  type Client,
  type WalletClient,
  type LocalAccount,
  erc20Abi,
  maxUint256,
} from "viem";
import { readContract, multicall } from "viem/actions";
import { base } from "viem/chains";

import { comptrollerAbi, mTokenAbi, MOONWELL_UNDERLYING_MAP } from "./abis/Moonwell.js";
import { MoonwellAccountRegistry } from "./moonwellAccountRegistry.js";
import {
  classifyLiquidationFailure,
  type CooldownClass,
  PositionLiquidationCooldownMechanism,
} from "./utils/cooldownMechanisms.js";
import { logLiquidationDebug } from "./utils/liquidationDebug.js";
import { LiquidationEncoder } from "./utils/LiquidationEncoder.js";
import { liquidationTracker } from "./utils/liquidationState.js";
import { RaceMetrics, elapsedMs, nowMs } from "./utils/raceMetrics.js";
import { ensureRegistryDataDir, resolveAccountRegistryPath } from "./utils/registryPaths.js";
import {
  defaultHfBatchSize,
  defaultHfConcurrency,
  routeWarmMaxMajors,
  rpcWaveGapMs,
  shouldWarmRoutes,
  sleep,
} from "./utils/rpcBudget.js";
import { createScanClient, ReadClientPool } from "./utils/rpcFallback.js";
import {
  type SharedExecutionDeps,
  TOKEN_BLACKLIST,
  convertCollateralToLoan,
  SharedBlockBus,
  isLiquidationRaceLostError,
  priceAsset,
  simulateAndExecFlashLoanWithFallback,
  simulateAndExec,
  warmVenueRouteCache,
} from "./utils/sharedExecution.js";

/** mantissa 精度 (1e18) */
const MANTISSA = 10n ** 18n;

/** Simulation failure cooldown — skip accounts that repeatedly fail simulation */
const MAX_SIMULATION_FAILURES = 3;
const SIMULATION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/** True when accountError is a real sim/exec simulation failure (not soft exhaust). */
function isMoonwellSimFailureMessage(msg: string): boolean {
  return (
    /\bsim_fail\b/i.test(msg) ||
    /Simulation failed/i.test(msg) ||
    /returned no data/i.test(msg) ||
    /empty revert/i.test(msg) ||
    /Transaction failed in simulation/i.test(msg)
  );
}

/** Check if token is a 6-decimal stablecoin (USDC/USDbC/EURC). */
function isUsdcLikeToken(token: Address): boolean {
  const t = token.toLowerCase();
  return (
    t === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" || // Base USDC
    t === "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca" || // USDbC
    t === "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42" // EURC
  );
}

export interface MoonwellLiquidationBotInputs {
  logTag: string;
  client: WalletClient<Transport, Chain, Account>;
  paidReadPool: ReadClientPool;
  moonwellWatchlist: MoonwellWatchlistConfig;
  executorAddress: Address;
  treasuryAddress: Address;
  liquidityVenues: LiquidityVenue[];
  pricers?: Pricer[];
  wNative: Address;
  chainId: number;
  positionLiquidationCooldownMechanism?: PositionLiquidationCooldownMechanism;
  flashbotAccount?: LocalAccount;
  useFlashLoan?: boolean;
  flashLoanProvider?: FlashLoanProvider;
  flashLoanFallbackProviders?: FlashLoanProvider[];
  alwaysRealizeBadDebt?: boolean;
  registryFilePath?: string;
  scanRpcUrls?: string[];
}

interface MTokenInfo {
  address: Address;
  underlying: Address;
  deployBlock: number;
}

export class MoonwellLiquidationBot {
  private logTag: string;
  private client: WalletClient<Transport, Chain, Account>;
  private paidReadPool: ReadClientPool;
  private comptroller: Address;
  private mTokenList: MTokenInfo[];
  private executorAddress: Address;
  private treasuryAddress: Address;
  private liquidityVenues: LiquidityVenue[];
  private pricers?: Pricer[];
  private wNative: Address;
  private chainId: number;
  private cooldown?: PositionLiquidationCooldownMechanism;
  private flashbotAccount?: LocalAccount;
  private useFlashLoan: boolean;
  private flashLoanProvider: FlashLoanProvider;
  private flashLoanFallbackProviders: FlashLoanProvider[];
  private alwaysRealizeBadDebt: boolean;
  private registry: MoonwellAccountRegistry;
  private pollIntervalBlocks: number;
  private hfBatchSize: number;
  private hfConcurrency: number;
  private sharedDeps: SharedExecutionDeps;
  /** Read-only client using Base public RPC — for historical event scanning only */
  private scanClient: Client<Transport, Chain>;
  private raceMetrics = new RaceMetrics(20);

  /** Cached Comptroller params */
  private closeFactor = 0n;

  /** Cached mToken → reserveFactor (diagnostics / soft preference) */
  private reserveFactors = new Map<Address, bigint>();
  /** mTokens with RF >= 99% (still scanned; prefer non-high-RF collateral when both exist) */
  private highRfMarkets = new Set<Address>();
  /**
   * Full watchlist snapshot at init (same as mTokenList after P1 — RF no longer strips markets).
   * Kept for collateral discovery that previously scanned markets filtered out of mTokenList.
   */
  private allMTokenList: { address: Address; underlying: Address; deployBlock: number }[] = [];

  /** Oracle feed timestamps — tracked to detect recent price updates */
  private lastOracleUpdates = new Map<Address, bigint>();
  /** mTokens whose oracle just updated in the last check cycle */
  private hotMarkets = new Set<Address>();

  /** Simulation failure tracking — accounts that fail simulation repeatedly are cooled down */
  private simulationFailures = new Map<string, number>();
  /** Cooldown expiry timestamps — accounts are skipped until this time */
  private simulationCooldowns = new Map<string, number>();

  /** Cached mToken → underlying mapping (populated at init from config + on-chain) */
  private underlyingCache = new Map<Address, Address>();

  // ─── Health & monitoring stats ───
  private _liquidationsAttempted = 0;
  private _liquidationsSucceeded = 0;
  private _liquidationsFailed = 0;
  private _lastCheckTimestamp = 0;
  private _lastCheckBlock = 0;
  private _rpcErrors = 0;
  private _rpcTotal = 0;
  private _lastError?: string;

  constructor(inputs: MoonwellLiquidationBotInputs) {
    this.logTag = inputs.logTag;
    this.client = inputs.client;
    this.paidReadPool = inputs.paidReadPool;
    this.comptroller = inputs.moonwellWatchlist.comptroller;
    this.executorAddress = inputs.executorAddress;
    this.treasuryAddress = inputs.treasuryAddress;
    this.liquidityVenues = inputs.liquidityVenues;
    this.pricers = inputs.pricers;
    this.wNative = inputs.wNative;
    this.chainId = inputs.chainId;
    this.cooldown = inputs.positionLiquidationCooldownMechanism;
    this.flashbotAccount = inputs.flashbotAccount;
    this.useFlashLoan = inputs.useFlashLoan ?? false;
    this.flashLoanProvider = inputs.flashLoanProvider ?? "balancer";
    this.flashLoanFallbackProviders = inputs.flashLoanFallbackProviders ?? [];
    this.alwaysRealizeBadDebt = inputs.alwaysRealizeBadDebt ?? false;
    this.pollIntervalBlocks = inputs.moonwellWatchlist.pollIntervalBlocks ?? 5;
    this.hfBatchSize = defaultHfBatchSize(100);
    this.hfConcurrency = defaultHfConcurrency(inputs.paidReadPool.size);

    this.mTokenList = inputs.moonwellWatchlist.mTokens.map((m) => ({
      address: m.address,
      underlying: m.underlying,
      deployBlock: m.deployBlock,
    }));
    this.allMTokenList = [...this.mTokenList];

    ensureRegistryDataDir();
    const registryPath =
      inputs.registryFilePath ??
      resolveAccountRegistryPath(`moonwell-accounts.${inputs.chainId}.json`);
    this.registry = new MoonwellAccountRegistry(registryPath);

    this.sharedDeps = {
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
      morphoAddress: getChainAddresses(this.chainId).morpho,
    };

    // Read-only client on Base public RPC for historical scanning
    this.scanClient = createScanClient(base, inputs.scanRpcUrls ?? ["https://mainnet.base.org"]);
  }

  // ─── Initialization ───

  /**
   * Initialize: load registry, scan historical events, cache Comptroller params.
   */
  async initialize(): Promise<void> {
    // Load persisted account registry
    this.registry.loadFromFile();

    // Cache Comptroller global params
    await this.cacheComptrollerParams();

    // Cache reserve factors and filter out high-RF markets
    await this.cacheReserveFactors();

    // Initialize oracle timestamp tracking
    await this.initOracleTimestamps();

    // Discover underlying addresses on-chain for mTokens not in hardcoded map
    await this.discoverUnderlyings();

    // Scan each mToken for historical accounts
    for (const mToken of this.mTokenList) {
      await this.registry.initialScan(
        this.client,
        mToken.address,
        mToken.deployBlock,
        this.logTag,
        this.scanClient,
      );
    }

    await this.warmDexRoutes();

    console.log(
      `${this.logTag}🗄️ Moonwell registry initialized: ${this.registry.totalAccounts} total accounts across ${this.mTokenList.length} mTokens`,
    );
  }

  /** Prefill DEX routes among underlyings (local AMM first). */
  private async warmDexRoutes(): Promise<void> {
    if (!shouldWarmRoutes()) {
      console.log(`${this.logTag}🔥 DEX warm skipped (SKIP_ROUTE_WARM=1)`);
      return;
    }
    const maxMajors = routeWarmMaxMajors(6);
    const underlyings = [
      ...new Set(
        this.mTokenList
          .map((m) => this.getUnderlying(m.address).toLowerCase())
          .concat(this.wNative.toLowerCase()),
      ),
    ]
      .slice(0, maxMajors)
      .map((a) => a as Address);

    const pairs: { src: Address; dst: Address }[] = [];
    for (const src of underlyings) {
      for (const dst of underlyings) {
        if (src !== dst) pairs.push({ src, dst });
      }
    }
    if (pairs.length === 0) return;
    console.log(
      `${this.logTag}🔥 Warming ${pairs.length} Moonwell DEX routes (prefer local AMM, majors=${maxMajors})…`,
    );
    try {
      await warmVenueRouteCache(this.sharedDeps, pairs);
    } catch (e) {
      console.warn(
        `${this.logTag}⚠️ DEX warm failed (non-fatal): ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /**
   * Discover underlying addresses for all mTokens.
   * Uses hardcoded map first, falls back to on-chain underlying() call.
   * Caches results for later use in getUnderlying().
   */
  private async discoverUnderlyings(): Promise<void> {
    // Pre-populate cache from hardcoded map
    for (const [mToken, underlying] of Object.entries(MOONWELL_UNDERLYING_MAP)) {
      this.underlyingCache.set(mToken as Address, underlying);
    }

    // Discover missing underlyings on-chain
    const toDiscover = this.mTokenList.filter((m) => !this.underlyingCache.has(m.address));

    if (toDiscover.length === 0) {
      console.log(
        `${this.logTag}✅ All ${this.mTokenList.length} underlying addresses found in hardcoded map`,
      );
      return;
    }

    console.log(
      `${this.logTag}🔍 Discovering ${toDiscover.length} underlying address(es) on-chain...`,
    );

    const results = await Promise.allSettled(
      toDiscover.map(async (mToken) => {
        const underlying = await readContract(this.client, {
          address: mToken.address,
          abi: mTokenAbi,
          functionName: "underlying",
        });
        return { mToken: mToken.address, underlying };
      }),
    );

    let successCount = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        this.underlyingCache.set(result.value.mToken, result.value.underlying);
        successCount++;
      } else {
        console.warn(`${this.logTag}⚠️ Failed to discover underlying for mToken`);
      }
    }

    console.log(
      `${this.logTag}✅ Discovered ${successCount}/${toDiscover.length} underlying addresses on-chain`,
    );
  }

  /**
   * Cache closeFactor and liquidationIncentive from Comptroller.
   */
  private async cacheComptrollerParams(): Promise<void> {
    try {
      this._rpcTotal += 2;
      const [cf, li] = await Promise.all([
        readContract(this.client, {
          address: this.comptroller,
          abi: comptrollerAbi,
          functionName: "closeFactorMantissa",
        }),
        readContract(this.client, {
          address: this.comptroller,
          abi: comptrollerAbi,
          functionName: "liquidationIncentiveMantissa",
        }),
      ]);
      this.closeFactor = cf;
      console.log(
        `${this.logTag}📋 Comptroller params: closeFactor=${Number(cf) / 1e18}, liquidationIncentive=${Number(li) / 1e18}`,
      );
    } catch (e) {
      this._rpcErrors += 2;
      this._lastError = String(e);
      // Fallback to standard Compound V2 defaults
      this.closeFactor = 5n * 10n ** 17n; // 0.5e18 = 50%
      console.warn(
        `${this.logTag}⚠️ Failed to read Comptroller params, using defaults: closeFactor=50%, incentive=10%: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /**
   * Cache reserveFactorMantissa for each mToken (diagnostics / soft preference only).
   *
   * P1: do NOT drop high-RF markets from discovery or the watchlist — RF is not the
   * liquidation bonus. Profit gate at sim time decides whether a path is worth sending.
   * highRfMarkets still marks markets for logging / collateral preference.
   */
  private async cacheReserveFactors(): Promise<void> {
    const RF_THRESHOLD = 99n * 10n ** 16n; // 0.99e18 = 99%

    const results = await Promise.allSettled(
      this.mTokenList.map(async (mToken) => {
        this._rpcTotal++;
        const rf = await readContract(this.client, {
          address: mToken.address,
          abi: mTokenAbi,
          functionName: "reserveFactorMantissa",
        });
        return { mToken: mToken.address, rf };
      }),
    );

    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { mToken, rf } = result.value;
      this.reserveFactors.set(mToken, rf);

      if (rf >= RF_THRESHOLD) {
        this.highRfMarkets.add(mToken);
        console.log(
          `${this.logTag}ℹ️ ${mToken.slice(0, 10)}... high RF=${Number(rf) / 1e16}% — kept in discovery (profit gate at attempt)`,
        );
      }
    }

    // Keep full mTokenList for event scan + shortfall watch (allMTokenList stays in sync)
    console.log(
      `${this.logTag}📊 Reserve factors: ${this.mTokenList.length} markets watched, ` +
        `${this.highRfMarkets.size} high-RF (not excluded from discovery)`,
    );
  }

  // ─── Polling loop ───

  /**
   * Start polling: check getAccountLiquidity on every N blocks.
   * Returns an unwatch function.
   */
  startPolling(bus: SharedBlockBus): void {
    // phase=2 → blocks 2,7,12… when interval=5 (stagger vs Comet phase=0)
    const phase = this.pollIntervalBlocks > 1 ? 2 % this.pollIntervalBlocks : 0;
    bus.register(this.pollIntervalBlocks, () => this.checkAllMarkets(), this.logTag, phase);
    console.log(
      `${this.logTag}⚡ Race mode: poll every ${this.pollIntervalBlocks} block(s) phase=${phase}, ` +
        `batch=${this.hfBatchSize} concurrency=${this.hfConcurrency} waveGap=${rpcWaveGapMs()}ms`,
    );
  }

  /**
   * Core check loop: for each mToken, scan new events, then check getAccountLiquidity for all known accounts.
   */
  async checkAllMarkets(): Promise<void> {
    this._lastCheckTimestamp = Math.floor(Date.now() / 1000);

    // Incremental scan for new accounts across all mTokens in parallel.
    // persist=false avoids concurrent JSON write races; one save covers all markets.
    await Promise.all(
      this.mTokenList.map(async (mToken) => {
        try {
          await this.registry.scanNewEvents(this.scanClient, mToken.address, this.logTag, false);
        } catch (e) {
          console.error(
            `${this.logTag}Error scanning mToken ${mToken.address.slice(0, 10)}...: ${e instanceof Error ? e.message : e}`,
          );
        }
      }),
    );
    this.registry.saveToFile();

    // Detect oracle price updates — mark affected markets as "hot"
    await this.detectOracleUpdates();

    // Collect all unique accounts across all mTokens
    const allAccounts = new Set<string>();
    for (const mToken of this.mTokenList) {
      for (const account of this.registry.getAccounts(mToken.address)) {
        allAccounts.add(account.toLowerCase());
      }
    }

    if (allAccounts.size === 0) {
      this.raceMetrics.onTick({
        logTag: this.logTag,
        mode: "full",
        accounts: 0,
        liquidatable: 0,
        hfScanMs: 0,
      });
      return;
    }

    const t0 = nowMs();
    const liquidatable = await this.batchCheckShortfall([...allAccounts] as Address[]);
    const scanMs = elapsedMs(t0);

    this.raceMetrics.onTick({
      logTag: this.logTag,
      mode: "full",
      accounts: allAccounts.size,
      liquidatable: liquidatable.length,
      hfScanMs: scanMs,
    });

    if (liquidatable.length === 0) return;

    // Build hot-account set once (O(hot markets × accounts)) instead of per-sort comparison
    const hotAccountSet = this.buildHotAccountSet();

    // Sort: (1) hot market accounts first, (2) by shortfall descending
    liquidatable.sort((a, b) => {
      const aHot = hotAccountSet.has(a.account.toLowerCase()) ? 0 : 1;
      const bHot = hotAccountSet.has(b.account.toLowerCase()) ? 0 : 1;
      if (aHot !== bHot) return aHot - bHot;
      return b.shortfall > a.shortfall ? 1 : b.shortfall < a.shortfall ? -1 : 0;
    });

    const hotCount = liquidatable.filter((l) => hotAccountSet.has(l.account.toLowerCase())).length;
    console.log(
      `${this.logTag}🎯 ${liquidatable.length} liquidatable account(s)! ` +
        `(${hotCount} hot markets, scan ${allAccounts.size} in ${scanMs}ms)`,
    );

    for (const { account } of liquidatable) {
      await this.liquidateAccount(account);
    }
  }

  /**
   * Parallel-sharded multicall of getAccountLiquidity across paidReadPool.
   */
  private async batchCheckShortfall(
    accounts: Address[],
  ): Promise<{ account: Address; shortfall: bigint }[]> {
    const batchSize = Math.max(10, this.hfBatchSize);
    const concurrency = Math.max(
      1,
      Math.min(this.hfConcurrency, Math.max(1, this.paidReadPool.size)),
    );
    const liquidatable: { account: Address; shortfall: bigint }[] = [];

    const batches: Address[][] = [];
    for (let i = 0; i < accounts.length; i += batchSize) {
      batches.push(accounts.slice(i, i + batchSize));
    }

    const waveGap = rpcWaveGapMs();
    for (let waveStart = 0; waveStart < batches.length; waveStart += concurrency) {
      if (waveStart > 0 && waveGap > 0) await sleep(waveGap);
      const wave = batches.slice(waveStart, waveStart + concurrency);
      const waveResults = await Promise.all(
        wave.map(async (batch) => {
          const { client, label } = this.paidReadPool.nextWithLabel();
          try {
            const results = await multicall(client, {
              contracts: batch.map((account) => ({
                address: this.comptroller,
                abi: comptrollerAbi,
                functionName: "getAccountLiquidity" as const,
                args: [account] as const,
              })),
              allowFailure: true,
            });
            this.paidReadPool.recordSuccess(label);
            this._rpcTotal += batch.length;
            return { batch, results, ok: true as const };
          } catch (e) {
            this.paidReadPool.recordFailure(label);
            this._rpcErrors += batch.length;
            this._lastError = String(e);
            console.warn(
              `${this.logTag}⚠️ shortfall multicall failed on ${label}: ${e instanceof Error ? e.message : e}`,
            );
            return { batch, results: null, ok: false as const };
          }
        }),
      );

      for (const { batch, results, ok } of waveResults) {
        if (!ok || !results) continue;
        for (let j = 0; j < results.length; j++) {
          const result = results[j]!;
          if (result.status !== "success") {
            this._rpcErrors++;
            continue;
          }
          const [error, , shortfall] = result.result;
          if (error === 0n && shortfall > 0n) {
            liquidatable.push({ account: batch[j]!, shortfall });
          }
        }
      }
    }

    return liquidatable;
  }

  // ─── Liquidation execution ───

  private async liquidateAccount(account: Address): Promise<void> {
    const tTotal = nowMs();
    // Per-account error state — never inherit the previous account's _lastError (P0 ops)
    let accountError: string | undefined;

    // Peek only — arm after real attempt (graded)
    if (this.cooldown?.isCoolingDown(this.comptroller, account)) {
      this.raceMetrics.recordOutcome("skip_cooldown");
      logLiquidationDebug({
        protocol: this.logTag,
        account,
        decision: "skip",
        reason: "Position is in cooldown period",
        details: {
          comptroller: this.comptroller,
          note: "Recently attempted liquidation, waiting before retry",
        },
      });
      return;
    }

    // Simulation failure cooldown — skip accounts that repeatedly fail simulation
    const accountKey = account.toLowerCase();
    const cooldownExpiry = this.simulationCooldowns.get(accountKey);
    if (cooldownExpiry && Date.now() < cooldownExpiry) {
      this.raceMetrics.recordOutcome("skip_cooldown");
      logLiquidationDebug({
        protocol: this.logTag,
        account,
        decision: "skip",
        reason: "Simulation failure cooldown",
        details: {
          comptroller: this.comptroller,
          note: "Previous simulation failed, waiting before retry",
        },
      });
      return;
    }
    if (cooldownExpiry) {
      this.simulationCooldowns.delete(accountKey);
      this.simulationFailures.delete(accountKey);
    }

    logLiquidationDebug({
      protocol: this.logTag,
      account,
      decision: "liquidate",
      reason: "Moonwell liquidation check passed, attempting liquidation",
      details: {
        comptroller: this.comptroller,
        useFlashLoan: this.useFlashLoan,
        note: "Proceeding to find borrow positions and collateral",
      },
    });

    console.log(`${this.logTag}  🎯 ${account} — attempting Moonwell liquidation`);

    this._liquidationsAttempted++;

    const { borrowPositions, collateralMToken, collateralBalance, collateralIsHighRf } =
      await this.findBorrowAndCollateral(account);

    if (borrowPositions.length === 0) {
      this.raceMetrics.recordOutcome("skip_no_pair");
      logLiquidationDebug({
        protocol: this.logTag,
        account,
        decision: "skip",
        reason: "No borrow positions found",
        details: {
          comptroller: this.comptroller,
          note: "Account has no active borrows",
        },
      });
      return;
    }

    if (!collateralMToken || collateralBalance === 0n) {
      this.raceMetrics.recordOutcome("skip_no_pair");
      logLiquidationDebug({
        protocol: this.logTag,
        account,
        decision: "skip",
        reason: "No collateral found",
        details: {
          comptroller: this.comptroller,
          borrowPositionsCount: borrowPositions.length,
          note: "Account has borrows but no mToken supply on any watchlist market",
        },
      });
      return;
    }

    // High RF is informational only — still attempt; simulateAndExec profit gate decides.
    if (collateralIsHighRf) {
      console.log(
        `${this.logTag}ℹ️ account=${account.slice(0, 10)}… only high-RF collateral ${collateralMToken.slice(0, 10)}… — attempting with profit gate`,
      );
    }

    const collateralUnderlying = this.getUnderlying(collateralMToken);

    if (TOKEN_BLACKLIST.has(collateralUnderlying.toLowerCase())) {
      this.raceMetrics.recordOutcome("skip_blacklist");
      logLiquidationDebug({
        protocol: this.logTag,
        account,
        decision: "skip",
        reason: "Blacklisted collateral",
        details: {
          comptroller: this.comptroller,
          collateralMToken,
          collateralUnderlying,
          note: "Collateral token is in TOKEN_BLACKLIST",
        },
      });
      return;
    }

    // Try each borrow position until one succeeds
    for (const { borrowMToken, borrowBalance } of borrowPositions) {
      const borrowUnderlying = this.getUnderlying(borrowMToken);

      if (TOKEN_BLACKLIST.has(borrowUnderlying.toLowerCase())) continue;
      // Same mToken is valid on Moonwell/Compound V2 (seize collateral of same market;
      // underlying identical → convert is same-token, no DEX hop).

      // closeFactor cap (e.g. 50% of one borrow)
      let repayAmount = (borrowBalance * this.closeFactor) / MANTISSA;
      if (repayAmount === 0n) continue;

      // Cap so seizeTokens <= borrower mToken collateral (avoids LIQUIDATE_SEIZE_TOO_MUCH)
      repayAmount = await this.capRepayToSeizableCollateral(
        borrowMToken,
        collateralMToken,
        repayAmount,
        collateralBalance,
      );
      if (repayAmount === 0n) {
        console.log(
          `${this.logTag}  ${account} repay capped to 0 vs collateral ${collateralMToken.slice(0, 10)}… — skip pair`,
        );
        continue;
      }

      // For flash loans, use a higher dust threshold: tiny amounts (<$1) lose precision
      // during liquidateBorrow + DEX swap, causing "transfer amount exceeds balance" on repay.
      const dustThreshold = this.useFlashLoan
        ? isUsdcLikeToken(borrowUnderlying)
          ? 100_000_000n
          : 10n ** 17n // $100 or 0.1 ETH
        : 10_000n; // $0.01 for direct liquidation
      if (repayAmount < dustThreshold) {
        console.log(
          `${this.logTag}  ${account} dust repay ${repayAmount} < ${dustThreshold} via ${borrowMToken.slice(0, 10)}… — skip`,
        );
        continue;
      }

      try {
        const ok = this.useFlashLoan
          ? await this.liquidateWithFlashLoan(
              account,
              borrowMToken,
              collateralMToken,
              borrowUnderlying,
              collateralUnderlying,
              repayAmount,
            )
          : await this.liquidateDirect(
              account,
              borrowMToken,
              collateralMToken,
              borrowUnderlying,
              collateralUnderlying,
              repayAmount,
            );

        if (ok) {
          this.simulationFailures.set(accountKey, 0);
          this._liquidationsSucceeded++;
          this.armCooldown(account, "success");
          this.raceMetrics.recordStage("totalLiq", elapsedMs(tTotal));
          return;
        }
        // soft fail (sim/profit/route) — try next borrow market; do not poison accountError
      } catch (error) {
        console.warn(
          `${this.logTag}  ⚠️ Liquidation via ${borrowMToken.slice(0, 10)}... failed, trying next borrow...: ${error instanceof Error ? error.message : error}`,
        );
        // Scoped to this account only
        accountError = error instanceof Error ? error.message : String(error);
        this._lastError = accountError; // health lastError = most recent attempt
      }
    }

    // All borrow positions exhausted — grade cooldown from THIS account's error only
    this._liquidationsFailed++;
    if (accountError) {
      this.armCooldownFromError(account, accountError);
    } else {
      this.armCooldown(account, "soft", "all borrow positions exhausted");
    }
    // Do not leave a sticky string that classify() would map to hard for the next account
    this._lastError = accountError;

    // N3: only count true simulation failures — not dust/soft exhaust without throw
    if (accountError && isMoonwellSimFailureMessage(accountError)) {
      const failures = (this.simulationFailures.get(accountKey) ?? 0) + 1;
      this.simulationFailures.set(accountKey, failures);

      if (failures >= MAX_SIMULATION_FAILURES) {
        const cooldownUntil = Date.now() + SIMULATION_COOLDOWN_MS;
        this.simulationCooldowns.set(accountKey, cooldownUntil);
        console.warn(
          `${this.logTag}  ⏸️ ${account} — ${failures} consecutive simulation failures, cooling down for ${SIMULATION_COOLDOWN_MS / 1000}s`,
        );
      }
    }

    console.log(`${this.logTag}  ${account} — all borrow positions exhausted, skipping`);
    this.raceMetrics.recordStage("totalLiq", elapsedMs(tTotal));
  }

  /**
   * Comptroller seize math: mToken amount seized for a given repay.
   * Returns 0n on error.
   */
  private async estimateSeizeMTokens(
    borrowMToken: Address,
    collateralMToken: Address,
    repayAmount: bigint,
  ): Promise<bigint> {
    try {
      this._rpcTotal++;
      const [error, seizeTokens] = await readContract(this.client, {
        address: this.comptroller,
        abi: comptrollerAbi,
        functionName: "liquidateCalculateSeizeTokens",
        args: [borrowMToken, collateralMToken, repayAmount],
      });
      if (error !== 0n) return 0n;
      return seizeTokens;
    } catch (error) {
      this._rpcErrors++;
      console.warn(
        `${this.logTag}⚠️ liquidateCalculateSeizeTokens failed: ${error instanceof Error ? error.message : error}`,
      );
      return 0n;
    }
  }

  /**
   * Estimate the underlying collateral amount that `liquidateBorrow` + `redeem(seizeTokens)`
   * will produce, so the DEX swap can use a real amount.
   *
   * Do NOT redeem(maxUint256): on Compound V2 forks, amount * exchangeRate can overflow
   * and the call fails (or redeems nothing useful).
   */
  private async estimateSeizedUnderlying(
    borrowMToken: Address,
    collateralMToken: Address,
    repayAmount: bigint,
  ): Promise<{ seizeMTokens: bigint; underlying: bigint }> {
    try {
      const seizeMTokens = await this.estimateSeizeMTokens(
        borrowMToken,
        collateralMToken,
        repayAmount,
      );
      if (seizeMTokens === 0n) return { seizeMTokens: 0n, underlying: 0n };

      this._rpcTotal++;
      const exchangeRate = await readContract(this.client, {
        address: collateralMToken,
        abi: mTokenAbi,
        functionName: "exchangeRateStored",
      });

      // underlying = seizeTokens * exchangeRate / 1e18 (Compound V2 exchange rate scaling)
      const underlying = (seizeMTokens * exchangeRate) / 10n ** 18n;
      return { seizeMTokens, underlying };
    } catch (error) {
      console.warn(
        `${this.logTag}⚠️ Failed to estimate seized collateral for ${collateralMToken.slice(0, 10)}...: ${error instanceof Error ? error.message : error}`,
      );
      return { seizeMTokens: 0n, underlying: 0n };
    }
  }

  /**
   * Scale repay down so seizeTokens <= borrower collateral mToken balance.
   * Prevents Comptroller LIQUIDATE_SEIZE_TOO_MUCH (closeFactor on a large borrow
   * can demand more collateral mTokens than the borrower still holds).
   * Uses a 1% safety buffer for oracle / accrual drift before execution.
   */
  private async capRepayToSeizableCollateral(
    borrowMToken: Address,
    collateralMToken: Address,
    repayAmount: bigint,
    collateralBalance: bigint,
  ): Promise<bigint> {
    if (repayAmount === 0n || collateralBalance === 0n) return 0n;

    const seizeTokens = await this.estimateSeizeMTokens(
      borrowMToken,
      collateralMToken,
      repayAmount,
    );
    if (seizeTokens === 0n) return 0n;

    if (seizeTokens <= collateralBalance) {
      return repayAmount;
    }

    // seize ∝ repay → repay' = repay * collateralBalance / seizeTokens
    // 99/100 buffer so slight price move doesn't re-hit SEIZE_TOO_MUCH
    const capped = (repayAmount * collateralBalance * 99n) / (seizeTokens * 100n);
    console.log(
      `${this.logTag}  📉 Cap repay ${repayAmount} → ${capped} ` +
        `(seize ${seizeTokens} > collatBal ${collateralBalance})`,
    );
    return capped;
  }

  /**
   * Flash loan path:
   *   1. Borrow underlying from Balancer
   *   2. Approve borrow mToken + liquidateBorrow → seize collateral mToken
   *   3. redeemUnderlying on collateral mToken → get collateral underlying
   *   4. DEX swap collateral underlying → borrow underlying
   *   5. Skim profit to treasury
   *   6. Auto-repay Balancer flash loan
   */
  /** @returns true if liquidation executed successfully */
  private async liquidateWithFlashLoan(
    account: Address,
    borrowMToken: Address,
    collateralMToken: Address,
    borrowUnderlying: Address,
    collateralUnderlying: Address,
    repayAmount: bigint,
  ): Promise<boolean> {
    const callbackEncoder = new LiquidationEncoder(this.executorAddress, this.client);

    const currentAllowance = await readContract(this.client, {
      address: borrowUnderlying,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.executorAddress, borrowMToken],
    });
    if (currentAllowance < repayAmount) {
      callbackEncoder.erc20Approve(borrowUnderlying, borrowMToken, maxUint256);
    }

    const { seizeMTokens, underlying: expectedCollateral } = await this.estimateSeizedUnderlying(
      borrowMToken,
      collateralMToken,
      repayAmount,
    );
    if (seizeMTokens === 0n || expectedCollateral === 0n) {
      console.log(`${this.logTag}  ${account} could not estimate seized collateral, skipping`);
      return false;
    }

    // Conservative haircut so redeem/swap never try to move more tokens than we get
    // (oracle drift / rounding). Keep enough headroom that swap output can cover flash repay.
    const SEIZE_BPS = 97n; // 97% of estimated seize
    const seizeForRedeem = (seizeMTokens * SEIZE_BPS) / 100n;
    const swapSrcAmount = (expectedCollateral * SEIZE_BPS) / 100n;
    if (seizeForRedeem === 0n || swapSrcAmount === 0n) {
      console.log(`${this.logTag}  ${account} seize too small after haircut, skipping`);
      return false;
    }

    callbackEncoder.moonwellLiquidateBorrow(borrowMToken, collateralMToken, account, repayAmount);
    // Redeem haircut seize (not maxUint256 — overflow; not 100% — leave dust mToken ok)
    callbackEncoder.moonwellRedeem(collateralMToken, seizeForRedeem);

    let venueImpactBps: bigint | undefined;
    if (collateralUnderlying.toLowerCase() !== borrowUnderlying.toLowerCase()) {
      const swap = await convertCollateralToLoan(
        this.sharedDeps,
        collateralUnderlying,
        borrowUnderlying,
        swapSrcAmount,
        callbackEncoder,
        { preferLocalDex: true },
      );
      this.recordConvertMetrics(swap);
      if (!swap.success) {
        // Do not arm cooldown here — parent may try another borrow market
        this.raceMetrics.recordOutcome("skip_no_route");
        console.log(
          `${this.logTag}No DEX route for ${collateralUnderlying.slice(0, 10)}…→${borrowUnderlying.slice(0, 10)}…, try next borrow`,
        );
        return false;
      }
      venueImpactBps = swap.impactBps;
    }

    // Do NOT erc20Skim here — flash repay is appended AFTER callbacks and needs the
    // full repay balance on the executor. Profit stays on executor (skim later / separate tx).
    const callbackCalls = callbackEncoder.flush();

    try {
      const tSim = nowMs();
      const execResult = await simulateAndExecFlashLoanWithFallback(
        this.sharedDeps,
        callbackCalls,
        borrowUnderlying,
        false,
        repayAmount,
        collateralUnderlying,
        undefined,
        venueImpactBps,
      );
      const simMs = elapsedMs(tSim);
      this.raceMetrics.recordStage("simExec", simMs);
      console.log(
        `${this.logTag}[LiqTiming] flash account=${account.slice(0, 10)}… simExecMs=${simMs} ok=${execResult.success}` +
          (execResult.reason ? ` reason=${execResult.reason}` : ""),
      );

      if (execResult.success) {
        const collateralUsd =
          (await priceAsset(this.sharedDeps, collateralUnderlying, swapSrcAmount)) ?? 0;
        liquidationTracker.report({
          protocol: this.logTag,
          collateralToken: collateralUnderlying,
          collateralAmount: swapSrcAmount,
          collateralUsdEstimate: collateralUsd,
          timestamp: Date.now(),
        });
        console.log(
          `${this.logTag}[FlashLoan] Liquidated ${account} via ${borrowMToken.slice(0, 10)}... (repay=${repayAmount})`,
        );
        return true;
      }
      console.log(
        `${this.logTag}[FlashLoan] Skipped ${account} (${execResult.reason ?? "sim_or_profit_fail"})`,
      );
      return false;
    } catch (error) {
      console.error(
        `${this.logTag}[FlashLoan] Failed to liquidate ${account}: ${error instanceof Error ? error.message : error}`,
      );
      throw error; // rethrow so liquidateAccount can try next borrow / grade cooldown
    }
  }

  /**
   * Direct liquidation path (no flash loan — requires pre-funded underlying).
   * @returns true if liquidation executed successfully
   */
  private async liquidateDirect(
    account: Address,
    borrowMToken: Address,
    collateralMToken: Address,
    borrowUnderlying: Address,
    collateralUnderlying: Address,
    repayAmount: bigint,
  ): Promise<boolean> {
    const encoder = new LiquidationEncoder(this.executorAddress, this.client);

    const currentAllowance = await readContract(this.client, {
      address: borrowUnderlying,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.executorAddress, borrowMToken],
    });
    if (currentAllowance < repayAmount) {
      encoder.erc20Approve(borrowUnderlying, borrowMToken, maxUint256);
    }

    const { seizeMTokens, underlying: expectedCollateral } = await this.estimateSeizedUnderlying(
      borrowMToken,
      collateralMToken,
      repayAmount,
    );
    if (seizeMTokens === 0n || expectedCollateral === 0n) {
      console.log(`${this.logTag}  ${account} could not estimate seized collateral, skipping`);
      return false;
    }

    encoder.moonwellLiquidateBorrow(borrowMToken, collateralMToken, account, repayAmount);
    encoder.moonwellRedeem(collateralMToken, seizeMTokens);

    if (collateralUnderlying.toLowerCase() !== borrowUnderlying.toLowerCase()) {
      const swap = await convertCollateralToLoan(
        this.sharedDeps,
        collateralUnderlying,
        borrowUnderlying,
        expectedCollateral,
        encoder,
        { preferLocalDex: true },
      );
      this.recordConvertMetrics(swap);
      if (!swap.success) {
        this.raceMetrics.recordOutcome("skip_no_route");
        console.log(
          `${this.logTag}No DEX route for ${collateralUnderlying.slice(0, 10)}…→${borrowUnderlying.slice(0, 10)}…, try next borrow`,
        );
        return false;
      }
    }

    encoder.erc20Skim(borrowUnderlying, this.treasuryAddress);
    const calls = encoder.flush();

    try {
      const tSim = nowMs();
      const execResult = await simulateAndExec(
        this.sharedDeps,
        encoder,
        calls,
        borrowUnderlying,
        false,
        undefined,
        undefined,
        collateralUnderlying,
      );
      const simMs = elapsedMs(tSim);
      this.raceMetrics.recordStage("simExec", simMs);
      console.log(
        `${this.logTag}[LiqTiming] direct account=${account.slice(0, 10)}… simExecMs=${simMs} ok=${execResult.success}` +
          (execResult.reason ? ` reason=${execResult.reason}` : ""),
      );

      if (execResult.success) {
        const collateralUsd =
          (await priceAsset(this.sharedDeps, collateralUnderlying, expectedCollateral)) ?? 0;
        liquidationTracker.report({
          protocol: this.logTag,
          collateralToken: collateralUnderlying,
          collateralAmount: expectedCollateral,
          collateralUsdEstimate: collateralUsd,
          timestamp: Date.now(),
        });
        console.log(
          `${this.logTag}Liquidated ${account} via ${borrowMToken.slice(0, 10)}... (repay=${repayAmount})`,
        );
        return true;
      }
      console.log(
        `${this.logTag}Skipped ${account} (${execResult.reason ?? "sim_or_profit_fail"})`,
      );
      return false;
    } catch (error) {
      console.error(
        `${this.logTag}Failed to liquidate ${account}: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  private armCooldown(
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

    if (!this.cooldown) return;
    const seconds = this.cooldown.markClass(this.comptroller, account, cls);
    console.log(
      `${this.logTag}⏳ Cooldown ${cls} ${seconds}s for ${account.slice(0, 10)}…` +
        (detail ? ` (${detail.slice(0, 100)})` : ""),
    );
  }

  private armCooldownFromError(account: Address, error: unknown): void {
    if (isLiquidationRaceLostError(error) || classifyLiquidationFailure(error) === "race") {
      this.armCooldown(account, "race", error instanceof Error ? error.message : String(error));
      return;
    }
    const cls = classifyLiquidationFailure(error);
    this.armCooldown(account, cls, error instanceof Error ? error.message : String(error));
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

  // ─── Helpers ───

  /**
   * Single multicall for borrow + collateral discovery.
   * Replaces two sequential multicalls (borrowBalanceStored then balanceOf).
   */
  private async findBorrowAndCollateral(account: Address): Promise<{
    borrowPositions: { borrowMToken: Address; borrowBalance: bigint }[];
    collateralMToken: Address | null;
    /** mToken balance of collateralMToken (for SEIZE_TOO_MUCH cap). */
    collateralBalance: bigint;
    /** True if only collateral found is on RF≥99% markets (usually unprofitable). */
    collateralIsHighRf: boolean;
  }> {
    // Borrows: active (non-high-RF) markets only — we repay these underlyings.
    // Collateral: scan ALL markets so we don't miss supply only on high-RF mTokens.
    const borrowMarkets = this.mTokenList;
    const collateralMarkets = this.allMTokenList;
    const nB = borrowMarkets.length;
    const nC = collateralMarkets.length;
    try {
      this._rpcTotal += nB + nC;
      const results = await multicall(this.paidReadPool.next(), {
        contracts: [
          ...borrowMarkets.map((mToken) => ({
            address: mToken.address,
            abi: mTokenAbi,
            functionName: "borrowBalanceStored" as const,
            args: [account] as const,
          })),
          ...collateralMarkets.map((mToken) => ({
            address: mToken.address,
            abi: mTokenAbi,
            functionName: "balanceOf" as const,
            args: [account] as const,
          })),
        ],
        allowFailure: true,
      });

      const borrowPositions: { borrowMToken: Address; borrowBalance: bigint }[] = [];
      for (let i = 0; i < nB; i++) {
        const r = results[i]!;
        if (r.status !== "success") {
          this._rpcErrors++;
          continue;
        }
        if (r.result > 0n) {
          borrowPositions.push({
            borrowMToken: borrowMarkets[i]!.address,
            borrowBalance: r.result,
          });
        }
      }
      borrowPositions.sort((a, b) =>
        b.borrowBalance > a.borrowBalance ? 1 : b.borrowBalance < a.borrowBalance ? -1 : 0,
      );

      // Prefer non-high-RF collateral; fall back to largest high-RF supply for diagnostics
      let collateralMToken: Address | null = null;
      let maxBalance = 0n;
      let highRfMToken: Address | null = null;
      let highRfBal = 0n;
      for (let i = 0; i < nC; i++) {
        const r = results[nB + i]!;
        if (r.status !== "success") {
          this._rpcErrors++;
          continue;
        }
        const addr = collateralMarkets[i]!.address;
        const bal = r.result;
        if (bal === 0n) continue;
        if (this.highRfMarkets.has(addr)) {
          if (bal > highRfBal) {
            highRfBal = bal;
            highRfMToken = addr;
          }
        } else if (bal > maxBalance) {
          maxBalance = bal;
          collateralMToken = addr;
        }
      }

      let collateralIsHighRf = false;
      if (!collateralMToken && highRfMToken) {
        // Only high-RF collateral — still return it so we can log accurately;
        // caller may skip as unprofitable dust / high RF.
        collateralMToken = highRfMToken;
        maxBalance = highRfBal;
        collateralIsHighRf = true;
      }

      return {
        borrowPositions,
        collateralMToken,
        collateralBalance: maxBalance,
        collateralIsHighRf,
      };
    } catch (e) {
      this._rpcErrors += nB + nC;
      this._lastError = String(e);
      console.warn(
        `${this.logTag}⚠️ findBorrowAndCollateral multicall failed: ${e instanceof Error ? e.message : e}`,
      );
      return {
        borrowPositions: [],
        collateralMToken: null,
        collateralBalance: 0n,
        collateralIsHighRf: false,
      };
    }
  }

  /**
   * Build a lowercase Set of accounts that hold positions in any hot market.
   * Used for O(1) priority checks when sorting liquidatable accounts.
   */
  private buildHotAccountSet(): Set<string> {
    const hot = new Set<string>();
    if (this.hotMarkets.size === 0) return hot;
    for (const hotMToken of this.hotMarkets) {
      for (const account of this.registry.getAccounts(hotMToken)) {
        hot.add(account.toLowerCase());
      }
    }
    return hot;
  }

  /**
   * Initialize oracle timestamp tracking for all active markets.
   * Records baseline exchange rates for detecting changes in subsequent checks.
   */
  private async initOracleTimestamps(): Promise<void> {
    try {
      const results = await multicall(this.paidReadPool.next(), {
        contracts: this.mTokenList.map((mToken) => ({
          address: mToken.address,
          abi: mTokenAbi,
          functionName: "exchangeRateStored" as const,
        })),
        allowFailure: true,
      });

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        if (result.status === "success") {
          this.lastOracleUpdates.set(this.mTokenList[i]!.address, result.result);
        }
      }

      console.log(
        `${this.logTag}📡 Oracle tracking initialized: ${this.lastOracleUpdates.size} market(s) baseline recorded`,
      );
    } catch (e) {
      this._rpcErrors++;
      this._lastError = String(e);
      console.warn(
        `${this.logTag}⚠️ initOracleTimestamps multicall failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /**
   * Detect oracle price updates since last check.
   * Markets with updated prices are marked as "hot" for priority processing.
   */
  private async detectOracleUpdates(): Promise<void> {
    this.hotMarkets.clear();

    if (this.mTokenList.length === 0) return;

    try {
      this._rpcTotal += this.mTokenList.length;
      const results = await multicall(this.paidReadPool.next(), {
        contracts: this.mTokenList.map((mToken) => ({
          address: mToken.address,
          abi: mTokenAbi,
          functionName: "exchangeRateStored" as const,
        })),
        allowFailure: true,
      });

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        if (result.status !== "success") {
          this._rpcErrors++;
          continue;
        }
        const exchangeRate = result.result;
        const mToken = this.mTokenList[i]!.address;
        const lastRate = this.lastOracleUpdates.get(mToken);

        if (lastRate !== undefined && lastRate !== exchangeRate) {
          this.hotMarkets.add(mToken);
        }
        this.lastOracleUpdates.set(mToken, exchangeRate);
      }
    } catch (e) {
      this._rpcErrors += this.mTokenList.length;
      this._lastError = String(e);
      console.warn(
        `${this.logTag}⚠️ detectOracleUpdates multicall failed: ${e instanceof Error ? e.message : e}`,
      );
    }

    if (this.hotMarkets.size > 0) {
      console.log(
        `${this.logTag}🔥 ${this.hotMarkets.size} hot market(s) detected (exchange rate changed since last check)`,
      );
    }
  }

  /**
   * Get the underlying token address for a mToken.
   * Returns cached value from init-time discovery (hardcoded map + on-chain).
   * Falls back to mToken address itself if not found (should not happen after init).
   */
  private getUnderlying(mToken: Address): Address {
    const cached = this.underlyingCache.get(mToken);
    if (cached) return cached;

    // Fallback: should not happen after initialize() has run
    console.warn(
      `${this.logTag}⚠️ No underlying mapping for ${mToken.slice(0, 10)}..., using mToken address as fallback`,
    );
    return mToken;
  }

  /**
   * Get current bot health status for monitoring endpoints.
   */
  getHealthStatus() {
    const rpcErrorRate = this._rpcTotal > 0 ? this._rpcErrors / this._rpcTotal : 0;
    return {
      protocol: "moonwell" as const,
      lastCheckTimestamp: this._lastCheckTimestamp,
      lastCheckBlock: this._lastCheckBlock,
      registryAccountCount: this.registry.totalAccounts,
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
