import type { Address, BigIntish } from "../types.js";
export declare const ERC20_ALLOWANCE_RECIPIENTS: readonly ["morpho", "permit2", "bundler3.generalAdapter1"];
export type Erc20AllowanceRecipient = (typeof ERC20_ALLOWANCE_RECIPIENTS)[number];
export interface Permit2Allowance {
    amount: bigint;
    expiration: bigint;
    nonce: bigint;
}
export interface IPermit2Allowance {
    amount: BigIntish;
    expiration: BigIntish;
    nonce: BigIntish;
}
export interface IHolding {
    user: Address;
    token: Address;
    erc20Allowances: {
        [key in Erc20AllowanceRecipient]: bigint;
    };
    permit2BundlerAllowance: IPermit2Allowance;
    erc2612Nonce?: bigint;
    canTransfer?: boolean;
    balance: bigint;
}
export declare class Holding implements IHolding {
    /**
     * The user of this holding.
     */
    readonly user: Address;
    /**
     * The token in which this holding is denominated.
     */
    readonly token: Address;
    /**
     * Whether the user is allowed to transfer this holding's balance.
     */
    canTransfer?: boolean;
    /**
     * ERC20 allowance for this token from the user to the allowance recipient.
     */
    readonly erc20Allowances: {
        [key in Erc20AllowanceRecipient]: bigint;
    };
    /**
     * Permit2 allowance for this token from the user to the allowance recipient.
     */
    readonly permit2BundlerAllowance: Permit2Allowance;
    /**
     * ERC-2612 Permit nonce of the user for this token.
     * `undefined` if the token does not support ERC-2612.
     */
    erc2612Nonce?: bigint;
    /**
     * Allows to customize the setter behavior in child classes.
     */
    protected _balance: bigint;
    constructor({ user, token, erc20Allowances, permit2BundlerAllowance, balance, erc2612Nonce, canTransfer, }: IHolding);
    /**
     * The balance of the user for this token.
     */
    get balance(): bigint;
    set balance(value: bigint);
}
