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
import type { CometWatchlistConfig } from "@morpho-blue-liquidation-bot/config";
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
import { readContract, watchBlocks, getBlockNumber, getCode } from "viem/actions";
import { base } from "viem/chains";

import { BALANCER_VAULT_ADDRESS } from "./abis/BalancerVault.js";
import { cometViewAbi } from "./abis/Comet.js";
import { CometAccountRegistry } from "./cometAccountRegistry.js";
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
 * Token blacklist — skip Comets involving these tokens.
 */
const TOKEN_BLACKLIST = new Set<string>([
  "0x35e5db674d8e93a03d814fa0ada70731efe8a4b9", // USR (depegged)
]);

export interface CometLiquidationBotInputs {
  logTag: string;
  client: WalletClient<Transport, Chain, Account>;
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
  flashLoanProvider?: "balancer" | "aave";
  alwaysRealizeBadDebt?: boolean;
  registryFilePath?: string;
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
  private flashLoanProvider: "balancer" | "aave";
  private alwaysRealizeBadDebt: boolean;
  private registry: CometAccountRegistry;
  private pollIntervalBlocks: number;
  private sharedDeps: SharedExecutionDeps;
  /** Read-only client using Base public RPC — for historical event scanning only */
  private scanClient: Client<Transport, Chain>;

  constructor(inputs: CometLiquidationBotInputs) {
    this.logTag = inputs.logTag;
    this.client = inputs.client;
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
    };

    // Read-only client on Base public RPC for historical scanning
    this.scanClient = createPublicClient({
      chain: base,
      transport: http(BASE_PUBLIC_RPC),
    });
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
        const deployBlock = await this.findDeployBlock(comet.address, comet.deployBlock);
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
   * Find the exact deployment block of a Comet contract using exponential search + binary search.
   * Uses eth_getCode to check if the contract exists at a given block.
   * Falls back to estimatedDeployBlock if search fails.
   */
  private async findDeployBlock(
    cometAddress: Address,
    estimatedBlock: number,
  ): Promise<number | undefined> {
    try {
      const currentBlock = Number(await getBlockNumber(this.scanClient));

      // Step 1: Check if contract exists at estimated block
      let code = await getCode(this.scanClient, {
        address: cometAddress,
        blockNumber: BigInt(estimatedBlock),
      });

      let lo: number;
      let hi: number;

      if (code && code !== "0x") {
        // Contract exists at estimated block — search backwards
        hi = estimatedBlock;
        lo = Math.max(0, estimatedBlock - 100_000);
        let step = 100_000;

        // Exponential expansion backwards
        while (lo > 0) {
          code = await getCode(this.scanClient, {
            address: cometAddress,
            blockNumber: BigInt(lo),
          });
          if (code && code !== "0x") {
            hi = lo;
            lo = Math.max(0, lo - step);
            step *= 2;
          } else {
            break;
          }
        }
      } else {
        // Contract doesn't exist at estimated block — search forwards
        lo = estimatedBlock;
        hi = estimatedBlock;
        let step = 100_000;
        let found = false;

        // Exponential expansion forwards
        while (hi < currentBlock) {
          hi += step;
          step *= 2;
          code = await getCode(this.scanClient, {
            address: cometAddress,
            blockNumber: BigInt(hi),
          });
          if (code && code !== "0x") {
            found = true;
            break;
          }
        }

        if (!found) {
          console.warn(
            `${this.logTag}⚠️ Comet ${cometAddress.slice(0, 10)}... not found up to block ${hi}`,
          );
          return undefined;
        }
      }

      // Step 2: Binary search in [lo, hi]
      let searchLo = lo;
      let searchHi = hi;
      while (searchLo < searchHi) {
        const mid = Math.floor((searchLo + searchHi) / 2);
        const codeAtMid = await getCode(this.scanClient, {
          address: cometAddress,
          blockNumber: BigInt(mid),
        });

        if (codeAtMid && codeAtMid !== "0x") {
          searchHi = mid;
        } else {
          searchLo = mid + 1;
        }
      }

      return searchLo;
    } catch (e) {
      console.warn(
        `${this.logTag}⚠️ Deploy block search failed for ${cometAddress.slice(0, 10)}..., using configured value:`,
        e,
      );
      return undefined;
    }
  }

