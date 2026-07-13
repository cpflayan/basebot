/**
 * AaveLiquidationBot — monitors Aave V3 Pool for liquidatable accounts
 * and executes liquidations via liquidationCall with optional flash loan support.
 *
 * Architecture:
 *   - AaveAccountRegistry: discovers accounts via event scanning
 *   - getUserAccountData polling: checks healthFactor for each account
 *   - selectBestLiquidationPair: picks the most profitable (collateral, debt) pair
 *   - Flash loan path: Balancer flash loan → liquidationCall → DEX swap → repay
 *   - Reuses shared execution utilities (profit check, simulation, encoder)
 *
 * Key differences from CometLiquidationBot:
 *   - Aave has a single Pool (not per-market Comets)
 *   - Users can have multiple collateral AND debt assets
 *   - healthFactor is WAD-scaled (18 decimals), not a boolean
 *   - Dynamic close factor based on health factor level
 *   - liquidationCall targets a specific (collateral, debt) pair
 */
import type { AaveWatchlistConfig, FlashLoanProvider } from "@morpho-blue-liquidation-bot/config";
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
  maxUint256,
} from "viem";
import { readContract, multicall } from "viem/actions";
import { base } from "viem/chains";

import { AaveAccountRegistry } from "./aaveAccountRegistry.js";
import {
  aavePoolViewAbi,
  aaveReserveConfigurationAbi,
  HEALTH_FACTOR_THRESHOLD,
} from "./abis/AaveV3.js";
import {
  selectBestLiquidationPair,
  type LiquidationPair,
  type ReserveConfig,
} from "./utils/aaveAssetPairSelector.js";
import {
  classifyLiquidationFailure,
  type CooldownClass,
  PositionLiquidationCooldownMechanism,
} from "./utils/cooldownMechanisms.js";
import { findDeployBlock } from "./utils/findDeployBlock.js";
import { logLiquidationDebug } from "./utils/liquidationDebug.js";
import { LiquidationEncoder } from "./utils/LiquidationEncoder.js";
import { liquidationTracker } from "./utils/liquidationState.js";
import { RaceMetrics, elapsedMs, nowMs } from "./utils/raceMetrics.js";
import { ensureRegistryDataDir, resolveAccountRegistryPath } from "./utils/registryPaths.js";
import {
  defaultHfBatchSize,
  defaultHfConcurrency,
  resolveAaveFullScanInterval,
  resolveAaveNearHealthFactor,
  routeWarmMaxMajors,
  rpcWaveGapMs,
  shouldWarmRoutes,
  sleep,
} from "./utils/rpcBudget.js";
import { createScanClient, ReadClientPool } from "./utils/rpcFallback.js";
import {
  type SharedExecutionDeps,
  TOKEN_BLACKLIST as DEFAULT_TOKEN_BLACKLIST,
  convertCollateralToLoan,
  SharedBlockBus,
  priceAsset,
  primeTokenDecimals,
  isLiquidationRaceLostError,
  simulateAndExecFlashLoanWithFallback,
  simulateAndExec,
  warmVenueRouteCache,
} from "./utils/sharedExecution.js";

export interface AaveLiquidationBotInputs {
  logTag: string;
  client: WalletClient<Transport, Chain, Account>;
  paidReadPool: ReadClientPool;
  aaveWatchlist: AaveWatchlistConfig;
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

export class AaveLiquidationBot {
  private logTag: string;
  private client: WalletClient<Transport, Chain, Account>;
  private paidReadPool: ReadClientPool;
  private poolAddress: Address;
  private poolDeployBlock: number;
  private configuredReserves: Address[];
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
  private registry: AaveAccountRegistry;
  private pollIntervalBlocks: number;
  /** Full-registry scan every N poll ticks (hot set runs every tick). */
  private fullScanIntervalBlocks: number;
  /** HF below this (WAD) → account stays on the every-block hot set. */
  private nearHealthFactorWad: bigint;
  private hfBatchSize: number;
  private hfConcurrency: number;
  private minHealthFactorBuffer: bigint;
  private sharedDeps: SharedExecutionDeps;
  /** Read-only client using Base public RPC — for historical event scanning only */
  private scanClient: Client<Transport, Chain>;
  /** Cached reserves list from Pool.getReservesList() */
  private cachedReserves: Address[] = [];
  /** Merged token blacklist (default + config) */
  private tokenBlacklist: Set<string>;
  /** Cached reserve configs (liquidationBonus, decimals) — avoids repeated RPC calls */
  private cachedReserveConfigs = new Map<string, ReserveConfig>();
  /** Last observed HF per account (lowercase) — drives hot-set prioritization. */
  private lastHealthFactor = new Map<string, bigint>();
  private pollTick = 0;
  /** Aggregated race timings + outcome counters (flushed every ~20 ticks). */
  private raceMetrics = new RaceMetrics(20);

