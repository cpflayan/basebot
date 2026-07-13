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
import { PositionLiquidationCooldownMechanism } from "./utils/cooldownMechanisms.js";
import { findDeployBlock } from "./utils/findDeployBlock.js";
import { logLiquidationDebug } from "./utils/liquidationDebug.js";
import { LiquidationEncoder } from "./utils/LiquidationEncoder.js";
import { liquidationTracker } from "./utils/liquidationState.js";
import { createScanClient, ReadClientPool } from "./utils/rpcFallback.js";
import {
  type SharedExecutionDeps,
  TOKEN_BLACKLIST as DEFAULT_TOKEN_BLACKLIST,
  convertCollateralToLoan,
  SharedBlockBus,
  priceAsset,
  primeTokenDecimals,
  simulateAndExecFlashLoanWithFallback,
  simulateAndExec,
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
    this.pollIntervalBlocks = inputs.aaveWatchlist.pollIntervalBlocks ?? 5;
    this.minHealthFactorBuffer = inputs.aaveWatchlist.minHealthFactorBuffer ?? 0n;

    // Merge default + config token blacklists
    this.tokenBlacklist = new Set(DEFAULT_TOKEN_BLACKLIST);
    if (inputs.aaveWatchlist.tokenBlacklist) {
      for (const addr of inputs.aaveWatchlist.tokenBlacklist) {
        this.tokenBlacklist.add(addr.toLowerCase());
      }
    }

    const registryPath = inputs.registryFilePath ?? `./data/aave-accounts.${inputs.chainId}.json`;
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

    // Read-only client for historical scanning — uses paid Alchemy RPC for better rate limits
    const paidRpcUrl = process.env.RPC_URL_BASE;
    const scanRpcUrls = paidRpcUrl
      ? [paidRpcUrl, "https://mainnet.base.org"]
      : ["https://mainnet.base.org"];
    this.scanClient = createScanClient(base, scanRpcUrls);
  }

  // ─── Initialization ───

  /**
   * Initialize: load registry from disk, find deploy block, scan historical events,
   * cache reserves list.
   */
  async initialize(): Promise<void> {
    // Load persisted account registry
    this.registry.loadFromFile();

    // Find exact deploy block via binary search
    const lastScanned = this.registry.getLastScannedBlock(this.poolAddress);
    if (lastScanned === undefined) {
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
    }

    // Historical scan using Base public RPC (scanClient)
    await this.registry.initialScan(
      this.client,
      this.poolAddress,
      this.poolDeployBlock,
      this.logTag,
      this.scanClient,
    );

    // Cache reserves list
    await this.cacheReserves();

    // Pre-cache reserve configs (liquidationBonus, decimals) via multicall
    await this.cacheReserveConfigs();

    console.log(
      `${this.logTag}🗄️ Aave registry initialized: ${this.registry.totalAccounts} total accounts, ${this.cachedReserves.length} reserves cached`,
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
   * Start polling: check getUserAccountData on every N blocks.
   * Returns an unwatch function.
   */
  startPolling(bus: SharedBlockBus): void {
    bus.register(this.pollIntervalBlocks, () => this.checkAave(), this.logTag);
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
    };
  }

  /**
   * Core check loop: scan new events, batch-check health factors, trigger liquidations.
   */
  async checkAave(): Promise<void> {
    try {
      // Incremental scan for new accounts
      await this.registry.scanNewEvents(this.scanClient, this.poolAddress, this.logTag);

      // Get all known accounts — prioritize recently active ones
      // (accounts added later from event scanning have more recent activity)
      const accounts = this.registry.getAccounts(this.poolAddress);
      if (accounts.length === 0) return;
      accounts.reverse(); // Most recently active first

      // Batch check health factors
      const liquidatable = await this.batchCheckHealthFactor(accounts);

      // Update check metadata
      this._lastCheckTimestamp = Math.floor(Date.now() / 1000);

      if (liquidatable.length === 0) return;

      console.log(`${this.logTag}🎯 Aave Pool — ${liquidatable.length} liquidatable account(s)!`);

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

  /**
   * Batch check getUserAccountData for multiple accounts using multicall.
   * Processes accounts in batches of 50 to avoid RPC timeouts.
   * Returns accounts with healthFactor < threshold (adjusted by buffer).
   */
  private async batchCheckHealthFactor(
    accounts: Address[],
  ): Promise<{ account: Address; healthFactor: bigint }[]> {
    const threshold = HEALTH_FACTOR_THRESHOLD + this.minHealthFactorBuffer;
    const BATCH_SIZE = 50;
    const liquidatable: { account: Address; healthFactor: bigint }[] = [];

    // Process in batches of 50 to avoid RPC timeouts on large account lists
    for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
      const batch = accounts.slice(i, i + BATCH_SIZE);

      try {
        const results = await multicall(this.paidReadPool.next(), {
          contracts: batch.map((account) => ({
            address: this.poolAddress,
            abi: aavePoolViewAbi,
            functionName: "getUserAccountData" as const,
            args: [account] as const,
          })),
          allowFailure: true,
        });

        this._rpcTotal += batch.length;

        for (let j = 0; j < results.length; j++) {
          const result = results[j]!;
          if (result.status !== "success") {
            this._rpcErrors++;
            continue;
          }
          const healthFactor = result.result[5]; // healthFactor is index 5 (WAD-scaled)
          if (healthFactor < threshold) {
            liquidatable.push({ account: batch[j]!, healthFactor });
          }
        }
      } catch (e) {
        this._rpcErrors += batch.length;
        this._rpcTotal += batch.length;
        console.warn(
          `${this.logTag}⚠️ batchCheckHealthFactor batch ${i / BATCH_SIZE} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    return liquidatable;
  }

  // ─── Liquidation execution ───

  private async liquidateAave(account: Address, healthFactor: bigint): Promise<void> {
    // Select best (collateral, debt) pair — pass cached reserve configs to avoid RPC
    const pair = await selectBestLiquidationPair(
      this.client,
      this.poolAddress,
      account,
      healthFactor,
      this.cachedReserves,
      this.pricers,
      this.wNative,
      this.cachedReserveConfigs.size > 0 ? this.cachedReserveConfigs : undefined,
    );

    this._liquidationsAttempted++;

    if (!pair) {
      logLiquidationDebug({
        protocol: this.logTag,
        account,
        healthFactor: Number(healthFactor) / 1e18,
        decision: "skip",
        reason: "No profitable liquidation pair found",
        details: {
          note: "Could not find collateral/debt pair with positive expected profit",
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
      },
    });

    // Bad debt pre-filter: skip early if position is underwater and we don't realize bad debt.
    // Runs BEFORE the cooldown check so these positions never trip the cooldown timer.
    if (!this.alwaysRealizeBadDebt && badDebtPosition) {
      return;
    }

    // Cooldown check — only reached once we've decided this position is actually worth
    // attempting, so the cooldown timer only ever reflects a real attempt.
    if (this.cooldown && !this.cooldown.isPositionReady(this.poolAddress, account)) {
      logLiquidationDebug({
        protocol: this.logTag,
        account,
        healthFactor: Number(healthFactor) / 1e18,
        decision: "skip",
        reason: "Position is in cooldown period",
        details: {
          note: "Recently attempted liquidation, waiting before retry",
        },
      });
      return;
    }

    if (this.useFlashLoan) {
      await this.liquidateWithFlashLoan(account, pair, badDebtPosition);
    } else {
      await this.liquidateDirect(account, pair, badDebtPosition);
    }
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

    // DEX swap seized collateral → debt asset
    if (pair.collateralAsset.toLowerCase() !== pair.debtAsset.toLowerCase()) {
      await convertCollateralToLoan(
        this.sharedDeps,
        pair.collateralAsset,
        pair.debtAsset,
        pair.seizableCollateral,
        encoder,
      );
    }

    // Skim profit to treasury
    encoder.erc20Skim(pair.debtAsset, this.treasuryAddress);

    const calls = encoder.flush();

    try {
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

      if (success) {
        this._liquidationsSucceeded++;
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
        console.log(`${this.logTag}Skipped ${account} on Aave Pool (direct, not profitable)`);
      }
    } catch (error) {
      this._liquidationsFailed++;
      this._lastError = String(error);
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

    // Step 3: DEX swap seized collateral → debt asset
    if (pair.collateralAsset.toLowerCase() !== pair.debtAsset.toLowerCase()) {
      await convertCollateralToLoan(
        this.sharedDeps,
        pair.collateralAsset,
        pair.debtAsset,
        // Aave's seized amount is known off-chain (same value used by liquidationCall
        // above and by the non-flash-loan path), so reuse it instead of a literal 0 —
        // passing 0 here made every venue attempt a zero-amount swap and revert.
        pair.seizableCollateral,
        callbackEncoder,
      );
    }

    // Step 4: Skim profit to treasury
    callbackEncoder.erc20Skim(pair.debtAsset, this.treasuryAddress);

    const callbackCalls = callbackEncoder.flush();

    // Step 5: Wrap with flash loan (with fallback providers) and simulate + execute.
    try {
      const success = await simulateAndExecFlashLoanWithFallback(
        this.sharedDeps,
        callbackCalls,
        pair.debtAsset,
        badDebtPosition,
        flashLoanAmount,
        pair.collateralAsset,
      );

      if (success) {
        this._liquidationsSucceeded++;
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
        console.log(`${this.logTag}[FlashLoan] Skipped ${account} on Aave Pool (not profitable)`);
      }
    } catch (error) {
      this._liquidationsFailed++;
      this._lastError = String(error);
      console.error(
        `${this.logTag}[FlashLoan] Failed to liquidate ${account} on Aave Pool: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
