"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VaultMarketConfig = void 0;
class VaultMarketConfig {
    /**
     * The vault's address.
     */
    vault;
    /**
     * The market's id.
     */
    marketId;
    /**
     * The maximum amount of tokens that can be allocated to this market.
     */
    cap;
    /**
     * The pending maximum amount of tokens that can be allocated to this market.
     */
    pendingCap;
    /**
     * The timestamp at which the market can be removed from the withdraw queue.
     */
    removableAt;
    /**
     * Whether this market is enabled, i.e. whether additional tokens can be allocated to it.
     */
    enabled;
    /**
     * The vault's PublicAllocator configuration on the corresponding market.
     */
    publicAllocatorConfig;
    constructor({ vault, marketId, cap, pendingCap, removableAt, enabled, publicAllocatorConfig, }) {
        this.vault = vault;
        this.marketId = marketId;
        this.cap = cap;
        this.pendingCap = pendingCap;
        this.removableAt = removableAt;
        this.enabled = enabled;
        this.publicAllocatorConfig = publicAllocatorConfig;
    }
}
exports.VaultMarketConfig = VaultMarketConfig;
