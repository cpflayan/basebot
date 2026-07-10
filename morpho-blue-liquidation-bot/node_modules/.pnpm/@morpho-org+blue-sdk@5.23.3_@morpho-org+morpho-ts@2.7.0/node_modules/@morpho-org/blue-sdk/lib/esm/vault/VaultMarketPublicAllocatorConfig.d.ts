import type { Address, MarketId } from "../types.js";
/**
 * The vault's configuration of a market on the PublicAllocator.
 */
export interface IVaultMarketPublicAllocatorConfig {
    vault: Address;
    marketId: MarketId;
    maxIn: bigint;
    maxOut: bigint;
}
export declare class VaultMarketPublicAllocatorConfig implements IVaultMarketPublicAllocatorConfig {
    /**
     * The vault's address.
     */
    readonly vault: Address;
    /**
     * The market's id.
     */
    readonly marketId: MarketId;
    /**
     * The maximum amount of tokens that can be allocated to this market by the vault via the PublicAllocator.
     */
    maxIn: bigint;
    /**
     * The maximum amount of tokens that can be allocated out of this market by the vault via the PublicAllocator.
     */
    maxOut: bigint;
    constructor({ vault, marketId, maxIn, maxOut, }: IVaultMarketPublicAllocatorConfig);
}
