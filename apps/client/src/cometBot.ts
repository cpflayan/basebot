/**
 * CometLiquidationBot — monitors Compound V3 Comet markets for liquidatable accounts
 * and executes liquidations via absorb + buyCollateral with optional flash loan support.
 *
 * Architecture:
 *   - CometAccountRegistry: discovers accounts via event scanning
 *   - isLiquidatable polling: checks each account on each block interval
 *   - Flash loan path: Balancer flash loan → absorb → buyCollateral → DEX swap → repay
 *   - Reuses shared execution utilities (profit check, simulation, encoder)
 */
import type { CometWatchlistConfig, FlashLoanProvider } from "@morpho-blue-liquidation-bot/config";
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

import { cometViewAbi, COMET_COLLATERAL_ASSETS } from "./abis/Comet.js";
import { CometAccountRegistry } from "./cometAccountRegistry.js";
import { PositionLiquidationCooldownMechanism } from "./utils/cooldownMechanisms.js";
import { findDeployBlock } from "./utils/findDeployBlock.js";
import { LiquidationEncoder } from "./utils/LiquidationEncoder.js";
import { liquidationTracker } from "./utils/liquidationState.js";
import { createScanClient, ReadClientPool } from "./utils/rpcFallback.js";
import {
  type SharedExecutionDeps,
  TOKEN_BLACKLIST,
  convertCollateralToLoan,
  SharedBlockBus,
  priceAsset,
  simulateAndExecFlashLoanWithFallback,
  simulateAndExec,
} from "./utils/sharedExecution.js";

export interface CometLiquidationBotInputs {
  logTag: string;
  client: WalletClient<Transport, Chain, Account>;
  paidReadPool: ReadClientPool;
  cometWatchlist: CometWatchlistConfig;
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

interface CometInfo {
  address: Address;
  baseAsset: Address;
  deployBlock: number;
  /** Collateral assets supported by this Comet (cached from chain) */
  collateralAssets?: Address[];
}

export class CometLiquidationBot {
  private logTag: string;
  private client: WalletClient<Transport, Chain, Account>;
  private paidReadPool: ReadClientPool;
  private cometList: CometInfo[];
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
  private registry: CometAccountRegistry;
  private pollIntervalBlocks: number;
  private sharedDeps: SharedExecutionDeps;
  /** Read-only client using Base public RPC — for historical event scanning only */
  private scanClient: Client<Transport, Chain>;

  // ─── Health & monitoring stats ───
  private _liquidationsAttempted = 0;
  private _liquidationsSucceeded = 0;
  private _liquidationsFailed = 0;
  private _lastCheckTimestamp = 0;
  private _lastCheckBlock = 0;
  private _rpcErrors = 0;
  private _rpcTotal = 0;
  private _lastError?: string;

