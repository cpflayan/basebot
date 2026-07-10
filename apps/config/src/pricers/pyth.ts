import type { Address } from "viem";
import { base, mainnet } from "viem/chains";

/**
 * Pyth Network price feed contract addresses per chain.
 * Source: https://docs.pyth.network/price-feeds/core/contract-addresses/evm
 */
export const PYTH_CONTRACT_ADDRESS: Record<number, Address> = {
  [mainnet.id]: "0x4305FB66699C3B2702D4d05CF36551390A4c69C6",
  [base.id]: "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a",
};

/**
 * Pyth Core price feed IDs (bytes32).
 * Feed IDs are the SAME across all chains.
 * Source: https://docs.pyth.network/price-feeds/core/price-feeds/price-feed-ids
 * Verified via Hermes API: https://hermes.pyth.network/v2/price_feeds?query=<SYMBOL>
 */
export const PYTH_FEED_IDS = {
  // Major crypto
  ETH_USD: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  BTC_USD: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  SOL_USD: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  XRP_USD: "0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8",
  // Stablecoins
  USDC_USD: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  USDT_USD: "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
  DAI_USD: "0xb0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e833f70dabfd",
  USDS_USD: "0x77f0971af11cc8bac224917275c1bf55f2319ed5c654a1ca955c82fa2d297ea1",
  GHO_USD: "0x2a0e948f637a8c251d9f06055e72eb4b3880dd57848bbdb02993c8165d7df4ee",
  // LST / LRT
  WSTETH_USD: "0x6df640f3b8963d8f8358f791f352b8364513f6ab1cca5ed3f1f7b5448980e784",
  CBETH_USD: "0x15ecddd26d49e1a8f1de9376ebebc03916ede873447c1255d2d5891b92ce5717",
  RETH_USD: "0xa0255134973f4fdf2f8f7808354274a3b1ebc6ee438be898d045e8b56ba1fe13",
  WEETH_USD: "0x9ee4e7c60b940440a261eb54b6d8149c23b580ed7da3139f7f08f4ea29dad395",
  EZETH_USD: "0x06c217a791f5c4f988b36629af4cb88fad827b2485400a358f3b02886b54de92",
  // Base-native / DeFi
  AERO_USD: "0x9db37f4d5654aad3e37e2e14ffd8d53265fb3026d1d8f91146539eebaa2ef45f",
  MORPHO_USD: "0x5b2a4c542d4a74dd11784079ef337c0403685e3114ba0d9909b5c7a7e06fdc42",
  VIRTUAL_USD: "0x8132e3eb1dac3e56939a16ff83848d194345f6688bff97eb1c8bd462d558802b",
  WELL_USD: "0x3cf6bab8bf8041dc8ee2a3edebe16b5f9f4ff3cce46006aeb15c885ba4779d0b",
  VVV_USD: "0x5ece7483ae221e3645ec0f9b5c6671ac830cb85471744df5d8e7deae152e31a2",
  // BTC wrappers
  CBBTC_USD: "0x2817d7bfe5c64b8ea956e9a26f573ef64e72e4d7891f2d6af9bcc93f7aff9a97",
  TBTC_USD: "0x56a3121958b01f99fdc4e1fd01e81050602c7ace3a571918bb55c6a96657cca9",
  LBTC_USD: "0x8f257aab6e7698bb92b15511915e593d6f8eae914452f781874754b03d0c612b",
  // Other
  EURC_USD: "0x76fa85158bf14ede77087fe3ae472f66213f6ea2f5b411cb2de472794990fa5c",
  CBXRP_USD: "0x95fd9e16d4cfc5d1370f32bb0bf2346860ad9c92fec83acf4ca263baf16c961d",
} as const;

/**
 * Mapping from token address → Pyth feed ID, per chain.
 * Extend this mapping to support more assets.
 *
 * Assets NOT on Pyth (will fallback to DefiLlama):
 * - wrsETH (0xEDfa23602D0EC14714057867A78d01e94176BEA0)
 * - MAMO (0x7300B37DfdfAb110d83290A29DfB31B1740219fE)
 *
 * To find the feed ID for a new asset, query the Hermes API:
 *   GET https://hermes.pyth.network/v2/price_feeds?query=<SYMBOL>
 */
export const PYTH_TOKEN_TO_FEED: Record<number, Record<Address, `0x${string}`>> = {
  [mainnet.id]: {
    // WETH
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": PYTH_FEED_IDS.ETH_USD,
    // WBTC
    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": PYTH_FEED_IDS.BTC_USD,
    // USDC
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": PYTH_FEED_IDS.USDC_USD,
    // USDT
    "0xdAC17F958D2ee523a2206206994597C13D831ec7": PYTH_FEED_IDS.USDT_USD,
    // DAI
    "0x6B175474E89094C44Da98b954EedeAC495271d0F": PYTH_FEED_IDS.DAI_USD,
  },
  [base.id]: {
    // --- Major assets ---
    // WETH
    "0x4200000000000000000000000000000000000006": PYTH_FEED_IDS.ETH_USD,
    // USDC
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": PYTH_FEED_IDS.USDC_USD,
    // USDbC
    "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA": PYTH_FEED_IDS.USDC_USD,
    // cbBTC
    "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf": PYTH_FEED_IDS.CBBTC_USD,
    // AERO
    "0x940181a94A35A4569E4529A3CDfB74e38FD98631": PYTH_FEED_IDS.AERO_USD,
    // --- LST / LRT ---
    // cbETH
    "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22": PYTH_FEED_IDS.CBETH_USD,
    // wstETH
    "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452": PYTH_FEED_IDS.WSTETH_USD,
    // rETH
    "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c": PYTH_FEED_IDS.RETH_USD,
    // weETH
    "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A": PYTH_FEED_IDS.WEETH_USD,
    // ezETH
    "0x2416092f143378750bb29b79eD961ab195CcEea5": PYTH_FEED_IDS.EZETH_USD,
    // --- Stablecoins ---
    // EURC
    "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42": PYTH_FEED_IDS.EURC_USD,
    // USDS
    "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc": PYTH_FEED_IDS.USDS_USD,
    // DAI
    "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb": PYTH_FEED_IDS.DAI_USD,
    // GHO
    "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee": PYTH_FEED_IDS.GHO_USD,
    // --- BTC wrappers ---
    // tBTC
    "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b": PYTH_FEED_IDS.TBTC_USD,
    // LBTC
    "0xecAc9C5F704e954931349Da37F60E39f515c11c1": PYTH_FEED_IDS.LBTC_USD,
    // --- DeFi / long-tail ---
    // WELL (Moonwell)
    "0xA88594D404727625A9437C3f886C7643872296AE": PYTH_FEED_IDS.WELL_USD,
    // VIRTUAL
    "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b": PYTH_FEED_IDS.VIRTUAL_USD,
    // MORPHO
    "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842": PYTH_FEED_IDS.MORPHO_USD,
    // VVV (Venice AI)
    "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf": PYTH_FEED_IDS.VVV_USD,
    // cbXRP
    "0xcb585250f852C6c6bf90434AB21A00f02833a4af": PYTH_FEED_IDS.CBXRP_USD,
  },
};
