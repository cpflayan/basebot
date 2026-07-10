import type { Address } from "../types.js";
export interface IVaultUser {
    vault: Address;
    user: Address;
    isAllocator: boolean;
    allowance: bigint;
}
export declare class VaultUser implements IVaultUser {
    /**
     * The vault's address.
     */
    readonly vault: Address;
    /**
     * The user's address.
     */
    readonly user: Address;
    /**
     * Whether the user is an allocator of the vault.
     */
    isAllocator: boolean;
    /**
     * The allowance of the vault over the user's underlying assets.
     */
    allowance: bigint;
    constructor({ vault, user, isAllocator, allowance }: IVaultUser);
}
