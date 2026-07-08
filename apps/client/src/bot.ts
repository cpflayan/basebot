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
} from "@morpho-org/blue-sdk";
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
import {
  MarketsFetchingCooldownMechanism,
  PositionLiquidationCooldownMechanism,
} from "./utils/cooldownMechanisms.js";
import { fetchWhitelistedVaults } from "./utils/fetch-whitelisted-vaults.js";
import { Flashbots } from "./utils/flashbots.js";
import { LiquidationEncoder } from "./utils/LiquidationEncoder.js";
import { DEFAULT_LIQUIDATION_BUFFER_BPS, WAD, wMulDown } from "./utils/maths.js";

/**
 * Slippage tolerance for DEX swaps within flash loan path.
 * 1% = 100 bps. Protects against sandwich attacks in public mempool.
 */
const FLASH_LOAN_SLIPPAGE_BPS = 100n; // 1%
const BPS_DENOMINATOR = 10_000n;

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
  }

  async run() {
    await this.fetchMarkets();

    const { liquidatablePositions, preLiquidatablePositions } =
      await this.dataProvider.fetchLiquidatablePositions(this.client, this.coveredMarkets);

    await Promise.all([
      ...liquidatablePositions.map((position) => this.liquidate(position)),
      ...preLiquidatablePositions.map((position) => this.preLiquidate(position)),
    ]);
  }

  private async liquidate(position: AccrualPosition) {
    const marketParams = position.market.params;
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
        lltv: BigInt(marketParams.lltv),
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
        lltv: BigInt(marketParams.lltv),
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
  }
}
