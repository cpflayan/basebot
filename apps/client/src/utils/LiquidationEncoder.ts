import { ExecutorEncoder } from "executooor-viem";
import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import { encodeAbiParameters, encodeFunctionData } from "viem";

import { cometViewAbi } from "../abis/Comet";
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
}
