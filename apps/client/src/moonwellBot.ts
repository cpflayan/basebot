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
import { PositionLiquidationCooldownMechanism } from "./utils/cooldownMechanisms.js";
import { LiquidationEncoder } from "./utils/LiquidationEncoder.js";
import { liquidationTracker } from "./utils/liquidationState.js";
import { createScanClient } from "./utils/rpcFallback.js";
import {
  type SharedExecutionDeps,
  TOKEN_BLACKLIST,
  convertCollateralToLoan,
  createBlockPolling,
  priceAsset,
  simulateAndExecFlashLoanWithFallback,
  simulateAndExec,
} from "./utils/sharedExecution.js";

/** mantissa 精度 (1e18) */
const MANTISSA = 10n ** 18n;

/** Simulation failure cooldown — skip accounts that repeatedly fail simulation */
const MAX_SIMULATION_FAILURES = 3;
const SIMULATION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export interface MoonwellLiquidationBotInputs {
  logTag: string;
  client: WalletClient<Transport, Chain, Account>;
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
  private sharedDeps: SharedExecutionDeps;
  /** Read-only client using Base public RPC — for historical event scanning only */
  private scanClient: Client<Transport, Chain>;

  /** Cached Comptroller params */
  private closeFactor = 0n;
  private liquidationIncentive = 0n;

  /** Cached mToken → reserveFactor (for pre-filtering unprofitable markets) */
  private reserveFactors = new Map<Address, bigint>();
  /** mTokens excluded due to RF >= 99% — almost all liquidation bonus goes to protocol reserves */
  private highRfMarkets = new Set<Address>();

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

    this.mTokenList = inputs.moonwellWatchlist.mTokens.map((m) => ({
      address: m.address,
      underlying: m.underlying,
      deployBlock: m.deployBlock,
    }));

    const registryPath =
      inputs.registryFilePath ?? `./data/moonwell-accounts.${inputs.chainId}.json`;
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

    console.log(
      `${this.logTag}🗄️ Moonwell registry initialized: ${this.registry.totalAccounts} total accounts across ${this.mTokenList.length} mTokens`,
    );
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
      this.liquidationIncentive = li;
      console.log(
        `${this.logTag}📋 Comptroller params: closeFactor=${Number(cf) / 1e18}, liquidationIncentive=${Number(li) / 1e18}`,
      );
    } catch (e) {
      this._rpcErrors += 2;
      this._lastError = String(e);
      // Fallback to standard Compound V2 defaults
      this.closeFactor = 5n * 10n ** 17n; // 0.5e18 = 50%
      this.liquidationIncentive = 11n * 10n ** 17n; // 1.1e18 = 10% bonus
      console.warn(
        `${this.logTag}⚠️ Failed to read Comptroller params, using defaults: closeFactor=50%, incentive=10%`,
        e,
      );
    }
  }

  /**
   * Cache reserveFactorMantissa for each mToken.
   * Markets with RF >= 99% send nearly all liquidation rewards to protocol reserves,
   * making them unprofitable for the bot. These are moved to highRfMarkets.
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
          `${this.logTag}⏭️ ${mToken.slice(0, 10)}... excluded (RF=${Number(rf) / 1e16}%) — nearly all rewards go to reserves`,
        );
      }
    }

    // Filter mTokenList to only active (profitable) markets
    const originalCount = this.mTokenList.length;
    this.mTokenList = this.mTokenList.filter((m) => !this.highRfMarkets.has(m.address));

    console.log(
      `${this.logTag}📊 Reserve factors: ${this.mTokenList.length}/${originalCount} markets active, ${this.highRfMarkets.size} excluded (RF≥99%)`,
    );
  }

  // ─── Polling loop ───

  /**
   * Start polling: check getAccountLiquidity on every N blocks.
   * Returns an unwatch function.
   */
  startPolling(): () => void {
    return createBlockPolling({
      logTag: this.logTag,
      client: this.client,
      pollIntervalBlocks: this.pollIntervalBlocks,
      onTick: () => this.checkAllMarkets(),
    });
  }

  /**
   * Core check loop: for each mToken, scan new events, then check getAccountLiquidity for all known accounts.
   */
  async checkAllMarkets(): Promise<void> {
    this._lastCheckTimestamp = Math.floor(Date.now() / 1000);

    // Incremental scan for new accounts across all mTokens
    for (const mToken of this.mTokenList) {
      try {
        await this.registry.scanNewEvents(this.client, mToken.address, this.logTag);
      } catch (e) {
        console.error(`${this.logTag}Error scanning mToken ${mToken.address.slice(0, 10)}...:`, e);
      }
    }

    // Detect oracle price updates — mark affected markets as "hot"
    await this.detectOracleUpdates();

    // Collect all unique accounts across all mTokens
    const allAccounts = new Set<string>();
    for (const mToken of this.mTokenList) {
      for (const account of this.registry.getAccounts(mToken.address)) {
        allAccounts.add(account.toLowerCase());
      }
    }

    if (allAccounts.size === 0) return;

    // Batch check getAccountLiquidity for all accounts
    const liquidatable = await this.batchCheckShortfall([...allAccounts] as Address[]);

    if (liquidatable.length === 0) return;

    // Sort: (1) hot market accounts first, (2) by shortfall descending
    liquidatable.sort((a, b) => {
      const aHot = this.isAccountInHotMarket(a.account) ? 0 : 1;
      const bHot = this.isAccountInHotMarket(b.account) ? 0 : 1;
      if (aHot !== bHot) return aHot - bHot;
      return b.shortfall > a.shortfall ? 1 : b.shortfall < a.shortfall ? -1 : 0;
    });

    const hotCount = liquidatable.filter((l) => this.isAccountInHotMarket(l.account)).length;
    console.log(
      `${this.logTag}🎯 ${liquidatable.length} liquidatable account(s) found! (${hotCount} in hot markets, sorted by priority)`,
    );

    for (const { account } of liquidatable) {
      await this.liquidateAccount(account);
    }
  }

  /**
   * Batch check getAccountLiquidity for multiple accounts.
   * Returns accounts with shortfall > 0, paired with their shortfall amount for sorting.
   */
  private async batchCheckShortfall(
    accounts: Address[],
  ): Promise<{ account: Address; shortfall: bigint }[]> {
    const BATCH_SIZE = 50;
    const liquidatable: { account: Address; shortfall: bigint }[] = [];

    for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
      const batch = accounts.slice(i, i + BATCH_SIZE);
      try {
        this._rpcTotal += batch.length;
        const results = await multicall(this.client, {
          contracts: batch.map((account) => ({
            address: this.comptroller,
            abi: comptrollerAbi,
            functionName: "getAccountLiquidity" as const,
            args: [account] as const,
          })),
          allowFailure: true,
        });

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
      } catch (e) {
        this._rpcErrors += batch.length;
        this._lastError = String(e);
        console.warn(`${this.logTag}⚠️ batchCheckShortfall batch ${i / BATCH_SIZE} failed:`, e);
      }
    }

    return liquidatable;
  }

  // ─── Liquidation execution ───

  private async liquidateAccount(account: Address): Promise<void> {
    // Cooldown check (use comptroller address as "market" key)
    if (this.cooldown && !this.cooldown.isPositionReady(this.comptroller, account)) {
      return;
    }

    // Simulation failure cooldown — skip accounts that repeatedly fail simulation
    const accountKey = account.toLowerCase();
    const cooldownExpiry = this.simulationCooldowns.get(accountKey);
    if (cooldownExpiry && Date.now() < cooldownExpiry) {
      return; // Still in cooldown, skip silently
    }
    // Cooldown expired, clear it
    if (cooldownExpiry) {
      this.simulationCooldowns.delete(accountKey);
      this.simulationFailures.set(accountKey, 0);
    }

    console.log(`${this.logTag}  🎯 ${account} — attempting Moonwell liquidation`);

    this._liquidationsAttempted++;

    // Find all borrow positions, sorted by balance descending
    const borrowPositions = await this.findAllBorrowPositions(account);

    if (borrowPositions.length === 0) {
      console.log(`${this.logTag}  ${account} — no borrow positions found, skipping`);
      return;
    }

    // Find best collateral (largest mToken balance)
    const collateralMToken = await this.findBestCollateral(account);
    if (!collateralMToken) {
      console.log(`${this.logTag}  ${account} — no collateral found, skipping`);
      return;
    }
    const collateralUnderlying = this.getUnderlying(collateralMToken);

    // SECURITY: Skip if collateral is blacklisted
    if (TOKEN_BLACKLIST.has(collateralUnderlying.toLowerCase())) {
      console.log(`${this.logTag}  ⛔ Skip ${account}: blacklisted collateral`);
      return;
    }

    // Try each borrow position (sorted by balance) until one succeeds
    for (const { borrowMToken, borrowBalance } of borrowPositions) {
      const borrowUnderlying = this.getUnderlying(borrowMToken);

      // Skip blacklisted borrow tokens
      if (TOKEN_BLACKLIST.has(borrowUnderlying.toLowerCase())) {
        continue;
      }

      // Skip if borrow and collateral are the same market (can't seize what you owe)
      if (borrowMToken.toLowerCase() === collateralMToken.toLowerCase()) {
        continue;
      }

      const maxRepay = (borrowBalance * this.closeFactor) / MANTISSA;
      if (maxRepay === 0n) continue;

      try {
        if (this.useFlashLoan) {
          await this.liquidateWithFlashLoan(
            account,
            borrowMToken,
            collateralMToken,
            borrowUnderlying,
            collateralUnderlying,
            maxRepay,
          );
        } else {
          await this.liquidateDirect(
            account,
            borrowMToken,
            collateralMToken,
            borrowUnderlying,
            collateralUnderlying,
            maxRepay,
          );
        }
        // Success — reset failure counter and stop trying other borrow positions
        this.simulationFailures.set(accountKey, 0);
        this._liquidationsSucceeded++;
        return;
      } catch (error) {
        console.warn(
          `${this.logTag}  ⚠️ Liquidation via ${borrowMToken.slice(0, 10)}... failed, trying next borrow...`,
          error,
        );
      }
    }

    // All borrow positions exhausted — record failure
    this._liquidationsFailed++;
    this._lastError = "all borrow positions exhausted";
    const failures = (this.simulationFailures.get(accountKey) ?? 0) + 1;
    this.simulationFailures.set(accountKey, failures);

    if (failures >= MAX_SIMULATION_FAILURES) {
      const cooldownUntil = Date.now() + SIMULATION_COOLDOWN_MS;
      this.simulationCooldowns.set(accountKey, cooldownUntil);
      console.warn(
        `${this.logTag}  ⏸️ ${account} — ${failures} consecutive simulation failures, cooling down for ${SIMULATION_COOLDOWN_MS / 1000}s`,
      );
    }

    console.log(`${this.logTag}  ${account} — all borrow positions exhausted, skipping`);
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
  private async liquidateWithFlashLoan(
    account: Address,
    borrowMToken: Address,
    collateralMToken: Address,
    borrowUnderlying: Address,
    collateralUnderlying: Address,
    repayAmount: bigint,
  ): Promise<void> {
    const callbackEncoder = new LiquidationEncoder(this.executorAddress, this.client);

    // Step 1: Approve borrow mToken to spend flash loan funds — only if needed
    const currentAllowance = await readContract(this.client, {
      address: borrowUnderlying,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.executorAddress, borrowMToken],
    });
    if (currentAllowance < repayAmount) {
      callbackEncoder.erc20Approve(borrowUnderlying, borrowMToken, maxUint256);
    }

    // Step 2: liquidateBorrow — repay debt, seize collateral mToken
    callbackEncoder.moonwellLiquidateBorrow(borrowMToken, collateralMToken, account, repayAmount);

    // Step 3: redeem — convert seized mToken to underlying
    // Use redeem(maxUint256) to burn ALL seized mTokens. Do NOT use redeemUnderlying(0)
    // — in Compound V2, redeemUnderlying(0) is a no-op (redeems 0 underlying tokens).
    callbackEncoder.moonwellRedeem(collateralMToken, maxUint256);

    // Step 4: DEX swap collateral underlying → borrow underlying (if different tokens)
    if (collateralUnderlying.toLowerCase() !== borrowUnderlying.toLowerCase()) {
      await convertCollateralToLoan(
        this.sharedDeps,
        collateralUnderlying,
        borrowUnderlying,
        0n, // amount determined at runtime by executor balance
        callbackEncoder,
      );
    }

    // Step 5: Skim profit to treasury
    callbackEncoder.erc20Skim(borrowUnderlying, this.treasuryAddress);

    const callbackCalls = callbackEncoder.flush();

    try {
      const success = await simulateAndExecFlashLoanWithFallback(
        this.sharedDeps,
        callbackCalls,
        borrowUnderlying,
        false,
        repayAmount,
        collateralUnderlying,
      );

      if (success) {
        const collateralUsd =
          (await priceAsset(this.sharedDeps, collateralUnderlying, repayAmount)) ?? 0;
        liquidationTracker.report({
          protocol: this.logTag,
          collateralToken: collateralUnderlying,
          collateralAmount: repayAmount,
          collateralUsdEstimate: collateralUsd,
          timestamp: Date.now(),
        });
        console.log(
          `${this.logTag}[FlashLoan] Liquidated ${account} via ${borrowMToken.slice(0, 10)}... (repay=${repayAmount})`,
        );
      } else {
        console.log(`${this.logTag}[FlashLoan] Skipped ${account} (not profitable)`);
      }
    } catch (error) {
      console.error(`${this.logTag}[FlashLoan] Failed to liquidate ${account}:`, error);
    }
  }

  /**
   * Direct liquidation path (no flash loan — requires pre-funded underlying).
   */
  private async liquidateDirect(
    account: Address,
    borrowMToken: Address,
    collateralMToken: Address,
    borrowUnderlying: Address,
    collateralUnderlying: Address,
    repayAmount: bigint,
  ): Promise<void> {
    const encoder = new LiquidationEncoder(this.executorAddress, this.client);

    // Approve borrow mToken — only if allowance insufficient
    const currentAllowance = await readContract(this.client, {
      address: borrowUnderlying,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.executorAddress, borrowMToken],
    });
    if (currentAllowance < repayAmount) {
      encoder.erc20Approve(borrowUnderlying, borrowMToken, maxUint256);
    }

    // liquidateBorrow
    encoder.moonwellLiquidateBorrow(borrowMToken, collateralMToken, account, repayAmount);

    // redeem — convert seized mToken to underlying
    encoder.moonwellRedeem(collateralMToken, maxUint256);

    // DEX swap collateral underlying → borrow underlying (if different tokens)
    if (collateralUnderlying.toLowerCase() !== borrowUnderlying.toLowerCase()) {
      await convertCollateralToLoan(
        this.sharedDeps,
        collateralUnderlying,
        borrowUnderlying,
        0n,
        encoder,
      );
    }

    // Skim profit
    encoder.erc20Skim(borrowUnderlying, this.treasuryAddress);

    const calls = encoder.flush();

    try {
      const success = await simulateAndExec(
        this.sharedDeps,
        encoder,
        calls,
        borrowUnderlying,
        false,
        undefined,
        undefined,
        collateralUnderlying,
      );

      if (success) {
        const collateralUsd =
          (await priceAsset(this.sharedDeps, collateralUnderlying, repayAmount)) ?? 0;
        liquidationTracker.report({
          protocol: this.logTag,
          collateralToken: collateralUnderlying,
          collateralAmount: repayAmount,
          collateralUsdEstimate: collateralUsd,
          timestamp: Date.now(),
        });
        console.log(
          `${this.logTag}Liquidated ${account} via ${borrowMToken.slice(0, 10)}... (repay=${repayAmount})`,
        );
      } else {
        console.log(`${this.logTag}Skipped ${account} (not profitable)`);
      }
    } catch (error) {
      console.error(`${this.logTag}Failed to liquidate ${account}:`, error);
    }
  }

  // ─── Helpers ───

  /**
   * Find ALL borrow positions for an account, sorted by balance descending.
   * Returns array of { borrowMToken, borrowBalance } — caller tries each until one succeeds.
   */
  private async findAllBorrowPositions(
    account: Address,
  ): Promise<{ borrowMToken: Address; borrowBalance: bigint }[]> {
    try {
      this._rpcTotal += this.mTokenList.length;
      const results = await multicall(this.client, {
        contracts: this.mTokenList.map((mToken) => ({
          address: mToken.address,
          abi: mTokenAbi,
          functionName: "borrowBalanceStored" as const,
          args: [account] as const,
        })),
        allowFailure: true,
      });

      return results
        .map((r, i) => {
          if (r.status !== "success") {
            this._rpcErrors++;
            return null;
          }
          const borrowBalance = r.result;
          return borrowBalance > 0n
            ? { borrowMToken: this.mTokenList[i]!.address, borrowBalance }
            : null;
        })
        .filter((r): r is { borrowMToken: Address; borrowBalance: bigint } => r !== null)
        .sort((a, b) =>
          b.borrowBalance > a.borrowBalance ? 1 : b.borrowBalance < a.borrowBalance ? -1 : 0,
        );
    } catch (e) {
      this._rpcErrors += this.mTokenList.length;
      this._lastError = String(e);
      console.warn(`${this.logTag}⚠️ findAllBorrowPositions multicall failed:`, e);
      return [];
    }
  }

  /**
   * Find the best collateral mToken (largest balance) for an account.
   */
  private async findBestCollateral(account: Address): Promise<Address | null> {
    let bestMToken: Address | null = null;
    let maxBalance = 0n;

    try {
      this._rpcTotal += this.mTokenList.length;
      const results = await multicall(this.client, {
        contracts: this.mTokenList.map((mToken) => ({
          address: mToken.address,
          abi: mTokenAbi,
          functionName: "balanceOf" as const,
          args: [account] as const,
        })),
        allowFailure: true,
      });

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        if (result.status !== "success") {
          this._rpcErrors++;
          continue;
        }
        if (result.result > maxBalance) {
          maxBalance = result.result;
          bestMToken = this.mTokenList[i]!.address;
        }
      }
    } catch (e) {
      this._rpcErrors += this.mTokenList.length;
      this._lastError = String(e);
      console.warn(`${this.logTag}⚠️ findBestCollateral multicall failed:`, e);
    }

    return bestMToken;
  }

  /**
   * Check if an account has a position in any hot market.
   */
  private isAccountInHotMarket(account: Address): boolean {
    if (this.hotMarkets.size === 0) return false;
    const lowerAccount = account.toLowerCase();
    // An account is "hot" if it has any position (borrow or collateral) in a hot market
    for (const hotMToken of this.hotMarkets) {
      const accounts = this.registry.getAccounts(hotMToken);
      if (accounts.some((a) => a.toLowerCase() === lowerAccount)) return true;
    }
    return false;
  }

  /**
   * Initialize oracle timestamp tracking for all active markets.
   * Records baseline exchange rates for detecting changes in subsequent checks.
   */
  private async initOracleTimestamps(): Promise<void> {
    try {
      const results = await multicall(this.client, {
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
      console.warn(`${this.logTag}⚠️ initOracleTimestamps multicall failed:`, e);
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
      const results = await multicall(this.client, {
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
      console.warn(`${this.logTag}⚠️ detectOracleUpdates multicall failed:`, e);
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
    };
  }
}