  // ─── Health & monitoring stats ───
  private _liquidationsAttempted = 0;
  private _liquidationsSucceeded = 0;
  private _liquidationsFailed = 0;
  private _lastCheckTimestamp = 0;
  private _lastCheckBlock = 0;
  private _rpcErrors = 0;
  private _rpcTotal = 0;
  private _lastError?: string;

  constructor(inputs: AaveLiquidationBotInputs) {
    this.logTag = inputs.logTag;
    this.client = inputs.client;
    this.paidReadPool = inputs.paidReadPool;
    this.poolAddress = inputs.aaveWatchlist.poolAddress;
    this.poolDeployBlock = inputs.aaveWatchlist.poolDeployBlock;
    this.configuredReserves = inputs.aaveWatchlist.reserves;
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
    this.pollIntervalBlocks = inputs.aaveWatchlist.pollIntervalBlocks ?? 1;
    // Env wins over config (ops can tune without rebuild) — see rpcBudget.ts
    this.fullScanIntervalBlocks = resolveAaveFullScanInterval(
      inputs.aaveWatchlist.fullScanIntervalBlocks,
    );
    const nearHf = resolveAaveNearHealthFactor(inputs.aaveWatchlist.nearHealthFactor);
    this.nearHealthFactorWad = BigInt(Math.floor(nearHf * 1e18));
    this.hfBatchSize = defaultHfBatchSize(100, inputs.aaveWatchlist.hfBatchSize);
    this.hfConcurrency = defaultHfConcurrency(
      inputs.paidReadPool.size,
      inputs.aaveWatchlist.hfConcurrency,
    );
    this.minHealthFactorBuffer = inputs.aaveWatchlist.minHealthFactorBuffer ?? 0n;

    // Merge default + config token blacklists
    this.tokenBlacklist = new Set(DEFAULT_TOKEN_BLACKLIST);
    if (inputs.aaveWatchlist.tokenBlacklist) {
      for (const addr of inputs.aaveWatchlist.tokenBlacklist) {
        this.tokenBlacklist.add(addr.toLowerCase());
      }
    }

    // Prefer explicit path; else ACCOUNT_REGISTRY_DIR / REGISTRY_DATA_DIR / DATA_DIR / ./data
    ensureRegistryDataDir();
    const registryPath =
      inputs.registryFilePath ?? resolveAccountRegistryPath(`aave-accounts.${inputs.chainId}.json`);
    this.registry = new AaveAccountRegistry(registryPath);

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

    // Read-only client for historical / incremental event scanning
    // Prefer config.scanRpcUrls (RPC_URL_BASE + BASE2..7); fall back to primary + public
    const fromInputs = (inputs.scanRpcUrls ?? []).filter(Boolean);
    const scanRpcUrls =
      fromInputs.length > 0
        ? fromInputs
        : [
            process.env.RPC_URL_BASE,
            process.env.RPC_URL_BASE2,
            process.env.RPC_URL_BASE3,
            process.env.RPC_URL_BASE4,
            process.env.RPC_URL_BASE5,
            process.env.RPC_URL_BASE6,
            process.env.RPC_URL_BASE7,
            "https://mainnet.base.org",
          ].filter((u): u is string => Boolean(u));
    this.scanClient = createScanClient(base, scanRpcUrls);
  }

  // ─── Initialization ───

  /**
   * Initialize: load registry from disk, ensure a checkpoint exists, catch up incrementally,
   * cache reserves list.
   *
   * Full historical eth_getLogs backfill is **not** done here by default (too slow / restart-hostile).
   * Prefer offline `pnpm backfill:aave` (RPC or The Graph subgraph). See ensureAccountRegistry().
   */
  async initialize(): Promise<void> {
    this.registry.loadFromFile();
    await this.ensureAccountRegistry();

    // Incremental catch-up only (from durable checkpoint → tip)
    await this.registry.initialScan(
      this.client,
      this.poolAddress,
      this.poolDeployBlock,
      this.logTag,
      this.scanClient,
    );

    await this.cacheReserves();
    await this.cacheReserveConfigs();
    await this.warmDexRoutes();

    console.log(
      `${this.logTag}🗄️ Aave registry initialized: ${this.registry.totalAccounts} total accounts, ${this.cachedReserves.length} reserves cached` +
        ` (checkpoint @ ${this.registry.getLastScannedBlock(this.poolAddress) ?? "?"})`,
    );
  }

