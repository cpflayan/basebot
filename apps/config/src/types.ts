import type { Address, Chain, Hex } from "viem";

export type LiquidityVenueName =
  | "1inch"
  | "aerodrome"
  | "erc20Wrapper"
  | "erc4626"
  | "lifi"
  | "liquidSwap"
  | "midas"
  | "pendlePT"
  | "uniswapV3"
  | "uniswapV4"
  | "zeroEx";

export type PricerName = "chainlink" | "defillama" | "morphoApi" | "pyth" | "uniswapV3";

export type DataProviderName = "morphoApi" | "hyperIndex";

export interface Config {
  chain: Chain;
  wNative: Address;
  options: Options;
}

export type FlashLoanProvider = "balancer" | "morpho" | "aave";

export interface Options {
  dataProvider: DataProviderName;
  vaultWhitelist: Address[] | "morpho-api";
  additionalMarketsWhitelist: Hex[];
  liquidityVenues: LiquidityVenueName[];
  pricers?: PricerName[];
  treasuryAddress?: Address;
  liquidationBufferBps?: number;
  useFlashbots: boolean;
  blockInterval?: number;
  watchBlocksRetryDelayMs?: number;
  useFlashLoan?: boolean;
  flashLoanProvider?: FlashLoanProvider;
  flashLoanFallbackProviders?: FlashLoanProvider[];
  cometWatchlist?: CometWatchlistConfig;
  moonwellWatchlist?: MoonwellWatchlistConfig;
  aaveWatchlist?: AaveWatchlistConfig;
  /** Fallback RPC URLs for scan clients (historical event scanning) */
  scanRpcUrls?: string[];
}

export interface CometWatchlistConfig {
  enabled: boolean;
  comets: {
    address: Address;
    baseAsset: Address;
    deployBlock: number;
  }[];
  pollIntervalBlocks?: number;
}

export interface MoonwellWatchlistConfig {
  enabled: boolean;
  comptroller: Address;
  mTokens: {
    /** MToken (cToken) address */
    address: Address;
    /** Underlying token address */
    underlying: Address;
    /** Block number where the mToken was deployed */
    deployBlock: number;
  }[];
  pollIntervalBlocks?: number;
  /** Safety margin above 1e18 to start evaluating — avoids wasting RPC calls on nearly-healthy accounts */
  minHealthFactorBuffer?: bigint;
  /** Slippage tolerance for DEX swaps in bps (default: 100 = 1%) */
  slippageBps?: number;
  /** Token addresses to skip during liquidation (blacklisted/depegged assets) */
  tokenBlacklist?: Address[];
}

export interface AaveWatchlistConfig {
  enabled: boolean;
  poolAddress: Address;
  poolDeployBlock: number;
  reserves: Address[];
  /** Fast path cadence (hot / near-liq accounts). Default 1 = every block. */
  pollIntervalBlocks?: number;
  /**
   * Full-registry HF scan every N fast ticks (default 10).
   * Hot accounts (last HF below nearHealthFactor) are rechecked every pollIntervalBlocks.
   */
  fullScanIntervalBlocks?: number;
  /**
   * Accounts with last observed HF below this (as float, e.g. 1.05) join the hot set.
   * Default 1.05 — prioritizes near-liquidation races.
   */
  nearHealthFactor?: number;
  /** Multicall batch size for getUserAccountData (default 100 with paid RPCs). */
  hfBatchSize?: number;
  /** Concurrent multicall shards across the paid read pool (default = pool size or 4). */
  hfConcurrency?: number;
  /** Safety margin above 1e18 to start evaluating — avoids wasting RPC calls on nearly-healthy accounts */
  minHealthFactorBuffer?: bigint;
  /** Slippage tolerance for DEX swaps in bps (default: 100 = 1%) */
  slippageBps?: number;
  /** Token addresses to skip during liquidation (blacklisted/depegged assets) */
  tokenBlacklist?: Address[];
}

export type ChainConfig = Omit<Config, "options"> &
  Options & {
    chainId: number;
    rpcUrl: string;
    executorAddress: Address;
    liquidationPrivateKey: Hex;
  };
