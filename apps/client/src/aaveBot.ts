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
import type { AaveWatchlistConfig } from "@morpho-blue-liquidation-bot/config";
import type { LiquidityVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import type { Pricer } from "@morpho-blue-liquidation-bot/pricers";
import {
  type Address,
  type Transport,
  type Chain,
  type Account,
  type Client,
  type WalletClient,
  type LocalAccount,
  maxUint256,
  createPublicClient,
  http,
} from "viem";
import { readContract, watchBlocks, multicall } from "viem/actions";
import { base } from "viem/chains";

import { AaveAccountRegistry } from "./aaveAccountRegistry.js";
import {
  aavePoolViewAbi,
  aaveReserveConfigurationAbi,
  HEALTH_FACTOR_THRESHOLD,
} from "./abis/AaveV3.js";
import { BALANCER_VAULT_ADDRESS } from "./abis/BalancerVault.js";
import {
  selectBestLiquidationPair,
  type LiquidationPair,
  type ReserveConfig,
} from "./utils/aaveAssetPairSelector.js";
import { PositionLiquidationCooldownMechanism } from "./utils/cooldownMechanisms.js";
import { findDeployBlock } from "./utils/findDeployBlock.js";
import { LiquidationEncoder } from "./utils/LiquidationEncoder.js";
import {
  type SharedExecutionDeps,
  convertCollateralToLoan,
  simulateAndExecFlashLoan,
  simulateAndExec,
} from "./utils/sharedExecution.js";

/** Base 官方公開 RPC — 支持 10,000 區塊範圍的 eth_getLogs */
const BASE_PUBLIC_RPC = "https://mainnet.base.org";

/**
 * Default token blacklist — skip positions involving these tokens.
 * Merged with config-provided tokenBlacklist at runtime.
 */
const DEFAULT_TOKEN_BLACKLIST = new Set<string>([
  "0x35e5db674d8e93a03d814fa0ada70731efe8a4b9", // USR (depegged)
]);

export interface AaveLiquidationBotInputs {
  logTag: string;
  client: WalletClient<Transport, Chain, Account>;
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
  flashLoanProvider?: "balancer" | "aave";
  alwaysRealizeBadDebt?: boolean;
  registryFilePath?: string;
}

export class AaveLiquidationBot {
  private logTag: string;
  private client: WalletClient<Transport, Chain, Account>;
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
  private flashLoanProvider: "balancer" | "aave";
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
  /** Slippage tolerance for DEX swaps in bps */
  private slippageBps: number;
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
    this.alwaysRealizeBadDebt = inputs.alwaysRealizeBadDebt ?? false;
    this.pollIntervalBlocks = inputs.aaveWatchlist.pollIntervalBlocks ?? 5;
    this.minHealthFactorBuffer = inputs.aaveWatchlist.minHealthFactorBuffer ?? 0n;
    this.slippageBps = inputs.aaveWatchlist.slippageBps ?? 100;

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
    };

    // Read-only client on Base public RPC for historical scanning
    this.scanClient = createPublicClient({
      chain: base,
      transport: http(BASE_PUBLIC_RPC),
    });
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
        console.error(`${this.logTag}Failed to cache reserves:`, e);
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
      const results = await multicall(this.client, {
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

        this.cachedReserveConfigs.set(asset.toLowerCase(), {
          ltv,
          liquidationThreshold,
          liquidationBonus,
          decimals: Number(decimals),
          isActive,
          isFrozen,
        });
      }

      console.log(
        `${this.logTag}📊 Cached ${this.cachedReserveConfigs.size} reserve configs via multicall`,
      );
    } catch (e) {
      console.warn(
        `${this.logTag}⚠️ Failed to cache reserve configs via multicall, will fetch on-demand:`,
        e,
      );
    }
  }

  // ─── Polling loop ───

  /**
   * Start polling: check getUserAccountData on every N blocks.
   * Returns an unwatch function.
   */
  startPolling(): () => void {
    let blockCount = 0;
    let running = false;

    const unwatch = watchBlocks(this.client, {
      onBlock: (block) => {
        blockCount++;
        this._lastCheckBlock = Number(block.number ?? 0);
        if (blockCount % this.pollIntervalBlocks !== 0) return;
        if (running) return; // Prevent overlapping runs
        running = true;

        this.checkAave()
          .catch((e: unknown) => {
            console.error(`${this.logTag}Error in checkAave:`, e);
          })
          .finally(() => {
            running = false;
          });
      },
      onError: (error: Error) => {
        console.error(`${this.logTag}watchBlocks error:`, error);
      },
    });

    console.log(`${this.logTag}📡 Aave polling started (every ${this.pollIntervalBlocks} blocks)`);

    return unwatch;
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
      await this.registry.scanNewEvents(this.client, this.poolAddress, this.logTag);

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
      console.error(`${this.logTag}Error checking Aave Pool:`, e);
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
        const results = await multicall(this.client, {
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
        console.warn(`${this.logTag}⚠️ batchCheckHealthFactor batch ${i / BATCH_SIZE} failed:`, e);
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
      console.log(`${this.logTag}  ${account} — no profitable liquidation pair found, skipping`);
      this._liquidationsAttempted--; // Don't count skipped pairs as attempts
      return;
    }

    // SECURITY: Skip blacklisted tokens
    if (
      this.tokenBlacklist.has(pair.collateralAsset.toLowerCase()) ||
      this.tokenBlacklist.has(pair.debtAsset.toLowerCase())
    ) {
      console.log(`${this.logTag}⛔ Skip ${account}: blacklisted token in pair`);
      return;
    }

    // Cooldown check
    if (this.cooldown && !this.cooldown.isPositionReady(this.poolAddress, account)) {
      return;
    }

    console.log(
      `${this.logTag}  🎯 ${account} HF=${(Number(healthFactor) / 1e18).toFixed(4)} — ` +
        `best pair: collateral=${pair.collateralAsset.slice(0, 10)}... debt=${pair.debtAsset.slice(0, 10)}... ` +
        `debtToCover=${pair.debtToCover}`,
    );

    const badDebtPosition = pair.isBadDebt;

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
      );

      if (success) {
        this._liquidationsSucceeded++;
        console.log(`${this.logTag}Liquidated ${account} on Aave Pool (direct)`);
      } else {
        this._liquidationsFailed++;
        console.log(`${this.logTag}Skipped ${account} on Aave Pool (direct, not profitable)`);
      }
    } catch (error) {
      this._liquidationsFailed++;
      this._lastError = String(error);
      console.error(`${this.logTag}Failed to liquidate ${account} on Aave Pool (direct)`, error);
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
    const encoder = new LiquidationEncoder(this.executorAddress, this.client);
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
        0n, // amount determined at runtime by executor balance
        callbackEncoder,
      );
    }

    // Step 4: Skim profit to treasury
    callbackEncoder.erc20Skim(pair.debtAsset, this.treasuryAddress);

    const callbackCalls = callbackEncoder.flush();

    // ── Wrap in Balancer flash loan (0% fee) ──
    encoder.balancerFlashLoan(
      BALANCER_VAULT_ADDRESS,
      [{ asset: pair.debtAsset, amount: flashLoanAmount }],
      callbackCalls,
    );

    const calls = encoder.flush();

    try {
      const success = await simulateAndExecFlashLoan(
        this.sharedDeps,
        encoder,
        calls,
        pair.debtAsset,
        badDebtPosition,
        flashLoanAmount,
      );

      if (success) {
        this._liquidationsSucceeded++;
        console.log(`${this.logTag}[FlashLoan] Liquidated ${account} on Aave Pool`);
      } else {
        this._liquidationsFailed++;
        console.log(`${this.logTag}[FlashLoan] Skipped ${account} on Aave Pool (not profitable)`);
      }
    } catch (error) {
      this._liquidationsFailed++;
      this._lastError = String(error);
      console.error(`${this.logTag}[FlashLoan] Failed to liquidate ${account} on Aave Pool`, error);
    }
  }
}
