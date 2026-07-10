"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VaultConfig = void 0;
const Token_js_1 = require("../token/Token.js");
class VaultConfig extends Token_js_1.Token {
    decimalsOffset;
    asset;
    constructor({ decimalsOffset, asset, ...config }) {
        super({ ...config, decimals: 18 });
        this.decimalsOffset = BigInt(decimalsOffset);
        this.asset = asset;
    }
}
exports.VaultConfig = VaultConfig;
