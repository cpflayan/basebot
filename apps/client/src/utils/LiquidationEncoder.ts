import { ExecutorEncoder } from "executooor-viem";
import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import { encodeAbiParameters, encodeFunctionData } from "viem";

import { cometViewAbi } from "../abis/Comet";
import { mTokenAbi } from "../abis/Moonwell";
import { preLiquidationAbi } from "../abis/PreLiquidation";

export class LiquidationEncoder<
  client extends Client<Transport, Chain, Account> = Client<Transport, Chain, Account>,
> extends ExecutorEncoder<client> {
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
   * Call MToken.redeemUnderlying() — convert mToken collateral to underlying token.
   * After liquidateBorrow, the executor holds seized mTokens. This redeems them
   * for the underlying asset so it can be swapped via DEX.
   *
   * @param mToken - the mToken contract to redeem
   * @param redeemAmount - amount of underlying to redeem (in underlying token units)
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
}
