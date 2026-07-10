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
import type { MoonwellWatchlistConfig } from "@morpho-blue-liquidation-bot/config";
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
import { readContract, watchBlocks } from "viem/actions";
import { base } from "viem/chains";

import { BALANCER_VAULT_ADDRESS } from "./abis/BalancerVault.js";
import { comptrollerAbi, mTokenAbi, MOONWELL_UNDERLYING_MAP } from "./abis/Moonwell.js";
import { MoonwellAccountRegistry } from "./moonwellAccountRegistry.js";
import { PositionLiquidationCooldownMechanism } from "./utils/cooldownMechanisms.js";
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
 * Token blacklist — skip markets involving these tokens.
 */
const TOKEN_BLACKLIST = new Set<string>([
  "0x35e5db674d8e93a03d814fa0ada70731efe8a4b9", // USR (depegged)
]);

/** mantissa 精度 (1e18) */
const MANTISSA = 10n ** 18n;

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
  flashLoanProvider?: "balancer" | "aave";
  alwaysRealizeBadDebt?: boolean;
  registryFilePath?: string;
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
  private flashLoanProvider: "balancer" | "aave";
  private alwaysRealizeBadDebt: boolean;
  private registry: MoonwellAccountRegistry;
  private pollIntervalBlocks: number;
  private sharedDeps: SharedExecutionDeps;
  /** Read-only client using Base public RPC — for historical event scanning only */
  private scanClient: Client<Transport, Chain>;

  /** Cached Comptroller params */
  private closeFactor = 0n;
  private liquidationIncentive = 0n;

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
    };

    // Read-only client on Base public RPC for historical scanning
    this.scanClient = createPublicClient({
      chain: base,
      transport: http(BASE_PUBLIC_RPC),
    });
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
   * Cache closeFactor and liquidationIncentive from Comptroller.
   */
  private async cacheComptrollerParams(): Promise<void> {
    try {
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
      // Fallback to standard Compound V2 defaults
      this.closeFactor = 5n * 10n ** 17n; // 0.5e18 = 50%
      this.liquidationIncentive = 11n * 10n ** 17n; // 1.1e18 = 10% bonus
      console.warn(
        `${this.logTag}⚠️ Failed to read Comptroller params, using defaults: closeFactor=50%, incentive=10%`,
        e,
      );
    }
  }

  // ─── Polling loop ───

  /**
   * Start polling: check getAccountLiquidity on every N blocks.
   * Returns an unwatch function.
   */
  startPolling(): () => void {
    let blockCount = 0;
    let running = false;

    const unwatch = watchBlocks(this.client, {
      onBlock: () => {
        blockCount++;
        if (blockCount % this.pollIntervalBlocks !== 0) return;
        if (running) return; // Prevent overlapping runs
        running = true;

        this.checkAllMarkets()
          .catch((e: unknown) => {
            console.error(`${this.logTag}Error in checkAllMarkets:`, e);
          })
          .finally(() => {
            running = false;
          });
      },
      onError: (error: Error) => {
        console.error(`${this.logTag}watchBlocks error:`, error);
      },
    });

    console.log(
      `${this.logTag}📡 Moonwell polling started (every ${this.pollIntervalBlocks} blocks)`,
    );

    return unwatch;
  }

  /**
   * Core check loop: for each mToken, scan new events, then check getAccountLiquidity for all known accounts.
   */
  async checkAllMarkets(): Promise<void> {
    // Incremental scan for new accounts across all mTokens
    for (const mToken of this.mTokenList) {
      try {
        await this.registry.scanNewEvents(this.client, mToken.address, this.logTag);
      } catch (e) {
        console.error(`${this.logTag}Error scanning mToken ${mToken.address.slice(0, 10)}...:`, e);
      }
    }

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

    console.log(`${this.logTag}🎯 ${liquidatable.length} liquidatable account(s) found!`);

    for (const account of liquidatable) {
      await this.liquidateAccount(account);
    }
  }

  /**
   * Batch check getAccountLiquidity for multiple accounts.
   * Returns accounts with shortfall > 0.
   */
  private async batchCheckShortfall(accounts: Address[]): Promise<Address[]> {
    const results = await Promise.allSettled(
      accounts.map(async (account) => {
        const [error, , shortfall] = await readContract(this.client, {
          address: this.comptroller,
          abi: comptrollerAbi,
          functionName: "getAccountLiquidity",
          args: [account],
        });
        // error === 0 means success, shortfall > 0 means liquidatable
        return error === 0n && shortfall > 0n ? account : null;
      }),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<Address | null> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((a): a is Address => a !== null);
  }

  // ─── Liquidation execution ───

  private async liquidateAccount(account: Address): Promise<void> {
    // Cooldown check (use comptroller address as "market" key)
    if (this.cooldown && !this.cooldown.isPositionReady(this.comptroller, account)) {
      return;
    }

    console.log(`${this.logTag}  🎯 ${account} — attempting Moonwell liquidation`);

    // Find borrow mToken (where account has debt) and collateral mToken (where account has supply)
    const { borrowMToken, collateralMToken, borrowBalance } =
      await this.findLiquidationTargets(account);

    if (!borrowMToken || !collateralMToken) {
      console.log(`${this.logTag}  ${account} — could not find borrow/collateral mToken, skipping`);
      return;
    }

    const borrowUnderlying = this.getUnderlying(borrowMToken);
    const collateralUnderlying = this.getUnderlying(collateralMToken);

    // SECURITY: Skip blacklisted tokens
    if (
      TOKEN_BLACKLIST.has(borrowUnderlying.toLowerCase()) ||
      TOKEN_BLACKLIST.has(collateralUnderlying.toLowerCase())
    ) {
      console.log(`${this.logTag}  ⛔ Skip ${account}: blacklisted token`);
      return;
    }

    // Calculate repay amount: min(borrowBalance × closeFactor, availableBalance)
    // For flash loan, availableBalance = flash loan amount (unlimited)
    // So repayAmount = borrowBalance × closeFactor
    const maxRepay = (borrowBalance * this.closeFactor) / MANTISSA;
    if (maxRepay === 0n) {
      console.log(`${this.logTag}  ${account} — maxRepay is 0, skipping`);
      return;
    }

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
    const encoder = new LiquidationEncoder(this.executorAddress, this.client);
    const callbackEncoder = new LiquidationEncoder(this.executorAddress, this.client);

    // Step 1: Approve borrow mToken to spend flash loan funds
    callbackEncoder.erc20Approve(borrowUnderlying, borrowMToken, maxUint256);

    // Step 2: liquidateBorrow — repay debt, seize collateral mToken
    callbackEncoder.moonwellLiquidateBorrow(borrowMToken, collateralMToken, account, repayAmount);

    // Step 3: redeemUnderlying — convert seized mToken to underlying
    // We don't know exact seized amount at encoding time, so use 0 to redeem all available
    // The executor will have the seized mTokens after liquidateBorrow
    // Use a large value to redeem everything available
    callbackEncoder.moonwellRedeemUnderlying(collateralMToken, 0n);

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

    // Step 6: Wrap in Balancer flash loan
    encoder.balancerFlashLoan(
      BALANCER_VAULT_ADDRESS,
      [{ asset: borrowUnderlying, amount: repayAmount }],
      callbackCalls,
    );

    const calls = encoder.flush();

    try {
      const success = await simulateAndExecFlashLoan(
        this.sharedDeps,
        encoder,
        calls,
        borrowUnderlying,
        false,
        repayAmount,
      );

      if (success) {
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

    // Approve borrow mToken
    encoder.erc20Approve(borrowUnderlying, borrowMToken, maxUint256);

    // liquidateBorrow
    encoder.moonwellLiquidateBorrow(borrowMToken, collateralMToken, account, repayAmount);

    // redeemUnderlying — convert seized mToken to underlying
    encoder.moonwellRedeemUnderlying(collateralMToken, 0n);

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
      );

      if (success) {
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
   * Find which mToken the account has borrowed and which has the most collateral.
   * Returns borrow mToken, collateral mToken, and the borrow balance.
   */
  private async findLiquidationTargets(account: Address): Promise<{
    borrowMToken: Address | null;
    collateralMToken: Address | null;
    borrowBalance: bigint;
  }> {
    let borrowMToken: Address | null = null;
    let borrowBalance = 0n;
    let collateralMToken: Address | null = null;
    let maxCollateralBalance = 0n;

    // Check all mTokens in parallel
    const results = await Promise.allSettled(
      this.mTokenList.map(async (mToken) => {
        const [borrowBal, mTokenBal] = await Promise.all([
          readContract(this.client, {
            address: mToken.address,
            abi: mTokenAbi,
            functionName: "borrowBalanceStored",
            args: [account],
          }),
          readContract(this.client, {
            address: mToken.address,
            abi: mTokenAbi,
            functionName: "balanceOf",
            args: [account],
          }),
        ]);
        return { mToken: mToken.address, borrowBal, mTokenBal };
      }),
    );

    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { mToken, borrowBal, mTokenBal } = result.value;

      // Find borrow mToken (first one with debt)
      if (borrowBal > 0n && borrowMToken === null) {
        borrowMToken = mToken;
        borrowBalance = borrowBal;
      }

      // Find collateral mToken (largest mToken balance)
      if (mTokenBal > maxCollateralBalance) {
        maxCollateralBalance = mTokenBal;
        collateralMToken = mToken;
      }
    }

    return { borrowMToken, collateralMToken, borrowBalance };
  }

  /**
   * Get the underlying token address for a mToken.
   * Uses the hardcoded map first, falls back to on-chain query.
   */
  private getUnderlying(mToken: Address): Address {
    const mapped = MOONWELL_UNDERLYING_MAP[mToken];
    if (mapped) return mapped;

    // Fallback: should not happen in normal operation since we configure all mTokens
    // with their underlying addresses. Log a warning and return the mToken itself.
    console.warn(
      `${this.logTag}⚠️ No underlying mapping for ${mToken.slice(0, 10)}..., using mToken address as fallback`,
    );
    return mToken;
  }
}
