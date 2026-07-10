import type { Address } from "../types.js";
export declare const EIP_712_FIELDS: readonly ["name", "version", "chainId", "verifyingContract", "salt"];
export type Eip712Field = (typeof EIP_712_FIELDS)[number];
export interface IEip5267Domain {
    fields: `0x${string}`;
    name: string;
    version: string;
    chainId: bigint;
    verifyingContract: Address;
    salt: `0x${string}`;
    extensions: readonly bigint[];
}
export declare class Eip5267Domain implements IEip5267Domain {
    /**
     * A bit map where bit i is set to 1 if and only if domain field i is present (0 ≤ i ≤ 4).
     * Bits are read from least significant to most significant, and fields are indexed in the order that is specified by EIP-712, identical to the order in which they are listed in the function type.
     */
    readonly fields: `0x${string}`;
    /**
     * The user readable name of signing domain, i.e. the name of the DApp or the protocol.
     */
    readonly name: string;
    /**
     * The current major version of the signing domain.
     * Signatures from different versions are not compatible.
     */
    readonly version: string;
    /**
     * The EIP-155 chain id.
     */
    readonly chainId: bigint;
    /**
     * The address of the contract that will verify the EIP-712 signature.
     */
    readonly verifyingContract: `0x${string}`;
    /**
     * A disambiguating salt for the protocol.
     * This can be used as a domain separator of last resort.
     */
    readonly salt: `0x${string}`;
    /**
     * A list of EIP numbers, each of which MUST refer to an EIP that extends EIP-712 with new domain fields, along with a method to obtain the value for those fields, and potentially conditions for inclusion.
     * The value of fields does not affect their inclusion.
     */
    readonly extensions: readonly bigint[];
    readonly eip712Domain: {
        name?: string | undefined;
        chainId?: number | undefined;
        version?: string | undefined;
        verifyingContract?: `0x${string}` | undefined;
        salt?: `0x${string}` | undefined;
    };
    constructor({ fields, name, version, chainId, verifyingContract, salt, extensions, }: IEip5267Domain);
    private asEip712Domain;
}
