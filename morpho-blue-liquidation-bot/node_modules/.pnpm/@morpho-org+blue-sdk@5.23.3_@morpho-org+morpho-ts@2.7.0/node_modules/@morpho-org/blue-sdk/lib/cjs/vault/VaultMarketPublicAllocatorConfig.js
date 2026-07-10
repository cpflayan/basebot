"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VaultMarketPublicAllocatorConfig = void 0;
class VaultMarketPublicAllocatorConfig {
    /**
     * The vault's address.
     */
    vault;
    /**
     * The market's id.
     */
    marketId;
    /**
     * The maximum amount of tokens that can be allocated to this market by the vault via the PublicAllocator.
     */
    maxIn;
    /**
     * The maximum amount of tokens that can be allocated out of this market by the vault via the PublicAllocator.
     */
    maxOut;
    constructor({ vault, marketId, maxIn, maxOut, }) {
        this.vault = vault;
        this.marketId = marketId;
        this.maxIn = maxIn;
        this.maxOut = maxOut;
    }
}
exports.VaultMarketPublicAllocatorConfig = VaultMarketPublicAllocatorConfig;