  /**
   * Cache the collateral assets for a Comet by reading numCollateralAssets + getCollateralAsset.
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
        `${this.logTag}📋 ${comet.address.slice(0, 10)}... has ${assets.length} collateral asset(s)`,
      );
    } catch (e) {
      console.error(
        `${this.logTag}Failed to cache collateral assets for ${comet.address.slice(0, 10)}...:`,
        e,
      );
      comet.collateralAssets = [];
    }
  }

  // ─── Polling loop ───

  /**
   * Start polling: check isLiquidatable on every N blocks.
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

        this.checkAllComets()
          .catch((e: unknown) => {
            console.error(`${this.logTag}Error in checkAllComets:`, e);
          })
          .finally(() => {
            running = false;
          });
      },
      onError: (error: Error) => {
        console.error(`${this.logTag}watchBlocks error:`, error);
      },
    });

    console.log(`${this.logTag}📡 Comet polling started (every ${this.pollIntervalBlocks} blocks)`);

    return unwatch;
  }

  /**
   * Core check loop: for each Comet, scan new events, then check isLiquidatable for all known accounts.
   */
  async checkAllComets(): Promise<void> {
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
        console.error(`${this.logTag}Error checking Comet ${comet.address.slice(0, 10)}...:`, e);
      }
    }
  }

  /**
   * Batch check isLiquidatable for multiple accounts using Promise.allSettled.
   */
  private async batchCheckLiquidatable(comet: Address, accounts: Address[]): Promise<Address[]> {
    const results = await Promise.allSettled(
      accounts.map(async (account) => {
        const [isLiq] = await readContract(this.client, {
          address: comet,
          abi: cometViewAbi,
          functionName: "isLiquidatable",
          args: [account],
        });
        return isLiq ? account : null;
      }),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<Address | null> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((a): a is Address => a !== null);
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

    const encoder = new LiquidationEncoder(this.executorAddress, this.client);
    const callbackEncoder = new LiquidationEncoder(this.executorAddress, this.client);

    // Step 1: Approve Comet to spend base asset (for buyCollateral)
    callbackEncoder.erc20Approve(comet.baseAsset, comet.address, maxUint256);

    // Step 2: Absorb — seize collateral from underwater account
    callbackEncoder.cometAbsorb(comet.address, [account]);

    // Step 3: Buy collateral from Comet using base asset
    for (const collateral of collateralAssets) {
      if (TOKEN_BLACKLIST.has(collateral.toLowerCase())) continue;

      try {
        const reserves = await readContract(this.client, {
          address: comet.address,
          abi: cometViewAbi,
          functionName: "getCollateralReserves",
          args: [collateral],
        });

        if (reserves > 0n) {
          callbackEncoder.cometBuyCollateral(
            comet.address,
            collateral,
            0n, // minAmount = 0 (we rely on simulation for safety)
            flashLoanAmount, // max base asset to spend
          );
        }
      } catch {
        // Skip collateral that fails reserve check
      }
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

    // Step 6: Wrap in Balancer flash loan
    encoder.balancerFlashLoan(
      BALANCER_VAULT_ADDRESS,
      [{ asset: comet.baseAsset, amount: flashLoanAmount }],
      callbackCalls,
    );

    const calls = encoder.flush();

    try {
      const success = await simulateAndExecFlashLoan(
        this.sharedDeps,
        encoder,
        calls,
        comet.baseAsset,
        false, // Comet liquidations are always profitable if simulation passes
        flashLoanAmount,
      );

      if (success) {
        console.log(
          `${this.logTag}[FlashLoan] Liquidated ${account} on Comet ${comet.address.slice(0, 10)}...`,
        );
      } else {
        console.log(
          `${this.logTag}[FlashLoan] Skipped ${account} on Comet ${comet.address.slice(0, 10)}... (not profitable)`,
        );
      }
    } catch (error) {
      console.error(
        `${this.logTag}[FlashLoan] Failed to liquidate ${account} on Comet ${comet.address.slice(0, 10)}...`,
        error,
      );
    }
  }

  /**
   * Direct liquidation path (no flash loan — requires pre-funded base asset).
   */
  private async liquidateCometDirect(comet: CometInfo, account: Address): Promise<void> {
    const collateralAssets = comet.collateralAssets ?? [];
    const encoder = new LiquidationEncoder(this.executorAddress, this.client);

    // Approve Comet
    encoder.erc20Approve(comet.baseAsset, comet.address, maxUint256);

    // Absorb
    encoder.cometAbsorb(comet.address, [account]);

    // Buy collateral
    for (const collateral of collateralAssets) {
      if (TOKEN_BLACKLIST.has(collateral.toLowerCase())) continue;

      try {
        const reserves = await readContract(this.client, {
          address: comet.address,
          abi: cometViewAbi,
          functionName: "getCollateralReserves",
          args: [collateral],
        });

        if (reserves > 0n) {
          encoder.cometBuyCollateral(comet.address, collateral, 0n, maxUint256);
        }
      } catch {
        // Skip
      }
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

    try {
      const success = await simulateAndExec(
        this.sharedDeps,
        encoder,
        calls,
        comet.baseAsset,
        false,
      );

      if (success) {
        console.log(
          `${this.logTag}Liquidated ${account} on Comet ${comet.address.slice(0, 10)}...`,
        );
      } else {
        console.log(
          `${this.logTag}Skipped ${account} on Comet ${comet.address.slice(0, 10)}... (not profitable)`,
        );
      }
    } catch (error) {
      console.error(
        `${this.logTag}Failed to liquidate ${account} on Comet ${comet.address.slice(0, 10)}...`,
        error,
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
      const [principal, , , _baseSupplyIndex, baseBorrowIndex] = await Promise.all([
        readContract(this.client, {
          address: comet,
          abi: cometViewAbi,
          functionName: "userBasic",
          args: [account],
        }).then((r) => r[0]), // principal (int104)
        readContract(this.client, {
          address: comet,
          abi: cometViewAbi,
          functionName: "userBasic",
          args: [account],
        }).then((r) => r[1]), // baseTrackingIndex
        readContract(this.client, {
          address: comet,
          abi: cometViewAbi,
          functionName: "userBasic",
          args: [account],
        }).then((r) => r[2]), // baseTrackingAccrued
        readContract(this.client, {
          address: comet,
          abi: cometViewAbi,
          functionName: "totalsBasic",
        }).then((r) => r[2]), // baseSupplyIndex
        readContract(this.client, {
          address: comet,
          abi: cometViewAbi,
          functionName: "totalsBasic",
        }).then((r) => r[3]), // baseBorrowIndex
      ]);

      // principal > 0 means supply, principal < 0 means borrow
      if (principal >= 0n) return 0n; // No debt

      // Borrow balance = |principal| * baseBorrowIndex / 1e18 (approximate)
      // Compound V3 uses: balance = presentValue(principal, baseBorrowIndex)
      // where presentValue for negative principal = |principal| * baseBorrowIndex / BASE_INDEX_SCALE
      const absPrincipal = -principal;
      // baseBorrowIndex is scaled by 1e15 (BASE_INDEX_SCALE = 1e15)
      const borrowBalance = (absPrincipal * baseBorrowIndex) / 1_000_000_000_000_000n;

      return borrowBalance;
    } catch (e) {
      console.warn(
        `${this.logTag}Failed to estimate debt for ${account} on ${comet.slice(0, 10)}...:`,
        e,
      );
      return 0n;
    }
  }
}