  /**
   * Prefill DEX route cache for common Aave reserve pairs (local DEX first).
   * First live liquidation then hits cached venue instead of cold multi-venue probe.
   */
  private async warmDexRoutes(): Promise<void> {
    if (!shouldWarmRoutes()) {
      console.log(`${this.logTag}🔥 DEX warm skipped (SKIP_ROUTE_WARM=1)`);
      return;
    }
    // Cap fan-out to cut startup RPC spike (default 6 majors ≈ 30 directed pairs)
    const maxMajors = routeWarmMaxMajors(6);
    const majors = [this.wNative.toLowerCase(), ...this.cachedReserves.map((a) => a.toLowerCase())]
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .slice(0, maxMajors) as Address[];

    const pairs: { src: Address; dst: Address }[] = [];
    for (const src of majors) {
      for (const dst of majors) {
        if (src !== dst) pairs.push({ src, dst });
      }
    }

    if (pairs.length === 0) return;
    console.log(
      `${this.logTag}🔥 Warming ${pairs.length} DEX routes (prefer local AMM, majors=${maxMajors})…`,
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
   * Ensure durable account list + checkpoint exist before the bot starts monitoring.
   *
   * Priority:
   * 1. Existing data/aave-accounts.*.json (+ .checkpoint.json)
   * 2. The Graph subgraph bootstrap (THEGRAPH_API_KEY / AAVE_SUBGRAPH_URL)
   * 3. Inline multi-million-block RPC only if AAVE_INLINE_BACKFILL=1
   * 4. Otherwise throw with instructions (do not silently start empty)
   */
  private async ensureAccountRegistry(): Promise<void> {
    if (this.registry.hasCheckpoint(this.poolAddress)) {
      console.log(
        `${this.logTag}📂 Registry checkpoint present @ block ${this.registry.getLastScannedBlock(this.poolAddress)} — incremental only`,
      );
      return;
    }

    // Optional: bootstrap from official Aave protocol subgraph (borrowers with debt only)
    const { canUseAaveSubgraph, fetchAaveBorrowersFromSubgraph } = await import(
      "./utils/aaveAccountSources.js"
    );
    if (canUseAaveSubgraph(this.chainId)) {
      console.log(`${this.logTag}📡 No local checkpoint — bootstrapping from Aave subgraph…`);
      try {
        const result = await fetchAaveBorrowersFromSubgraph(this.chainId, {
          logTag: this.logTag,
        });
        const added = this.registry.importAccounts(this.poolAddress, result.accounts);
        this.registry.markSynced(this.poolAddress, result.blockNumber);
        this.registry.saveToFile();
        console.log(
          `${this.logTag}✅ Subgraph bootstrap: ${added} borrowers, checkpoint @ ${result.blockNumber}`,
        );
        return;
      } catch (e) {
        console.warn(
          `${this.logTag}⚠️ Subgraph bootstrap failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    // Escape hatch: allow bot to run full eth_getLogs history (slow; not recommended)
    if (process.env.AAVE_INLINE_BACKFILL === "1") {
      console.warn(
        `${this.logTag}⚠️ AAVE_INLINE_BACKFILL=1 — running full RPC historical scan from deploy block (prefer pnpm backfill:aave)`,
      );
      const deployBlock = await findDeployBlock(
        this.scanClient,
        this.poolAddress,
        this.poolDeployBlock,
        this.logTag,
      );
      if (deployBlock !== undefined) {
        console.log(
          `${this.logTag}🔎 Binary search: Aave Pool ${this.poolAddress.slice(0, 10)}... deployed at block ${deployBlock} (configured: ${this.poolDeployBlock})`,
        );
        this.poolDeployBlock = deployBlock;
      }
      return; // initialScan in initialize() will full-scan from deploy
    }

    throw new Error(
      `${this.logTag}No Aave account registry/checkpoint for pool ${this.poolAddress}. ` +
        `Run offline backfill first:\n` +
        `  pnpm backfill:aave -- --chain ${this.chainId} --source auto\n` +
        `Or set THEGRAPH_API_KEY / AAVE_SUBGRAPH_URL for subgraph bootstrap, ` +
        `or AAVE_INLINE_BACKFILL=1 to allow in-process full eth_getLogs (slow).`,
    );
  }

  /**
   * Cache the reserves list from Pool.getReservesList().
   * Falls back to configured reserves if on-chain call fails.
   */
  private async cacheReserves(): Promise<void> {
    try {
      const reserves = await readContract(this.client, {
        address: this.poolAddress,
        abi: aavePoolViewAbi,
        functionName: "getReservesList",
      });
      this.cachedReserves = Array.from(reserves);
      console.log(`${this.logTag}📋 Aave Pool has ${reserves.length} reserves (on-chain)`);
    } catch (e) {
      // Fallback to configured reserves
      if (this.configuredReserves.length > 0) {
        this.cachedReserves = this.configuredReserves;
        console.log(
          `${this.logTag}⚠️ On-chain getReservesList failed, using configured reserves (${this.configuredReserves.length} assets)`,
        );
      } else {
        console.error(
          `${this.logTag}Failed to cache reserves: ${e instanceof Error ? e.message : e}`,
        );
        this.cachedReserves = [];
      }
    }
  }

  /**
   * Pre-cache reserve configurations (liquidationBonus, decimals, etc.) via multicall.
   * Called once during initialization — avoids repeated RPC calls during liquidation evaluation.
   */
  private async cacheReserveConfigs(): Promise<void> {
    if (this.cachedReserves.length === 0) return;

    try {
      const results = await multicall(this.paidReadPool.next(), {
        contracts: this.cachedReserves.map((asset) => ({
          address: this.poolAddress,
          abi: aaveReserveConfigurationAbi,
          functionName: "getReserveConfigurationMap" as const,
          args: [asset] as const,
        })),
        allowFailure: true,
      });

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        if (result.status !== "success") continue;
        const asset = this.cachedReserves[i]!;
        const [
          ltv,
          liquidationThreshold,
          liquidationBonus,
          decimals,
          _reserveFactor,
          _usageAsCollateralEnabled,
          _borrowingEnabled,
          isActive,
          isFrozen,
        ] = result.result;

        const decimalsNum = Number(decimals);
        this.cachedReserveConfigs.set(asset.toLowerCase(), {
          ltv,
          liquidationThreshold,
          liquidationBonus,
          decimals: decimalsNum,
          isActive,
          isFrozen,
        });
        // Prefill process-lifetime decimals cache for profit/price paths
        primeTokenDecimals(asset, decimalsNum);
      }

      console.log(
        `${this.logTag}📊 Cached ${this.cachedReserveConfigs.size} reserve configs via multicall`,
      );
    } catch (e) {
      console.warn(
        `${this.logTag}⚠️ Failed to cache reserve configs via multicall, will fetch on-demand: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // ─── Polling loop ───

  /**
   * Start polling: race path rechecks near-liq accounts every N blocks (default 1).
   * Full-registry scans run every fullScanIntervalBlocks ticks inside checkAave.
   */
  startPolling(bus: SharedBlockBus): void {
    bus.register(this.pollIntervalBlocks, () => this.checkAave(), this.logTag);
    console.log(
      `${this.logTag}⚡ Race mode: poll every ${this.pollIntervalBlocks} block(s), ` +
        `full scan every ${this.fullScanIntervalBlocks} tick(s), ` +
        `hot HF < ${Number(this.nearHealthFactorWad) / 1e18}, ` +
        `batch=${this.hfBatchSize} concurrency=${this.hfConcurrency}`,
    );
  }

  // ─── Health status ───

  /**
   * Get current bot health status for monitoring endpoints.
   */
  getHealthStatus() {
    const rpcErrorRate = this._rpcTotal > 0 ? this._rpcErrors / this._rpcTotal : 0;
    return {
      protocol: "aave" as const,
      lastCheckTimestamp: this._lastCheckTimestamp,
      lastCheckBlock: this._lastCheckBlock,
      registryAccountCount: this.registry.totalAccounts,
      cachedReservesCount: this.cachedReserves.length,
      cachedReserveConfigsCount: this.cachedReserveConfigs.size,
      liquidationsAttempted: this._liquidationsAttempted,
      liquidationsSucceeded: this._liquidationsSucceeded,
      liquidationsFailed: this._liquidationsFailed,
      rpcErrors: this._rpcErrors,
      rpcTotal: this._rpcTotal,
      rpcErrorRate,
      lastError: this._lastError,
      isHealthy: rpcErrorRate < 0.3, // unhealthy if >30% RPC error rate
      raceMetrics: this.raceMetrics.snapshot(),
    };
  }

  /**
   * Race-critical check loop:
   *  - Hot path (every poll tick): recheck near-liq accounts only (parallel multicall shards)
   *  - Full path (every fullScanIntervalBlocks ticks): registry getLogs + full HF sweep
   *  - Liquidate lowest-HF first (competitors win soft HF last)
   */
  async checkAave(): Promise<void> {
    try {
      this.pollTick += 1;
      const doFullScan =
        this.pollTick === 1 ||
        this.pollTick % this.fullScanIntervalBlocks === 0 ||
        this.lastHealthFactor.size === 0;

      // Event discovery is not on the hot path — only on full scans
      if (doFullScan) {
        await this.registry.scanNewEvents(this.scanClient, this.poolAddress, this.logTag);
      }

      const accounts = doFullScan
        ? this.registry.getAccounts(this.poolAddress)
        : this.getHotAccounts();

      if (accounts.length === 0) {
        this.raceMetrics.onTick({
          logTag: this.logTag,
          mode: doFullScan ? "full" : "hot",
          accounts: 0,
          hot: this.countHotAccounts(),
          liquidatable: 0,
          hfScanMs: 0,
        });
        return;
      }

      const t0 = nowMs();
      const liquidatable = await this.batchCheckHealthFactor(accounts);
      const scanMs = elapsedMs(t0);

      this._lastCheckTimestamp = Math.floor(Date.now() / 1000);

      // Lowest HF first — most urgent / highest chance of still being open
      liquidatable.sort((a, b) => (a.healthFactor < b.healthFactor ? -1 : 1));

      this.raceMetrics.onTick({
        logTag: this.logTag,
        mode: doFullScan ? "full" : "hot",
        accounts: accounts.length,
        hot: this.countHotAccounts(),
        liquidatable: liquidatable.length,
        hfScanMs: scanMs,
      });

      if (liquidatable.length === 0) return;

      console.log(
        `${this.logTag}🎯 Aave Pool — ${liquidatable.length} liquidatable ` +
          `(${doFullScan ? "full" : "hot"} scan ${accounts.length} in ${scanMs}ms, ` +
          `worstHF=${Number(liquidatable[0]!.healthFactor) / 1e18})`,
      );

      for (const { account, healthFactor } of liquidatable) {
        await this.liquidateAave(account, healthFactor);
      }
    } catch (e) {
      this._rpcErrors++;
      this._lastError = String(e);
      console.error(
        `${this.logTag}Error checking Aave Pool: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /** Accounts with last HF in the near-liq band (or unknown/missing from full set). */
  private getHotAccounts(): Address[] {
    const hot: Address[] = [];
    for (const [key, hf] of this.lastHealthFactor) {
      if (hf < this.nearHealthFactorWad) {
        hot.push(key as Address);
      }
    }
    // Prefer more distressed first when we re-check
    hot.sort((a, b) => {
      const ha = this.lastHealthFactor.get(a.toLowerCase()) ?? 0n;
      const hb = this.lastHealthFactor.get(b.toLowerCase()) ?? 0n;
      return ha < hb ? -1 : ha > hb ? 1 : 0;
    });
    return hot;
  }

  private countHotAccounts(): number {
    let n = 0;
    for (const hf of this.lastHealthFactor.values()) {
      if (hf < this.nearHealthFactorWad) n++;
    }
    return n;
  }

  /**
   * Parallel-sharded multicall of getUserAccountData across paidReadPool.
   * Updates lastHealthFactor cache for hot-set selection.
   */
  private async batchCheckHealthFactor(
    accounts: Address[],
  ): Promise<{ account: Address; healthFactor: bigint }[]> {
    const threshold = HEALTH_FACTOR_THRESHOLD + this.minHealthFactorBuffer;
    const batchSize = Math.max(10, this.hfBatchSize);
    const concurrency = Math.max(
      1,
      Math.min(this.hfConcurrency, Math.max(1, this.paidReadPool.size)),
    );
    const liquidatable: { account: Address; healthFactor: bigint }[] = [];

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
                address: this.poolAddress,
                abi: aavePoolViewAbi,
                functionName: "getUserAccountData" as const,
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
            this._rpcTotal += batch.length;
            console.warn(
              `${this.logTag}⚠️ HF multicall failed on ${label}: ${e instanceof Error ? e.message : e}`,
            );
            return { batch, results: null, ok: false as const };
          }
        }),
      );

      for (const { batch, results, ok } of waveResults) {
        if (!ok || !results) continue;
        for (let j = 0; j < results.length; j++) {
          const result = results[j]!;
          const account = batch[j]!;
          if (result.status !== "success") {
            this._rpcErrors++;
            continue;
          }
          const healthFactor = result.result[5]; // WAD-scaled
          this.lastHealthFactor.set(account.toLowerCase(), healthFactor);
          if (healthFactor < threshold) {
            liquidatable.push({ account, healthFactor });
          }
        }
      }
    }

    return liquidatable;
  }

  // ─── Liquidation execution ───

  private async liquidateAave(account: Address, healthFactor: bigint): Promise<void> {
    const tTotal = nowMs();

    // Peek cooldown only — do not arm until we actually attempt execution (race-friendly)
    if (this.cooldown?.isCoolingDown(this.poolAddress, account)) {
      this.raceMetrics.recordOutcome("skip_cooldown");
      logLiquidationDebug({
        protocol: this.logTag,
        account,
        healthFactor: Number(healthFactor) / 1e18,
        decision: "skip",
        reason: "Position is in cooldown period",
      });
      return;
    }

    // Pair select on paid read pool (keep write RPC free for sim/submit)
    const tPair = nowMs();
    const pair = await selectBestLiquidationPair(
      this.paidReadPool.next(),
      this.poolAddress,
      account,
      healthFactor,
      this.cachedReserves,
      this.pricers,
      this.wNative,
      this.cachedReserveConfigs.size > 0 ? this.cachedReserveConfigs : undefined,
    );
    const pairMs = elapsedMs(tPair);
    this.raceMetrics.recordStage("pair", pairMs);

    this._liquidationsAttempted++;

    if (!pair) {
      this.raceMetrics.recordOutcome("skip_no_pair");
      logLiquidationDebug({
        protocol: this.logTag,
        account,
        healthFactor: Number(healthFactor) / 1e18,
        decision: "skip",
        reason: "No profitable liquidation pair found",
        details: {
          note: "Could not find collateral/debt pair with positive expected profit",
          pairMs,
        },
      });
      this._liquidationsAttempted--; // Don't count skipped pairs as attempts
      return;
    }

    // SECURITY: Skip blacklisted tokens
    if (
      this.tokenBlacklist.has(pair.collateralAsset.toLowerCase()) ||
      this.tokenBlacklist.has(pair.debtAsset.toLowerCase())
    ) {
      this.raceMetrics.recordOutcome("skip_blacklist");
      logLiquidationDebug({
        protocol: this.logTag,
        account,
        healthFactor: Number(healthFactor) / 1e18,
        collateral: {
          token: pair.collateralAsset,
          amount: pair.seizableCollateral,
        },
        debt: {
          token: pair.debtAsset,
          amount: pair.debtToCover,
        },
        decision: "skip",
        reason: "Blacklisted token in liquidation pair",
        details: {
          collateralBlacklisted: this.tokenBlacklist.has(pair.collateralAsset.toLowerCase()),
          debtBlacklisted: this.tokenBlacklist.has(pair.debtAsset.toLowerCase()),
        },
      });
      return;
    }

    const badDebtPosition = pair.isBadDebt;

    logLiquidationDebug({
      protocol: this.logTag,
      account,
      healthFactor: Number(healthFactor) / 1e18,
      collateral: {
        token: pair.collateralAsset,
        amount: pair.seizableCollateral,
      },
      debt: {
        token: pair.debtAsset,
        amount: pair.debtToCover,
      },
      seizableCollateral: pair.seizableCollateral,
      isBadDebt: badDebtPosition,
      decision: badDebtPosition && !this.alwaysRealizeBadDebt ? "skip" : "liquidate",
      reason:
        badDebtPosition && !this.alwaysRealizeBadDebt
          ? "Bad debt position (underwater) and alwaysRealizeBadDebt is disabled"
          : `Best pair selected: debtToCover=${pair.debtToCover}, expected profit calculation in progress`,
      details: {
        useFlashLoan: this.useFlashLoan,
        alwaysRealizeBadDebt: this.alwaysRealizeBadDebt,
        pairMs,
      },
    });

    // Bad debt pre-filter: skip early if position is underwater and we don't realize bad debt.
    // No cooldown arm here — we never attempted a tx.
    if (!this.alwaysRealizeBadDebt && badDebtPosition) {
      this.raceMetrics.recordOutcome("skip_bad_debt");
      return;
    }

    // Cooldown is armed AFTER the attempt with a graded period (race/soft/hard/success).
    if (this.useFlashLoan) {
      await this.liquidateWithFlashLoan(account, pair, badDebtPosition);
    } else {
      await this.liquidateDirect(account, pair, badDebtPosition);
    }
    this.raceMetrics.recordStage("totalLiq", elapsedMs(tTotal));
  }

  /**
   * Graded cooldown after an execution attempt.
   * race (15s): competitor / HF recovered — can re-enter hot set soon if price re-breaks.
   * soft (120s): unprofitable / route — don't spam.
   * hard/success (1h): structural fail or we already liquidated.
   */
  private armCooldown(
    account: Address,
    cls: CooldownClass,
    detail?: string,
    /** Override metrics bucket (e.g. skip_no_route uses soft cooldown but separate counter). */
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
    const seconds = this.cooldown.markClass(this.poolAddress, account, cls);
    console.log(
      `${this.logTag}⏳ Cooldown ${cls} ${seconds}s for ${account.slice(0, 10)}…` +
        (detail ? ` (${detail.slice(0, 100)})` : ""),
    );
    // Drop from hot set (HF must be ≥ near threshold). THRESHOLD+1 still stays hot when
    // near HF is 1.05 — use nearHealthFactorWad so race/success stop burning every-block RPC.
    // Full scan / next successful HF batch re-samples the real value.
    if (cls === "race" || cls === "success") {
      this.lastHealthFactor.set(account.toLowerCase(), this.nearHealthFactorWad);
    }
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

  /**
   * Direct liquidation path (no flash loan — requires pre-funded debt asset).
   */
  private async liquidateDirect(
    account: Address,
    pair: LiquidationPair,
    badDebtPosition: boolean,
  ): Promise<void> {
    const encoder = new LiquidationEncoder(this.executorAddress, this.client);

    // Approve Pool to spend debt asset
    encoder.erc20Approve(pair.debtAsset, this.poolAddress, maxUint256);

    // liquidationCall — seize collateral
    encoder.aaveLiquidationCall(
      this.poolAddress,
      pair.collateralAsset,
      pair.debtAsset,
      account,
      pair.debtToCover,
      false, // receiveAToken = false (receive underlying)
    );

    // DEX swap seized collateral → debt asset (local AMM first; no white sim without route)
    if (pair.collateralAsset.toLowerCase() !== pair.debtAsset.toLowerCase()) {
      const swap = await convertCollateralToLoan(
        this.sharedDeps,
        pair.collateralAsset,
        pair.debtAsset,
        pair.seizableCollateral,
        encoder,
        { preferLocalDex: true },
      );
      this.recordConvertMetrics(swap);
      if (!swap.success) {
        this._liquidationsFailed++;
        this.armCooldown(account, "soft", "no DEX route", "skip_no_route");
        console.log(
          `${this.logTag}No DEX route for ${pair.collateralAsset.slice(0, 10)}…→${pair.debtAsset.slice(0, 10)}…, skip direct`,
        );
        return;
      }
    }

    // Skim profit to treasury
    encoder.erc20Skim(pair.debtAsset, this.treasuryAddress);

    const calls = encoder.flush();

    try {
      const tSim = nowMs();
      const success = await simulateAndExec(
        this.sharedDeps,
        encoder,
        calls,
        pair.debtAsset,
        badDebtPosition,
        undefined,
        undefined,
        pair.collateralAsset,
      );
      const simMs = elapsedMs(tSim);
      this.raceMetrics.recordStage("simExec", simMs);
      console.log(
        `${this.logTag}[LiqTiming] direct account=${account.slice(0, 10)}… simExecMs=${simMs} ok=${success}`,
      );

      if (success) {
        this._liquidationsSucceeded++;
        this.armCooldown(account, "success");
        const collateralUsd =
          (await priceAsset(this.sharedDeps, pair.collateralAsset, pair.seizableCollateral)) ?? 0;
        liquidationTracker.report({
          protocol: this.logTag,
          collateralToken: pair.collateralAsset,
          collateralAmount: pair.seizableCollateral,
          collateralUsdEstimate: collateralUsd,
          timestamp: Date.now(),
        });
        console.log(`${this.logTag}Liquidated ${account} on Aave Pool (direct)`);
      } else {
        this._liquidationsFailed++;
        this.armCooldown(account, "soft", "not profitable / sim soft-fail");
        console.log(`${this.logTag}Skipped ${account} on Aave Pool (direct, not profitable)`);
      }
    } catch (error) {
      this._liquidationsFailed++;
      this._lastError = String(error);
      this.armCooldownFromError(account, error);
      console.error(
        `${this.logTag}Failed to liquidate ${account} on Aave Pool (direct): ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Flash loan path:
   *   1. Borrow debt asset from Balancer (0% fee)
   *   2. Approve Pool + liquidationCall — seize collateral
   *   3. DEX swap seized collateral → debt asset
   *   4. Repay flash loan + skim profit
   */
  private async liquidateWithFlashLoan(
    account: Address,
    pair: LiquidationPair,
    badDebtPosition: boolean,
  ): Promise<void> {
    const callbackEncoder = new LiquidationEncoder(this.executorAddress, this.client);

    const flashLoanAmount = pair.debtToCover;
    if (flashLoanAmount === 0n) {
      console.log(`${this.logTag}  ${account} debtToCover is 0, skipping`);
      return;
    }

    // ── Build callback calls (executed inside flash loan) ──

    // Step 1: Approve Pool to spend debt asset
    callbackEncoder.erc20Approve(pair.debtAsset, this.poolAddress, maxUint256);

    // Step 2: liquidationCall
    callbackEncoder.aaveLiquidationCall(
      this.poolAddress,
      pair.collateralAsset,
      pair.debtAsset,
      account,
      flashLoanAmount,
      false, // receiveAToken = false
    );

    // Step 3: DEX swap — fail fast if no route (do not burn flash sim)
    let venueImpactBps: bigint | undefined;
    if (pair.collateralAsset.toLowerCase() !== pair.debtAsset.toLowerCase()) {
      const swap = await convertCollateralToLoan(
        this.sharedDeps,
        pair.collateralAsset,
        pair.debtAsset,
        pair.seizableCollateral,
        callbackEncoder,
        { preferLocalDex: true },
      );
      this.recordConvertMetrics(swap);
      if (!swap.success) {
        this._liquidationsFailed++;
        this.armCooldown(account, "soft", "no DEX route", "skip_no_route");
        console.log(
          `${this.logTag}No DEX route for ${pair.collateralAsset.slice(0, 10)}…→${pair.debtAsset.slice(0, 10)}…, skip flash`,
        );
        return;
      }
      venueImpactBps = swap.impactBps;
    }

    // Step 4: Skim profit to treasury
    callbackEncoder.erc20Skim(pair.debtAsset, this.treasuryAddress);

    const callbackCalls = callbackEncoder.flush();

    // Step 5: Wrap with flash loan + simulate/exec (pass impact for dynamic slippage)
    try {
      const tSim = nowMs();
      const success = await simulateAndExecFlashLoanWithFallback(
        this.sharedDeps,
        callbackCalls,
        pair.debtAsset,
        badDebtPosition,
        flashLoanAmount,
        pair.collateralAsset,
        undefined, // cachedGasPrice
        venueImpactBps,
      );
      const simMs = elapsedMs(tSim);
      this.raceMetrics.recordStage("simExec", simMs);
      console.log(
        `${this.logTag}[LiqTiming] flash account=${account.slice(0, 10)}… simExecMs=${simMs} ok=${success}`,
      );

      if (success) {
        this._liquidationsSucceeded++;
        this.armCooldown(account, "success");
        const collateralUsd =
          (await priceAsset(this.sharedDeps, pair.collateralAsset, pair.seizableCollateral)) ?? 0;
        liquidationTracker.report({
          protocol: this.logTag,
          collateralToken: pair.collateralAsset,
          collateralAmount: pair.seizableCollateral,
          collateralUsdEstimate: collateralUsd,
          timestamp: Date.now(),
        });
        console.log(`${this.logTag}[FlashLoan] Liquidated ${account} on Aave Pool`);
      } else {
        this._liquidationsFailed++;
        this.armCooldown(account, "soft", "not profitable / providers exhausted");
        console.log(`${this.logTag}[FlashLoan] Skipped ${account} on Aave Pool (not profitable)`);
      }
    } catch (error) {
      this._liquidationsFailed++;
      this._lastError = String(error);
      this.armCooldownFromError(account, error);
      console.error(
        `${this.logTag}[FlashLoan] Failed to liquidate ${account} on Aave Pool: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
