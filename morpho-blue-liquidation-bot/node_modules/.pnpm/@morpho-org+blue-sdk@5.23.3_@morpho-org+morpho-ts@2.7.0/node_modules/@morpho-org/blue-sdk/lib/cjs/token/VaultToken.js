"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VaultToken = void 0;
const VaultUtils_js_1 = require("../vault/VaultUtils.js");
const WrappedToken_js_1 = require("./WrappedToken.js");
class VaultToken extends WrappedToken_js_1.WrappedToken {
    asset;
    decimalsOffset;
    /**
     * The ERC4626 vault's total supply of shares.
     */
    totalSupply;
    /**
     * The ERC4626 vault's total assets.
     */
    totalAssets;
    constructor(config, { totalAssets, totalSupply }) {
        super(config, config.asset);
        this.asset = config.asset;
        this.totalAssets = totalAssets;
        this.totalSupply = totalSupply;
        this.decimalsOffset = BigInt(config.decimalsOffset);
    }
    _wrap(amount, rounding) {
        return VaultUtils_js_1.VaultUtils.toShares(amount, this, rounding);
    }
    _unwrap(amount, rounding) {
        return VaultUtils_js_1.VaultUtils.toAssets(amount, this, rounding);
    }
}
exports.VaultToken = VaultToken;
