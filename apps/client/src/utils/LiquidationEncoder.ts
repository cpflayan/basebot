import { ExecutorEncoder } from "executooor-viem";
import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import { encodeAbiParameters, encodeFunctionData } from "viem";

import { aavePoolWriteAbi } from "../abis/AaveV3";
import { cometViewAbi } from "../abis/Comet";
import { mTokenAbi } from "../abis/Moonwell";
import { preLiquidationAbi } from "../abis/PreLiquidation";

export class LiquidationEncoder<
  client extends Client<Transport, Chain, Account> = Client<Transport, Chain, Account>,
> extends ExecutorEncoder<client> {
  /**
   * Snapshot the current call stack for safe rollback.
   * Use before attempting operations that may fail (e.g., venue routing).
   */
  public snapshotCalls(): { calls: Hex[]; totalValue: bigint } {
    return {
      calls: [...this.calls],
      totalValue: this.totalValue,
    };
  }

  /**
   * Restore the call stack to a previous snapshot.
   * Use when an operation fails to rollback without side effects.
   */
  public restoreCalls(snapshot: { calls: Hex[]; totalValue: bigint }): void {
    this.calls = snapshot.calls;
    this.totalValue = snapshot.totalValue;
  }

  public preLiquidate(
    preLiquidation: Address,
    borrower: Address,
    seizedAssets: bigint,
    repaidShares: bigint,
    callbackCalls?: Hex[],
  ) {
    this.pushCall(
      preLiquidation,
      0n,
      encodeFunctionData({
        abi: preLiquidationAbi,
        functionName: "preLiquidate",
        args: [
          borrower,
          seizedAssets,
          repaidShares,
          encodeAbiParameters(
            [{ type: "bytes[]" }, { type: "bytes" }],
            [callbackCalls ?? [], "0x"],
          ),
        ],
      }),
      {
        sender: preLiquidation,
        dataIndex: 1n, // onPreLiquidate(uint256,bytes)
      },
    );
  }

  // ─── Aave V3 methods ───

  /**
   * Call Aave V3 Pool.liquidationCall() — repay a borrower's debt and seize their collateral.
   * @param poolAddress - Aave V3 Pool contract address
   * @param collateralAsset - the collateral asset to seize
   * @param debtAsset - the debt asset to repay
   * @param user - the underwater borrower address
   * @param debtToCover - amount of debt to cover (in debt asset units)
   * @param receiveAToken - whether to receive aTokens instead of underlying
   */
  public aaveLiquidationCall(
    poolAddress: Address,
    collateralAsset: Address,
    debtAsset: Address,
    user: Address,
    debtToCover: bigint,
    receiveAToken: boolean,
  ) {
    this.pushCall(
      poolAddress,
      0n,
      encodeFunctionData({
        abi: aavePoolWriteAbi,
        functionName: "liquidationCall",
        args: [collateralAsset, debtAsset, user, debtToCover, receiveAToken],
      }),
    );
  }

  // ─── Compound V3 (Comet) methods ───

  /**
   * Call Comet.absorb() — absorb underwater accounts and seize their collateral.
   * @param comet - Comet contract address
   * @param accounts - array of underwater borrower addresses
   */
  public cometAbsorb(comet: Address, accounts: Address[]) {
    this.pushCall(
      comet,
      0n,
      encodeFunctionData({
        abi: cometViewAbi,
        functionName: "absorb",
        args: [this.address, accounts], // absorber = executor
      }),
    );
  }

  /**
   * Call Comet.buyCollateral() — buy seized collateral from Comet using base asset.
   * @param comet - Comet contract address
   * @param collateralAsset - collateral token to buy
   * @param minAmount - minimum collateral amount to receive
   * @param baseAmount - max base asset amount to spend
   */
  public cometBuyCollateral(
    comet: Address,
    collateralAsset: Address,
    minAmount: bigint,
    baseAmount: bigint,
  ) {
    this.pushCall(
      comet,
      0n,
      encodeFunctionData({
        abi: cometViewAbi,
        functionName: "buyCollateral",
        args: [collateralAsset, minAmount, baseAmount, this.address], // dst = executor
      }),
    );
  }

  // ─── Moonwell (Compound V2) methods ───

  /**
   * Call MToken.liquidateBorrow() — repay a borrower's debt and seize their collateral.
   * The protocol automatically transfers seized mToken collateral to the liquidator (executor).
   *
   * @param mTokenBorrow - the mToken contract where the borrower has debt
   * @param mTokenCollateral - the mToken contract of the collateral to seize
   * @param borrower - the underwater borrower address
   * @param repayAmount - amount of underlying to repay (in underlying token units)
   */
  public moonwellLiquidateBorrow(
    mTokenBorrow: Address,
    mTokenCollateral: Address,
    borrower: Address,
    repayAmount: bigint,
  ) {
    this.pushCall(
      mTokenBorrow,
      0n,
      encodeFunctionData({
        abi: mTokenAbi,
        functionName: "liquidateBorrow",
        args: [mTokenCollateral, borrower, repayAmount],
      }),
    );
  }

  /**
   * Call MToken.redeem() — burn mTokens to receive underlying tokens.
   * Use maxUint256 to redeem ALL mTokens held by the caller.
   *
   * This is the correct way to convert seized mToken collateral to underlying
   * after liquidateBorrow, since we don't know the exact mToken amount at encoding time.
   *
   * @param mToken - the mToken contract to redeem
   * @param mTokenAmount - amount of mTokens to burn (use maxUint256 for all)
   */
  public moonwellRedeem(mToken: Address, mTokenAmount: bigint) {
    this.pushCall(
      mToken,
      0n,
      encodeFunctionData({
        abi: mTokenAbi,
        functionName: "redeem",
        args: [mTokenAmount],
      }),
    );
  }

  /**
   * @deprecated Use moonwellRedeem(maxUint256) instead.
   * redeemUnderlying(0) is a no-op in Compound V2 — it redeems 0 underlying tokens.
   */
  public moonwellRedeemUnderlying(mToken: Address, redeemAmount: bigint) {
    this.pushCall(
      mToken,
      0n,
      encodeFunctionData({
        abi: mTokenAbi,
        functionName: "redeemUnderlying",
        args: [redeemAmount],
      }),
    );
  }

  // ─── Flash Loan Providers ───

  /**
   * Morpho Blue flash loan — 0% fee, single-asset.
   * Callback: onMorphoFlashLoan(uint256,bytes)
   */
  public morphoBlueFlashLoan(
    morphoAddress: Address,
    asset: Address,
    amount: bigint,
    callbackCalls?: Hex[],
  ) {
    this.blueFlashLoan(morphoAddress, asset, amount, callbackCalls);
  }

  /**
   * Aave V3 flash loan — 0.09% premium on Base.
   * Callback: executeOperation(address[],uint256[],uint256[],address,bytes)
   */
  public aaveFlashLoanWithPremium(
    aavePoolAddress: Address,
    requests: { asset: Address; amount: bigint }[],
    premium: bigint,
    callbackCalls?: Hex[],
  ) {
    this.aaveFlashLoan(aavePoolAddress, requests, premium, callbackCalls);
  }
}
