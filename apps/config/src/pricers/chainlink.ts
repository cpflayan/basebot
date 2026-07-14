import type { Address } from "viem";
import { base } from "viem/chains";

export const FEED_REGISTRY_ADDRESS: Address = "0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf";

/**
 * ISO 4217 denominations used by Chainlink
 */
export const DENOMINATIONS = {
  EUR: "0x00000000000000000000000000000000000003d2",
  GBP: "0x000000000000000000000000000000000000033a",
  USD: "0x0000000000000000000000000000000000000348",
  ETH: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  BTC: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB",
} as const;

/**
 * Mainnet Feed Registry token → denomination mapping.
 * Used only when querying via Feed Registry (mainnet only).
 */
export const MAPPINGS: Record<Address, Address> = {
  ["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"]: DENOMINATIONS.ETH, // WETH → ETH
  ["0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"]: DENOMINATIONS.BTC, // WBTC → BTC
};

/**
 * Chainlink Aggregator Proxy addresses per chain.
 * Used for non-mainnet chains where Feed Registry is unavailable.
 * Each entry maps a token address → its Chainlink AggregatorV3 proxy on that chain.
 *
 * Source: https://docs.chain.link/data-feeds/price-feeds/addresses?network=base
 */
export const CHAINLINK_PROXY: Record<number, Record<Address, Address>> = {
  [base.id]: {
    // WETH → ETH/USD proxy
    "0x4200000000000000000000000000000000000006": "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    // USDC → USDC/USD proxy
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
    // USDbC → USDC/USD proxy (same feed, pegged stable)
    "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA": "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
    // cbBTC → dedicated cbBTC/USD AggregatorV3 (same feed Comet USDC uses on Base)
    // Verified on-chain: description()="cbBTC / USD", decimals=8, latestRoundData OK.
    // Old value 0x07D51B655d438A8d14c9A76a5d07b0240CF4639B had no code (invalid).
    "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf": "0x8D38A3d6B3c3B7d96D6536DA7Eef94A9d7dbC991",
  },
};
