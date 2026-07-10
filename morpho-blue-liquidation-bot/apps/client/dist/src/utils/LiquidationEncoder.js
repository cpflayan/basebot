import { ExecutorEncoder } from "executooor-viem";
import { encodeAbiParameters, encodeFunctionData } from "viem";
import { preLiquidationAbi } from "../abis/PreLiquidation";
export class LiquidationEncoder extends ExecutorEncoder {
    preLiquidate(preLiquidation, borrower, seizedAssets, repaidShares, callbackCalls) {
        this.pushCall(preLiquidation, 0n, encodeFunctionData({
            abi: preLiquidationAbi,
            functionName: "preLiquidate",
            args: [
                borrower,
                seizedAssets,
                repaidShares,
                encodeAbiParameters([{ type: "bytes[]" }, { type: "bytes" }], [callbackCalls ?? [], "0x"]),
            ],
        }), {
            sender: preLiquidation,
            dataIndex: 1n, // onPreLiquidate(uint256,bytes)
        });
    }
}
