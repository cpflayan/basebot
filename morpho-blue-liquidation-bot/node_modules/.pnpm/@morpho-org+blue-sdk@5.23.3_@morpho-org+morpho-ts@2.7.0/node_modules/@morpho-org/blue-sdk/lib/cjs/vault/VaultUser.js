"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VaultUser = void 0;
class VaultUser {
    /**
     * The vault's address.
     */
    vault;
    /**
     * The user's address.
     */
    user;
    /**
     * Whether the user is an allocator of the vault.
     */
    isAllocator;
    /**
     * The allowance of the vault over the user's underlying assets.
     */
    allowance;
    constructor({ vault, user, isAllocator, allowance }) {
        this.vault = vault;
        this.user = user;
        this.isAllocator = isAllocator;
        this.allowance = allowance;
    }
}
exports.VaultUser = VaultUser;
