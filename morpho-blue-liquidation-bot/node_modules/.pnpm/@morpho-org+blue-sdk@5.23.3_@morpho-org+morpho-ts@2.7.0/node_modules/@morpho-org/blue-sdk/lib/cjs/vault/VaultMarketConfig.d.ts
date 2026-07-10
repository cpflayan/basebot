import type { Address, MarketId } from "../types.js";
import type { Pending } from "./Vault.js";
import type { VaultMarketPublicAllocatorConfig } from "./VaultMarketPublicAllocatorConfig.js";
export interface IVaultMarketConfig {
    vault: Address;
    marketId: MarketId;
    cap: bigint;
    pendingCap: Pending<bigint>;
    removableAt: bigint;
    enabled: boolean;
    publicAllocatorConfig?: VaultMarketPublicAllocatorConfig;
}
export declare class VaultMarketConfig implements IVaultMarketConfig {
    /**
     * The vault's address.
     */
    readonly vault: Address;
    /**
     * The market's id.
     */
    readonly marketId: MarketId;
    /**
     * The maximum amount of tokens that can be allocated to this market.
     */
    cap: bigint;
    /**
     * The pending maximum amount of tokens that can be allocated to this market.
     */
    pendingCap: Pending<bigint>;
    /**
     * The timestamp at which the market can be removed from the withdraw queue.
     */
    removableAt: bigint;
    /**
     * Whether this market is enabled, i.e. whether additional tokens can be allocated to it.
     */
    enabled: boolean;
    /**
     * The vault's PublicAllocator configuration on the corresponding market.
     */
    readonly publicAllocatorConfig?: VaultMarketPublicAllocatorConfig;
    constructor({ vault, marketId, cap, pendingCap, removableAt, enabled, publicAllocatorConfig, }: IVaultMarketConfig);
}
