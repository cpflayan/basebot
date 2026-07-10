"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Eip5267Domain = exports.EIP_712_FIELDS = void 0;
exports.EIP_712_FIELDS = [
    "name",
    "version",
    "chainId",
    "verifyingContract",
    "salt",
];
class Eip5267Domain {
    /**
     * A bit map where bit i is set to 1 if and only if domain field i is present (0 ≤ i ≤ 4).
     * Bits are read from least significant to most significant, and fields are indexed in the order that is specified by EIP-712, identical to the order in which they are listed in the function type.
     */
    fields;
    /**
     * The user readable name of signing domain, i.e. the name of the DApp or the protocol.
     */
    name;
    /**
     * The current major version of the signing domain.
     * Signatures from different versions are not compatible.
     */
    version;
    /**
     * The EIP-155 chain id.
     */
    chainId;
    /**
     * The address of the contract that will verify the EIP-712 signature.
     */
    verifyingContract;
    /**
     * A disambiguating salt for the protocol.
     * This can be used as a domain separator of last resort.
     */
    salt;
    /**
     * A list of EIP numbers, each of which MUST refer to an EIP that extends EIP-712 with new domain fields, along with a method to obtain the value for those fields, and potentially conditions for inclusion.
     * The value of fields does not affect their inclusion.
     */
    extensions;
    eip712Domain;
    constructor({ fields, name, version, chainId, verifyingContract, salt, extensions, }) {
        this.fields = fields;
        this.name = name;
        this.version = version;
        this.chainId = chainId;
        this.verifyingContract = verifyingContract;
        this.salt = salt;
        this.extensions = extensions;
        this.eip712Domain = this.asEip712Domain();
    }
    asEip712Domain() {
        const fields = BigInt(this.fields);
        return exports.EIP_712_FIELDS.reduce((acc, field, i) => {
            if (fields & (2n ** BigInt(i))) {
                // @ts-expect-error Typescript doesn't infer value type based on field.
                acc[field] =
                    field === "chainId"
                        ? // Signature does not correspond if chainId is a bigint.
                            Number(this.chainId)
                        : this[field];
            }
            return acc;
        }, {});
    }
}
exports.Eip5267Domain = Eip5267Domain;
