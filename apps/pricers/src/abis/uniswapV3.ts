// Re-export from liquidity-venues to avoid ABI duplication.
// Both packages share the same UniswapV3 ABI definitions.
export {
  uniswapV3FactoryAbi,
  uniswapV3PoolAbi,
} from "@morpho-blue-liquidation-bot/liquidity-venues";
