"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.User = void 0;
class User {
    /**
     * The user's address.
     */
    address;
    /**
     * Whether the bundler is authorized to manage the user's position on Morpho Blue.
     */
    isBundlerAuthorized;
    /**
     * The user's nonce on Morpho Blue.
     */
    morphoNonce;
    constructor({ address, isBundlerAuthorized, morphoNonce, }) {
        this.address = address;
        this.isBundlerAuthorized = isBundlerAuthorized;
        this.morphoNonce = morphoNonce;
    }
}
exports.User = User;
