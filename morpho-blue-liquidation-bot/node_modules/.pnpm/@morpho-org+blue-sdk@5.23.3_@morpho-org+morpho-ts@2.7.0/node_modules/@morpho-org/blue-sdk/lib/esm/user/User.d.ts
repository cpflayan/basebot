import type { Address } from "../types.js";
export declare class User {
    /**
     * The user's address.
     */
    readonly address: Address;
    /**
     * Whether the bundler is authorized to manage the user's position on Morpho Blue.
     */
    isBundlerAuthorized: boolean;
    /**
     * The user's nonce on Morpho Blue.
     */
    morphoNonce: bigint;
    constructor({ address, isBundlerAuthorized, morphoNonce, }: {
        address: Address;
        isBundlerAuthorized: boolean;
        morphoNonce: bigint;
    });
}
