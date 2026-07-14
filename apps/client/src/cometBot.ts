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

/** Dust debt that cannot cover swap minOut + gas (base-asset units). */
function isCometDustDebt(amount: bigint, baseAsset: Address): boolean {
  if (amount === 0n) return true;
  const t = baseAsset.toLowerCase();
  // USDC / USDbC (6 decimals): skip under $0.01
  if (
    t === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" ||
    t === "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca"
  ) {
    return amount < 10_000n;
  }
  // WETH / AERO / other 18-dec: skip under 1e12 wei
  return amount < 10n ** 12n;
}

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
  private hfBatchSize: number;
  private hfConcurrency: number;
  private sharedDeps: SharedExecutionDeps;
  /** Read-only client using Base public RPC — for historical event scanning only */
  private scanClient: Client<Transport, Chain>;
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
    this.hfBatchSize = defaultHfBatchSize(100);
    this.hfConcurrency = defaultHfConcurrency(inputs.paidReadPool.size);

    this.cometList = inputs.cometWatchlist.comets.map(
      (c: { address: Address; baseAsset: Address; deployBlock: number }) => ({
        address: c.address,
        baseAsset: c.baseAsset,
        deployBlock: c.deployBlock,
      }),
    );

    ensureRegistryDataDir();
    const registryPath =
      inputs.registryFilePath ??
      resolveAccountRegistryPath(`comet-accounts.${inputs.chainId}.json`);
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

    await this.warmDexRoutes();

    console.log(
      `${this.logTag}🗄️ Comet registry initialized: ${this.registry.totalAccounts} total accounts across ${this.cometList.length} Comets`,
    );
  }

  /** Prefill DEX route cache: each Comet base × collateral (and reverse). */
  private async warmDexRoutes(): Promise<void> {
    if (!shouldWarmRoutes()) {
      console.log(`${this.logTag}🔥 DEX warm skipped (SKIP_ROUTE_WARM=1)`);
      return;
    }
    const pairs: { src: Address; dst: Address }[] = [];
    const seen = new Set<string>();
    for (const comet of this.cometList) {
      const baseAsset = comet.baseAsset;
      for (const coll of comet.collateralAssets ?? []) {
        if (coll.toLowerCase() === baseAsset.toLowerCase()) continue;
        // One direction only (coll→base) — enough for liq path, half the warm RPC
        const src = coll;
        const dst = baseAsset;
        const key = `${src.toLowerCase()}->${dst.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ src, dst });
      }
    }
    if (pairs.length === 0) return;
    console.log(`${this.logTag}🔥 Warming ${pairs.length} Comet DEX routes (prefer local AMM)…`);
    try {
      await warmVenueRouteCache(this.sharedDeps, pairs);
    } catch (e) {
      console.warn(
        `${this.logTag}⚠️ DEX warm failed (non-fatal): ${e instanceof Error ? e.message : e}`,
      );
    }
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
    // phase=0 → blocks 5,10,15… (stagger vs Moonwell phase=2)
    bus.register(this.pollIntervalBlocks, () => this.checkAllComets(), this.logTag, 0);
    console.log(
      `${this.logTag}⚡ Race mode: poll every ${this.pollIntervalBlocks} block(s) phase=0, ` +
        `batch=${this.hfBatchSize} concurrency=${this.hfConcurrency} waveGap=${rpcWaveGapMs()}ms`,
    );
  }

  /**
   * Core check loop: for each Comet, scan new events, then check isLiquidatable for all known accounts.
   */
  async checkAllComets(): Promise<void> {
    this._lastCheckTimestamp = Math.floor(Date.now() / 1000);

    for (const comet of this.cometList) {
      try {
        await this.registry.scanNewEvents(this.scanClient, comet.address, this.logTag);

        const accounts = this.registry.getAccounts(comet.address);
        if (accounts.length === 0) {
          this.raceMetrics.onTick({
            logTag: this.logTag,
            mode: "full",
            accounts: 0,
            liquidatable: 0,
            hfScanMs: 0,
          });
          continue;
        }

        const t0 = nowMs();
        const liquidatable = await this.batchCheckLiquidatable(comet.address, accounts);
        const scanMs = elapsedMs(t0);

        this.raceMetrics.onTick({
          logTag: this.logTag,
          mode: "full",
          accounts: accounts.length,
          liquidatable: liquidatable.length,
          hfScanMs: scanMs,
        });

        if (liquidatable.length === 0) continue;

        console.log(
          `${this.logTag}🎯 ${comet.address.slice(0, 10)}... — ${liquidatable.length} liquidatable ` +
            `(scan ${accounts.length} in ${scanMs}ms)`,
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
   * Parallel-sharded multicall of isLiquidatable across paidReadPool.
   */
  private async batchCheckLiquidatable(comet: Address, accounts: Address[]): Promise<Address[]> {
    const batchSize = Math.max(10, this.hfBatchSize);
    const concurrency = Math.max(
      1,
      Math.min(this.hfConcurrency, Math.max(1, this.paidReadPool.size)),
    );
    const liquidatable: Address[] = [];

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
                address: comet,
                abi: cometViewAbi,
                functionName: "isLiquidatable" as const,
                args: [account] as const,
              })),
              allowFailure: true,
            });
            this.paidReadPool.recordSuccess(label);
            this._rpcTotal += 1;
            return { batch, results, ok: true as const };
          } catch (e) {
            this.paidReadPool.recordFailure(label);
            this._rpcErrors += 1;
            this._rpcTotal += 1;
            this._lastError = String(e);
            console.warn(
              `${this.logTag}⚠️ isLiquidatable multicall failed on ${label}: ${e instanceof Error ? e.message : e}`,
            );
            return { batch, results: null, ok: false as const };
          }
        }),
      );

      for (const { batch, results, ok } of waveResults) {
        if (!ok || !results) continue;
        for (let j = 0; j < results.length; j++) {
          const result = results[j]!;
          if (result.status !== "success") continue;
          // Single bool return (not a tuple) — see cometViewAbi.isLiquidatable
          if (result.result) liquidatable.push(batch[j]!);
        }
      }
    }

    return liquidatable;
  }

  // ─── Liquidation execution ───

  private async liquidateComet(comet: CometInfo, account: Address): Promise<void> {
    const tTotal = nowMs();

    // SECURITY: Skip blacklisted tokens
    if (TOKEN_BLACKLIST.has(comet.baseAsset.toLowerCase())) {
      this.raceMetrics.recordOutcome("skip_blacklist");
      logLiquidationDebug({
        protocol: this.logTag,
        account,
        decision: "skip",
        reason: "Blacklisted base asset",
        details: {
          cometAddress: comet.address,
          baseAsset: comet.baseAsset,
          note: "Base asset is in TOKEN_BLACKLIST",
        },
      });
      return;
    }

    // Peek only — arm after real attempt
    if (this.cooldown?.isCoolingDown(comet.address, account)) {
      this.raceMetrics.recordOutcome("skip_cooldown");
      logLiquidationDebug({
        protocol: this.logTag,
        account,
        decision: "skip",
        reason: "Position is in cooldown period",
        details: {
          cometAddress: comet.address,
          note: "Recently attempted liquidation, waiting before retry",
        },
      });
      return;
    }

    logLiquidationDebug({
      protocol: this.logTag,
      account,
      decision: "liquidate",
      reason: "Comet liquidation check passed, attempting liquidation",
      details: {
        cometAddress: comet.address,
        baseAsset: comet.baseAsset,
        useFlashLoan: this.useFlashLoan,
        note: "Proceeding to estimate debt and execute liquidation",
      },
    });

    console.log(`${this.logTag}  🎯 ${account} — attempting Comet liquidation`);

    this._liquidationsAttempted++;

    if (this.useFlashLoan) {
      await this.liquidateCometWithFlashLoan(comet, account);
    } else {
      await this.liquidateCometDirect(comet, account);
    }
    this.raceMetrics.recordStage("totalLiq", elapsedMs(tTotal));
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
      // Race / already repaid — short cooldown so we don't re-poll every block
      this.armCooldown(comet.address, account, "race", "no debt", "fail_race");
      console.log(`${this.logTag}  ${account} has no debt, skipping (race cooldown)`);
      return;
    }

    // Dust debt → swap minOut (InsufficientOutputAmount) always fails; soft cooldown
    if (isCometDustDebt(flashLoanAmount, comet.baseAsset)) {
      this.armCooldown(
        comet.address,
        account,
        "soft",
        `dust debt flashLoanAmount=${flashLoanAmount}`,
        "fail_soft_profit",
      );
      console.log(
        `${this.logTag}  ${account} dust debt (${flashLoanAmount} base units) — skip flash loan`,
      );
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
    // Post-absorb reserves ≈ currentReserves + userCollateral (user collateral
    // only enters protocol reserves AFTER absorb). Reading only pre-absorb
    // reserves would skip accounts whose assets are not yet in the pool.
    const filteredCollaterals = collateralAssets.filter(
      (c) => !TOKEN_BLACKLIST.has(c.toLowerCase()),
    );
    const [reserveResults, userCollateralResults] = await Promise.all([
      multicall(this.paidReadPool.next(), {
        contracts: filteredCollaterals.map((collateral) => ({
          address: comet.address,
          abi: cometViewAbi,
          functionName: "getCollateralReserves" as const,
          args: [collateral] as const,
        })),
        allowFailure: true,
      }),
      multicall(this.paidReadPool.next(), {
        contracts: filteredCollaterals.map((collateral) => ({
          address: comet.address,
          abi: cometViewAbi,
          functionName: "userCollateral" as const,
          args: [account, collateral] as const,
        })),
        allowFailure: true,
      }),
    ]);

    // BUGFIX: 之前每一種 collateral 都把 flashLoanAmount(全部閃電貸金額)當作各自的
    // spend cap 傳給 buyCollateral。Compound III 的 buyCollateral 會真的把 baseAmount
    // 全部從呼叫者扣走(不會自動按比例縮減),所以只要帳戶有 2 種以上 collateral 且第一種
    // 的協議儲備量夠大,第一筆呼叫就會花光所有 flash-borrowed 的 base asset,
    // 第二筆呼叫的 transferFrom 會失敗 → 整筆交易 revert。
    // 現在改成:先用 USD 價值估算每種 collateral 儲備值多少 base asset,按比例分配
    // flashLoanAmount 的預算,並確保所有 buyCollateral 呼叫加總不超過 flashLoanAmount。
    const candidates: { collateral: Address; reserveAmount: bigint }[] = [];
    for (let i = 0; i < filteredCollaterals.length; i++) {
      const reserveResult = reserveResults[i]!;
      const userResult = userCollateralResults[i]!;
      const currentReserves =
        reserveResult.status === "success" && reserveResult.result > 0n ? reserveResult.result : 0n;
      // userCollateral returns [balance, reserved]
      const userBal =
        userResult.status === "success" && userResult.result ? userResult.result[0] : 0n;
      const expectedReserves = currentReserves + userBal;
      if (expectedReserves <= 0n) continue;
      candidates.push({
        collateral: filteredCollaterals[i]!,
        reserveAmount: expectedReserves,
      });
    }

    const [flashLoanValueUsd, ...reserveValuesUsd] = await Promise.all([
      priceAsset(this.sharedDeps, comet.baseAsset, flashLoanAmount),
      ...candidates.map(({ collateral, reserveAmount }) =>
        priceAsset(this.sharedDeps, collateral, reserveAmount),
      ),
    ]);

    let remainingBudget = flashLoanAmount;
    // Tracks how much of each collateral buyCollateral is expected to hand back, so the
    // Step 4 swap below can be given a real amount instead of a literal 0.
    const expectedCollateralOut = new Map<Address, bigint>();
    const buyPlans: { collateral: Address; reserveAmount: bigint; baseAmount: bigint }[] = [];

    // Pre-scale USD to micro-USD integers for bigint budget math (avoid float ratio)
    const flashUsdScaled =
      flashLoanValueUsd !== undefined && flashLoanValueUsd > 0
        ? BigInt(Math.floor(flashLoanValueUsd * 1e6))
        : 0n;

    for (let i = 0; i < candidates.length; i++) {
      if (remainingBudget <= 0n) break;
      const { collateral, reserveAmount } = candidates[i]!;
      const reserveValueUsd = reserveValuesUsd[i];

      let baseAmountForThisCollateral = remainingBudget;
      if (flashUsdScaled > 0n && reserveValueUsd !== undefined && reserveValueUsd > 0) {
        const reserveUsdScaled = BigInt(Math.floor(reserveValueUsd * 1e6));
        // 95% safety margin so price micro-errors don't overspend budget
        const proportional =
          (flashLoanAmount * reserveUsdScaled * 9500n) / (flashUsdScaled * 10000n);
        if (proportional > 0n && proportional < remainingBudget) {
          baseAmountForThisCollateral = proportional;
        }
      }
      if (baseAmountForThisCollateral <= 0n) continue;
      if (baseAmountForThisCollateral > remainingBudget) {
        baseAmountForThisCollateral = remainingBudget;
      }

      buyPlans.push({
        collateral,
        reserveAmount,
        baseAmount: baseAmountForThisCollateral,
      });
      remainingBudget -= baseAmountForThisCollateral;
    }

    // Batch quoteCollateral for all planned buys (1 multicall instead of N RPCs)
    if (buyPlans.length > 0) {
      const quoteResults = await multicall(this.paidReadPool.next(), {
        contracts: buyPlans.map(({ collateral, baseAmount }) => ({
          address: comet.address,
          abi: cometViewAbi,
          functionName: "quoteCollateral" as const,
          args: [collateral, baseAmount] as const,
        })),
        allowFailure: true,
      });

      for (let i = 0; i < buyPlans.length; i++) {
        const plan = buyPlans[i]!;
        const quoteResult = quoteResults[i]!;
        let quotedOut = 0n;
        if (quoteResult.status === "success") {
          quotedOut = quoteResult.result;
        } else {
          console.warn(
            `${this.logTag}⚠️ quoteCollateral failed for ${plan.collateral.slice(0, 10)}...`,
          );
        }
        // buyCollateral can never return more than what's actually in reserve
        if (quotedOut > plan.reserveAmount) quotedOut = plan.reserveAmount;
        expectedCollateralOut.set(plan.collateral, quotedOut);

        callbackEncoder.cometBuyCollateral(
          comet.address,
          plan.collateral,
          0n, // minAmount = 0 (we rely on simulation for safety)
          plan.baseAmount,
        );
      }
    }

    // Step 4: DEX swap any non-base collateral → base asset (local AMM first)
    let anySwapOk = false;
    let venueImpactBps: bigint | undefined;
    let swapsAttempted = 0;
    for (const collateral of collateralAssets) {
      if (TOKEN_BLACKLIST.has(collateral.toLowerCase())) continue;
      if (collateral.toLowerCase() === comet.baseAsset.toLowerCase()) continue;

      const expectedAmount = expectedCollateralOut.get(collateral) ?? 0n;
      if (expectedAmount === 0n) continue;

      swapsAttempted += 1;
      const swap = await convertCollateralToLoan(
        this.sharedDeps,
        collateral,
        comet.baseAsset,
        expectedAmount,
        callbackEncoder,
        { preferLocalDex: true },
      );
      this.recordConvertMetrics(swap);
      if (swap.success) {
        anySwapOk = true;
        if (swap.impactBps !== undefined) {
          venueImpactBps =
            venueImpactBps === undefined || swap.impactBps > venueImpactBps
              ? swap.impactBps
              : venueImpactBps;
        }
      }
    }

    if (swapsAttempted > 0 && !anySwapOk) {
      this._liquidationsFailed++;
      this.armCooldown(comet.address, account, "soft", "no DEX route", "skip_no_route");
      console.log(
        `${this.logTag}No DEX route for Comet collaterals → ${comet.baseAsset.slice(0, 10)}…, skip flash`,
      );
      return;
    }

    // Do NOT erc20Skim before flash repay (appended after callbacks).
    const callbackCalls = callbackEncoder.flush();

    const primaryCollateral = collateralAssets.find(
      (c) =>
        !TOKEN_BLACKLIST.has(c.toLowerCase()) && c.toLowerCase() !== comet.baseAsset.toLowerCase(),
    );

    // Step 7: flash loan sim + exec
    try {
      const tSim = nowMs();
      const execResult = await simulateAndExecFlashLoanWithFallback(
        this.sharedDeps,
        callbackCalls,
        comet.baseAsset,
        false,
        flashLoanAmount,
        primaryCollateral,
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
        this._liquidationsSucceeded++;
        this.armCooldown(comet.address, account, "success");
        if (primaryCollateral) {
          const seizedAmount = expectedCollateralOut.get(primaryCollateral) ?? 0n;
          const collateralUsd =
            seizedAmount > 0n
              ? ((await priceAsset(this.sharedDeps, primaryCollateral, seizedAmount)) ?? 0)
              : 0;
          liquidationTracker.report({
            protocol: this.logTag,
            collateralToken: primaryCollateral,
            collateralAmount: seizedAmount,
            collateralUsdEstimate: collateralUsd,
            timestamp: Date.now(),
          });
        }
        console.log(
          `${this.logTag}[FlashLoan] Liquidated ${account} on Comet ${comet.address.slice(0, 10)}...`,
        );
      } else {
        this._liquidationsFailed++;
        const why = execResult.reason ?? "sim_or_profit_fail";
        this.armCooldown(comet.address, account, "soft", why);
        console.log(
          `${this.logTag}[FlashLoan] Skipped ${account} on Comet ${comet.address.slice(0, 10)}... (${why})`,
        );
      }
    } catch (error) {
      this._liquidationsFailed++;
      this._lastError = String(error);
      this.armCooldownFromError(comet.address, account, error);
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

    // Approve Comet when allowance may be insufficient for buyCollateral pulls
    const currentAllowance = await readContract(this.client, {
      address: comet.baseAsset,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.executorAddress, comet.address],
    });
    // maxUint256 approve when any shortfall is possible (not only zero)
    if (currentAllowance < maxUint256 / 2n) {
      encoder.erc20Approve(comet.baseAsset, comet.address, maxUint256);
    }

    // Absorb
    encoder.cometAbsorb(comet.address, [account]);

    // Buy collateral — post-absorb expected reserves = current + userCollateral
    const filteredCollaterals = collateralAssets.filter(
      (c) => !TOKEN_BLACKLIST.has(c.toLowerCase()),
    );
    const [reserveResults, userCollateralResults] = await Promise.all([
      multicall(this.paidReadPool.next(), {
        contracts: filteredCollaterals.map((collateral) => ({
          address: comet.address,
          abi: cometViewAbi,
          functionName: "getCollateralReserves" as const,
          args: [collateral] as const,
        })),
        allowFailure: true,
      }),
      multicall(this.paidReadPool.next(), {
        contracts: filteredCollaterals.map((collateral) => ({
          address: comet.address,
          abi: cometViewAbi,
          functionName: "userCollateral" as const,
          args: [account, collateral] as const,
        })),
        allowFailure: true,
      }),
    ]);

    // buyCollateral with unbounded base budget pulls available reserve for each collateral.
    const expectedCollateralOut = new Map<Address, bigint>();

    for (let i = 0; i < filteredCollaterals.length; i++) {
      const reserveResult = reserveResults[i]!;
      const userResult = userCollateralResults[i]!;
      const currentReserves =
        reserveResult.status === "success" && reserveResult.result > 0n ? reserveResult.result : 0n;
      const userBal =
        userResult.status === "success" && userResult.result ? userResult.result[0] : 0n;
      const expectedReserves = currentReserves + userBal;
      if (expectedReserves <= 0n) continue;
      const collateral = filteredCollaterals[i]!;
      expectedCollateralOut.set(collateral, expectedReserves);
      encoder.cometBuyCollateral(comet.address, collateral, 0n, maxUint256);
    }

    // DEX swap collateral → base asset (local AMM first)
    let anySwapOk = false;
    let swapsAttempted = 0;
    for (const collateral of collateralAssets) {
      if (TOKEN_BLACKLIST.has(collateral.toLowerCase())) continue;
      if (collateral.toLowerCase() === comet.baseAsset.toLowerCase()) continue;

      const expectedAmount = expectedCollateralOut.get(collateral) ?? 0n;
      if (expectedAmount === 0n) continue;

      swapsAttempted += 1;
      const swap = await convertCollateralToLoan(
        this.sharedDeps,
        collateral,
        comet.baseAsset,
        expectedAmount,
        encoder,
        { preferLocalDex: true },
      );
      this.recordConvertMetrics(swap);
      if (swap.success) anySwapOk = true;
    }

    if (swapsAttempted > 0 && !anySwapOk) {
      this._liquidationsFailed++;
      this.armCooldown(comet.address, account, "soft", "no DEX route", "skip_no_route");
      console.log(
        `${this.logTag}No DEX route for Comet collaterals → ${comet.baseAsset.slice(0, 10)}…, skip direct`,
      );
      return;
    }

    // Skim profit
    encoder.erc20Skim(comet.baseAsset, this.treasuryAddress);

    const calls = encoder.flush();

    const primaryCollateral = collateralAssets.find(
      (c) =>
        !TOKEN_BLACKLIST.has(c.toLowerCase()) && c.toLowerCase() !== comet.baseAsset.toLowerCase(),
    );

    try {
      const tSim = nowMs();
      const execResult = await simulateAndExec(
        this.sharedDeps,
        encoder,
        calls,
        comet.baseAsset,
        false,
        undefined,
        undefined,
        primaryCollateral,
      );
      const simMs = elapsedMs(tSim);
      this.raceMetrics.recordStage("simExec", simMs);
      console.log(
        `${this.logTag}[LiqTiming] direct account=${account.slice(0, 10)}… simExecMs=${simMs} ok=${execResult.success}` +
          (execResult.reason ? ` reason=${execResult.reason}` : ""),
      );

      if (execResult.success) {
        this._liquidationsSucceeded++;
        this.armCooldown(comet.address, account, "success");
        if (primaryCollateral) {
          const seizedAmount = expectedCollateralOut.get(primaryCollateral) ?? 0n;
          const collateralUsd =
            seizedAmount > 0n
              ? ((await priceAsset(this.sharedDeps, primaryCollateral, seizedAmount)) ?? 0)
              : 0;
          liquidationTracker.report({
            protocol: this.logTag,
            collateralToken: primaryCollateral,
            collateralAmount: seizedAmount,
            collateralUsdEstimate: collateralUsd,
            timestamp: Date.now(),
          });
        }
        console.log(
          `${this.logTag}Liquidated ${account} on Comet ${comet.address.slice(0, 10)}...`,
        );
      } else {
        this._liquidationsFailed++;
        const why = execResult.reason ?? "sim_or_profit_fail";
        this.armCooldown(comet.address, account, "soft", why);
        console.log(
          `${this.logTag}Skipped ${account} on Comet ${comet.address.slice(0, 10)}... (${why})`,
        );
      }
    } catch (error) {
      this._liquidationsFailed++;
      this._lastError = String(error);
      this.armCooldownFromError(comet.address, account, error);
      console.error(
        `${this.logTag}Failed to liquidate ${account} on Comet ${comet.address.slice(0, 10)}...: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // ─── Helpers ───

  private armCooldown(
    cometAddress: Address,
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
    const seconds = this.cooldown.markClass(cometAddress, account, cls);
    console.log(
      `${this.logTag}⏳ Cooldown ${cls} ${seconds}s for ${account.slice(0, 10)}…` +
        (detail ? ` (${detail.slice(0, 100)})` : ""),
    );
  }

  private armCooldownFromError(cometAddress: Address, account: Address, error: unknown): void {
    if (isLiquidationRaceLostError(error) || classifyLiquidationFailure(error) === "race") {
      this.armCooldown(
        cometAddress,
        account,
        "race",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const cls = classifyLiquidationFailure(error);
    this.armCooldown(
      cometAddress,
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

  /**
   * Estimate a user's debt in a Comet (base asset units).
   * Prefer on-chain borrowBalanceOf (accrued); fallback to principal × baseBorrowIndex.
   */
  private async estimateDebt(comet: Address, account: Address): Promise<bigint> {
    try {
      // Primary: protocol-computed borrow balance (matches fork tests / production accuracy)
      const direct = await readContract(this.client, {
        address: comet,
        abi: cometViewAbi,
        functionName: "borrowBalanceOf",
        args: [account],
      });
      return direct;
    } catch (primaryErr) {
      // Fallback: manual accrual from userBasic + totalsBasic (corrected ABI field order)
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
        // Official TotalsBasic: [0]=baseSupplyIndex, [1]=baseBorrowIndex, ...
        const baseBorrowIndex = totalsBasic[1];

        // principal > 0 means supply, principal < 0 means borrow
        if (principal >= 0n) return 0n;

        // Borrow balance = |principal| * baseBorrowIndex / 1e15 (BASE_INDEX_SCALE)
        const absPrincipal = -principal;
        return (absPrincipal * baseBorrowIndex) / 1_000_000_000_000_000n;
      } catch (e) {
        this._rpcErrors++;
        this._lastError = String(e);
        console.warn(
          `${this.logTag}Failed to estimate debt for ${account} on ${comet.slice(0, 10)}...: ${e instanceof Error ? e.message : e} (primary: ${primaryErr instanceof Error ? primaryErr.message : primaryErr})`,
        );
        return 0n;
      }
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
      raceMetrics: this.raceMetrics.snapshot(),
    };
  }
}
