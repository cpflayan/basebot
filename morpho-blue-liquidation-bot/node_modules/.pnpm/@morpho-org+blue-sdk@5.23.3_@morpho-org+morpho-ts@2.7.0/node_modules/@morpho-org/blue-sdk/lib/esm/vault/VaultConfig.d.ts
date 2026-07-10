import { type IToken, Token } from "../token/Token.js";
import type { Address, BigIntish } from "../types.js";
export interface IVaultConfig extends Omit<IToken, "decimals"> {
    decimalsOffset: BigIntish;
    asset: Address;
}
export declare class VaultConfig extends Token implements IVaultConfig {
    readonly decimalsOffset: bigint;
    readonly asset: `0x${string}`;
    constructor({ decimalsOffset, asset, ...config }: IVaultConfig);
}
