import type { Address } from "viem";
export declare const FEED_REGISTRY_ADDRESS: Address;
/**
 * ISO 4217 denominations used by Chainlink
 */
export declare const DENOMINATIONS: {
    readonly EUR: "0x00000000000000000000000000000000000003d2";
    readonly GBP: "0x000000000000000000000000000000000000033a";
    readonly USD: "0x0000000000000000000000000000000000000348";
    readonly ETH: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    readonly BTC: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
};
export declare const MAPPINGS: Record<Address, Address>;
