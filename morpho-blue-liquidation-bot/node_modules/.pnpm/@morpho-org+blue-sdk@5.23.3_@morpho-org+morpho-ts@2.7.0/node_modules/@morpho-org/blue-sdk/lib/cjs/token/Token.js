"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Token = void 0;
const addresses_js_1 = require("../addresses.js");
const chain_js_1 = require("../chain.js");
const index_js_1 = require("../math/index.js");
class Token {
    static native(chainId) {
        const currency = chain_js_1.ChainUtils.CHAIN_METADATA[chainId].nativeCurrency;
        return new Token({ ...currency, address: addresses_js_1.NATIVE_ADDRESS });
    }
    /**
     * The token's address.
     */
    address;
    /**
     * The token's name.
     */
    name;
    /**
     * The token's symbol.
     */
    symbol;
    /**
     * The token's number of decimals. Defaults to 0.
     */
    decimals;
    /**
     * The eip712 domain of the token if it can be directly queried onchain
     */
    eip5267Domain;
    /**
     * Price of the token in USD (scaled by WAD).
     */
    price;
    constructor({ address, name, symbol, decimals = 0, price, eip5267Domain, }) {
        this.address = address;
        this.name = name;
        this.symbol = symbol;
        this.decimals = Number(decimals);
        this.eip5267Domain = eip5267Domain;
        if (price != null)
            this.price = BigInt(price);
    }
    /**
     * Quotes an amount in USD (scaled by WAD) in this token.
     * Returns `undefined` iff the token's price is undefined.
     * @param amount The amount of USD to quote.
     */
    fromUsd(amount, rounding = "Down") {
        if (this.price == null)
            return;
        return index_js_1.MathLib.mulDiv(amount, 10n ** BigInt(this.decimals), this.price, rounding);
    }
    /**
     * Quotes an amount of tokens in USD (scaled by WAD).
     * Returns `undefined` iff the token's price is undefined.
     * @param amount The amount of tokens to quote.
     */
    toUsd(amount, rounding = "Down") {
        if (this.price == null)
            return;
        return index_js_1.MathLib.mulDiv(amount, this.price, 10n ** BigInt(this.decimals), rounding);
    }
}
exports.Token = Token;