  constructor(inputs: CometLiquidationBotInputs) {
    this.logTag = inputs.logTag;
    this.client = inputs.client;
    this.paidReadPool = inputs.paidReadPool;
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
    this.pollIntervalBlocks = inputs.cometWatchlist.pollIntervalBlocks ?? 5;

    this.cometList = inputs.cometWatchlist.comets.map(
      (c: { address: Address; baseAsset: Address; deployBlock: number }) => ({
        address: c.address,
        baseAsset: c.baseAsset,
        deployBlock: c.deployBlock,
      }),
    );

    const registryPath = inputs.registryFilePath ?? `./data/comet-accounts.${inputs.chainId}.json`;
    this.registry = new CometAccountRegistry(registryPath);

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
   * Initialize: load registry from disk, find deploy blocks via binary search,
   * scan historical events using Base public RPC, cache collateral assets.
   */
  async initialize(): Promise<void> {
    // Load persisted account registry
    this.registry.loadFromFile();

    // Scan each Comet for historical accounts
    for (const comet of this.cometList) {
      // Binary search to find exact deploy block (if not already scanned)
      const lastScanned = this.registry.getLastScannedBlock(comet.address);
      if (lastScanned === undefined) {
        const deployBlock = await findDeployBlock(
          this.scanClient,
          comet.address,
          comet.deployBlock,
          this.logTag,
        );
        if (deployBlock !== undefined) {
          console.log(
            `${this.logTag}🔎 Binary search: ${comet.address.slice(0, 10)}... deployed at block ${deployBlock} (configured: ${comet.deployBlock})`,
          );
          comet.deployBlock = deployBlock;
        }
      }

      // Historical scan using Base public RPC (scanClient)
      await this.registry.initialScan(
        this.client,
        comet.address,
        comet.deployBlock,
        this.logTag,
        this.scanClient,
      );

      // Cache collateral assets for this Comet
      await this.cacheCollateralAssets(comet);
    }

    console.log(
      `${this.logTag}🗄️ Comet registry initialized: ${this.registry.totalAccounts} total accounts across ${this.cometList.length} Comets`,
    );
  }

  /**
   * Cache the collateral assets for a Comet by reading numCollateralAssets + getCollateralAsset.
   * Falls back to hardcoded list if on-chain call fails.
   */
  private async cacheCollateralAssets(comet: CometInfo): Promise<void> {
    try {
      const numCollateral = await readContract(this.client, {
        address: comet.address,
        abi: cometViewAbi,
        functionName: "numCollateralAssets",
      });

      const assets: Address[] = [];
      for (let i = 0; i < numCollateral; i++) {
        const asset = await readContract(this.client, {
          address: comet.address,
          abi: cometViewAbi,
          functionName: "getCollateralAsset",
          args: [i],
        });
        assets.push(asset);
      }

      comet.collateralAssets = assets;
      console.log(
        `${this.logTag}📋 ${comet.address.slice(0, 10)}... has ${assets.length} collateral asset(s) (on-chain)`,
      );
    } catch (e) {
      // Fallback to hardcoded list
      const fallback = COMET_COLLATERAL_ASSETS[comet.address];
      if (fallback && fallback.length > 0) {
        comet.collateralAssets = fallback;
        console.log(
          `${this.logTag}⚠️ On-chain call failed, using hardcoded collateral list for ${comet.address.slice(0, 10)}... (${fallback.length} assets)`,
        );
      } else {
        console.error(
          `${this.logTag}Failed to cache collateral assets for ${comet.address.slice(0, 10)}...: ${e instanceof Error ? e.message : e}`,
        );
        comet.collateralAssets = [];
      }
    }
  }

  // ─── Polling loop ───

  /**
   * Start polling: check isLiquidatable on every N blocks.
   * Returns an unwatch function.
   */
  startPolling(bus: SharedBlockBus): void {
    bus.register(this.pollIntervalBlocks, () => this.checkAllComets(), this.logTag);
  }

  /**
   * Core check loop: for each Comet, scan new events, then check isLiquidatable for all known accounts.
   */
  async checkAllComets(): Promise<void> {
    this._lastCheckTimestamp = Math.floor(Date.now() / 1000);

    for (const comet of this.cometList) {
      try {
        // Incremental scan for new accounts
        await this.registry.scanNewEvents(this.client, comet.address, this.logTag);

        // Get all known accounts
        const accounts = this.registry.getAccounts(comet.address);
        if (accounts.length === 0) continue;

        // Batch check isLiquidatable
        const liquidatable = await this.batchCheckLiquidatable(comet.address, accounts);

        if (liquidatable.length === 0) continue;

        console.log(
          `${this.logTag}🎯 ${comet.address.slice(0, 10)}... — ${liquidatable.length} liquidatable account(s)!`,
        );

        for (const account of liquidatable) {
          await this.liquidateComet(comet, account);
        }
      } catch (e) {
        console.error(
          `${this.logTag}Error checking Comet ${comet.address.slice(0, 10)}...: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  /**
   * Batch check isLiquidatable for multiple accounts using multicall.
   * 50 accounts = 1 RPC call instead of 50.
   */
  private async batchCheckLiquidatable(comet: Address, accounts: Address[]): Promise<Address[]> {
    const BATCH_SIZE = 50;
    const liquidatable: Address[] = [];

    for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
      const batch = accounts.slice(i, i + BATCH_SIZE);

      try {
        const results = await multicall(this.paidReadPool.next(), {
          contracts: batch.map((account) => ({
            address: comet,
            abi: cometViewAbi,
            functionName: "isLiquidatable" as const,
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
          const [isLiq] = result.result;
          if (isLiq) {
            liquidatable.push(batch[j]!);
          }
        }
      } catch (e) {
        this._rpcErrors += batch.length;
        this._rpcTotal += batch.length;
        this._lastError = String(e);
        console.warn(
          `${this.logTag}⚠️ batchCheckLiquidatable batch ${i / BATCH_SIZE} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    return liquidatable;
  }

  // ─── Liquidation execution ───

  private async liquidateComet(comet: CometInfo, account: Address): Promise<void> {
    // SECURITY: Skip blacklisted tokens
    if (TOKEN_BLACKLIST.has(comet.baseAsset.toLowerCase())) {
      console.log(`${this.logTag}⛔ Skip ${account}: blacklisted base asset`);
      return;
    }

    // Cooldown check
    if (this.cooldown && !this.cooldown.isPositionReady(comet.address, account)) {
      return;
    }

    console.log(`${this.logTag}  🎯 ${account} — attempting Comet liquidation`);

    this._liquidationsAttempted++;

    if (this.useFlashLoan) {
      await this.liquidateCometWithFlashLoan(comet, account);
    } else {
      await this.liquidateCometDirect(comet, account);
    }
  }

  /**
   * Flash loan path:
   *   1. Borrow base asset from Balancer
   *   2. absorb(account) — seize collateral
   *   3. buyCollateral — buy seized collateral from Comet
   *   4. DEX swap collateral → base asset (if needed)
   *   5. Repay flash loan + skim profit
   */
  private async liquidateCometWithFlashLoan(comet: CometInfo, account: Address): Promise<void> {
    const collateralAssets = comet.collateralAssets ?? [];
    if (collateralAssets.length === 0) {
      console.log(
        `${this.logTag}  No collateral assets cached for ${comet.address.slice(0, 10)}..., skipping`,
      );
      return;
    }

    // Estimate flash loan amount: read user's borrow balance
    const flashLoanAmount = await this.estimateDebt(comet.address, account);
    if (flashLoanAmount === 0n) {
      console.log(`${this.logTag}  ${account} has no debt, skipping`);
      return;
    }

    const callbackEncoder = new LiquidationEncoder(this.executorAddress, this.client);

    // Step 1: Approve Comet to spend base asset (for buyCollateral) — only if needed
    const currentAllowance = await readContract(this.client, {
      address: comet.baseAsset,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.executorAddress, comet.address],
    });
    if (currentAllowance < flashLoanAmount) {
      callbackEncoder.erc20Approve(comet.baseAsset, comet.address, maxUint256);
    }

    // Step 2: Absorb — seize collateral from underwater account
    callbackEncoder.cometAbsorb(comet.address, [account]);

    // Step 3: Buy collateral from Comet using base asset
    // Batch-read all collateral reserves via multicall (1 RPC instead of N)
    const filteredCollaterals = collateralAssets.filter(
      (c) => !TOKEN_BLACKLIST.has(c.toLowerCase()),
    );
    const reserveResults = await multicall(this.paidReadPool.next(), {
      contracts: filteredCollaterals.map((collateral) => ({
        address: comet.address,
        abi: cometViewAbi,
        functionName: "getCollateralReserves" as const,
        args: [collateral] as const,
      })),
      allowFailure: true,
    });

    for (let i = 0; i < reserveResults.length; i++) {
      const result = reserveResults[i]!;
      if (result.status !== "success" || result.result <= 0n) continue;
      const collateral = filteredCollaterals[i]!;
      callbackEncoder.cometBuyCollateral(
        comet.address,
        collateral,
        0n, // minAmount = 0 (we rely on simulation for safety)
        flashLoanAmount, // max base asset to spend
      );
    }

    // Step 4: DEX swap any non-base collateral → base asset
    for (const collateral of collateralAssets) {
      if (TOKEN_BLACKLIST.has(collateral.toLowerCase())) continue;
      if (collateral.toLowerCase() === comet.baseAsset.toLowerCase()) continue;

      await convertCollateralToLoan(
        this.sharedDeps,
        collateral,
        comet.baseAsset,
        0n, // amount will be determined at runtime by executor balance
        callbackEncoder,
      );
    }

    // Step 5: Skim profit to treasury
    callbackEncoder.erc20Skim(comet.baseAsset, this.treasuryAddress);

    const callbackCalls = callbackEncoder.flush();

    // Find primary collateral for cross-protocol tracking (first non-base, non-blacklisted)
    const primaryCollateral = collateralAssets.find(
      (c) =>
        !TOKEN_BLACKLIST.has(c.toLowerCase()) && c.toLowerCase() !== comet.baseAsset.toLowerCase(),
    );

    // Step 7: Wrap with flash loan (with fallback providers) and simulate + execute.
    try {
      const success = await simulateAndExecFlashLoanWithFallback(
        this.sharedDeps,
        callbackCalls,
        comet.baseAsset,
        false, // Comet liquidations are always profitable if simulation passes
        flashLoanAmount,
        primaryCollateral,
      );

      if (success) {
        this._liquidationsSucceeded++;
        if (primaryCollateral) {
          const collateralUsd =
            (await priceAsset(this.sharedDeps, primaryCollateral, flashLoanAmount)) ?? 0;
          liquidationTracker.report({
            protocol: this.logTag,
            collateralToken: primaryCollateral,
            collateralAmount: flashLoanAmount,
            collateralUsdEstimate: collateralUsd,
            timestamp: Date.now(),
          });
        }
        console.log(
          `${this.logTag}[FlashLoan] Liquidated ${account} on Comet ${comet.address.slice(0, 10)}...`,
        );
      } else {
        console.log(
          `${this.logTag}[FlashLoan] Skipped ${account} on Comet ${comet.address.slice(0, 10)}... (not profitable)`,
        );
      }
    } catch (error) {
      this._liquidationsFailed++;
      this._lastError = String(error);
      console.error(
        `${this.logTag}[FlashLoan] Failed to liquidate ${account} on Comet ${comet.address.slice(0, 10)}...: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Direct liquidation path (no flash loan — requires pre-funded base asset).
   */
  private async liquidateCometDirect(comet: CometInfo, account: Address): Promise<void> {
    const collateralAssets = comet.collateralAssets ?? [];
    const encoder = new LiquidationEncoder(this.executorAddress, this.client);

    // Approve Comet — only if allowance insufficient
    const currentAllowance = await readContract(this.client, {
      address: comet.baseAsset,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.executorAddress, comet.address],
    });
    if (currentAllowance === 0n) {
      encoder.erc20Approve(comet.baseAsset, comet.address, maxUint256);
    }

    // Absorb
    encoder.cometAbsorb(comet.address, [account]);

    // Buy collateral — batch-read reserves via multicall
    const filteredCollaterals = collateralAssets.filter(
      (c) => !TOKEN_BLACKLIST.has(c.toLowerCase()),
    );
    const reserveResults = await multicall(this.paidReadPool.next(), {
      contracts: filteredCollaterals.map((collateral) => ({
        address: comet.address,
        abi: cometViewAbi,
        functionName: "getCollateralReserves" as const,
        args: [collateral] as const,
      })),
      allowFailure: true,
    });

    for (let i = 0; i < reserveResults.length; i++) {
      const result = reserveResults[i]!;
      if (result.status !== "success" || result.result <= 0n) continue;
      const collateral = filteredCollaterals[i]!;
      encoder.cometBuyCollateral(comet.address, collateral, 0n, maxUint256);
    }

    // DEX swap collateral → base asset
    for (const collateral of collateralAssets) {
      if (TOKEN_BLACKLIST.has(collateral.toLowerCase())) continue;
      if (collateral.toLowerCase() === comet.baseAsset.toLowerCase()) continue;

      await convertCollateralToLoan(this.sharedDeps, collateral, comet.baseAsset, 0n, encoder);
    }

    // Skim profit
    encoder.erc20Skim(comet.baseAsset, this.treasuryAddress);

    const calls = encoder.flush();

    // Find primary collateral for cross-protocol tracking
    const primaryCollateral = collateralAssets.find(
      (c) =>
        !TOKEN_BLACKLIST.has(c.toLowerCase()) && c.toLowerCase() !== comet.baseAsset.toLowerCase(),
    );

    try {
      const success = await simulateAndExec(
        this.sharedDeps,
        encoder,
        calls,
        comet.baseAsset,
        false,
        undefined,
        undefined,
        primaryCollateral,
      );

      if (success) {
        this._liquidationsSucceeded++;
        if (primaryCollateral) {
          const collateralUsd =
            (await priceAsset(this.sharedDeps, primaryCollateral, maxUint256)) ?? 0;
          liquidationTracker.report({
            protocol: this.logTag,
            collateralToken: primaryCollateral,
            collateralAmount: 0n,
            collateralUsdEstimate: collateralUsd,
            timestamp: Date.now(),
          });
        }
        console.log(
          `${this.logTag}Liquidated ${account} on Comet ${comet.address.slice(0, 10)}...`,
        );
      } else {
        console.log(
          `${this.logTag}Skipped ${account} on Comet ${comet.address.slice(0, 10)}... (not profitable)`,
        );
      }
    } catch (error) {
      this._liquidationsFailed++;
      this._lastError = String(error);
      console.error(
        `${this.logTag}Failed to liquidate ${account} on Comet ${comet.address.slice(0, 10)}...: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // ─── Helpers ───

  /**
   * Estimate a user's debt in a Comet by reading userBasic and computing borrow balance.
   * Returns the estimated debt amount in base asset units.
   */
  private async estimateDebt(comet: Address, account: Address): Promise<bigint> {
    try {
      const [userBasic, totalsBasic] = await Promise.all([
        readContract(this.client, {
          address: comet,
          abi: cometViewAbi,
          functionName: "userBasic",
          args: [account],
        }),
        readContract(this.client, {
          address: comet,
          abi: cometViewAbi,
          functionName: "totalsBasic",
        }),
      ]);

      const principal = userBasic[0]; // principal (int104)
      const baseBorrowIndex = totalsBasic[3]; // baseBorrowIndex

      // principal > 0 means supply, principal < 0 means borrow
      if (principal >= 0n) return 0n; // No debt

      // Borrow balance = |principal| * baseBorrowIndex / 1e15 (BASE_INDEX_SCALE)
      const absPrincipal = -principal;
      const borrowBalance = (absPrincipal * baseBorrowIndex) / 1_000_000_000_000_000n;

      return borrowBalance;
    } catch (e) {
      this._rpcErrors++;
      this._lastError = String(e);
      console.warn(
        `${this.logTag}Failed to estimate debt for ${account} on ${comet.slice(0, 10)}...: ${e instanceof Error ? e.message : e}`,
      );
      return 0n;
    }
  }

  /**
   * Get current bot health status for monitoring endpoints.
   */
  getHealthStatus() {
    const rpcErrorRate = this._rpcTotal > 0 ? this._rpcErrors / this._rpcTotal : 0;
    return {
      protocol: "comet" as const,
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
    };
  }
}
