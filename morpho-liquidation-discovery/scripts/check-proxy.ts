/**
 * 掃描指定鏈上常見代幣的 EIP-1967 proxy slot
 * 輸出哪些是代理合約，方便整理白名單
 *
 * 用法: npx tsx scripts/check-proxy.ts
 */

import "dotenv/config";
import { createPublicClient, http, type Chain } from "viem";
import { base, mainnet, arbitrum } from "viem/chains";

type ChainEntry = { chain: Chain; name: string };

const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

// Morpho Blue 各鏈常見代幣（loan/collateral 高頻出現的）
const TOKENS: Record<number, { symbol: string; address: string }[]> = {
  8453: [
    { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdAF62C3" }, // placeholder, will fill below
    { symbol: "USDbC", address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" },
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006" },
    { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
    { symbol: "WSTETH", address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" },
    { symbol: "AERO", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" },
    { symbol: "weETH", address: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A" },
    { symbol: "ezETH", address: "0x2416092f143378750bb29b79eD961ab195CcEea5" },
    { symbol: "rETH", address: "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c" },
    { symbol: "USDS", address: "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc" },
    { symbol: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" },
  ],
  1: [
    { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
    { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
    { symbol: "WSTETH", address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" },
    { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
    { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" },
    { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" },
    { symbol: "weETH", address: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee" },
    { symbol: "ezETH", address: "0xbf5495Efe5DB9ce00f80364C8B423567e58d2110" },
    { symbol: "rETH", address: "0xae78736Cd615f374D3085123A210448E74Fc6393" },
    { symbol: "cbETH", address: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704" },
  ],
  42161: [
    { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
    { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" },
    { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" },
    { symbol: "WSTETH", address: "0x5979D7b546E38E414F7E9822514be443A4800529" },
    { symbol: "ARB", address: "0x912CE59144191C1204e64559FE8253a0e49E6548" },
    { symbol: "WBTC", address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" },
    { symbol: "weETH", address: "0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe" },
  ],
};

const CHAIN_MAP: Record<number, ChainEntry> = {
  [base.id]: { chain: base, name: "Base" },
  [mainnet.id]: { chain: mainnet, name: "Ethereum" },
  [arbitrum.id]: { chain: arbitrum, name: "Arbitrum" },
};

async function checkProxy(
  client: { getStorageAt: (args: { address: `0x${string}`; slot: `0x${string}` }) => Promise<`0x${string}` | undefined> },
  address: string,
): Promise<boolean> {
  try {
    const val = await client.getStorageAt({
      address: address as `0x${string}`,
      slot: EIP1967_IMPL_SLOT,
    });
    return !!val && val !== "0x" + "0".repeat(64);
  } catch {
    return false;
  }
}

async function main() {
  for (const [chainIdStr, tokens] of Object.entries(TOKENS)) {
    const chainId = Number(chainIdStr);
    const chainInfo = CHAIN_MAP[chainId];
    if (!chainInfo) continue;

    const rpcUrl = process.env[`RPC_URL_${chainInfo.name.toUpperCase()}`];
    if (!rpcUrl) {
      console.log(`\n⚠️  ${chainInfo.name}: 沒有 RPC_URL，跳過`);
      continue;
    }

    const client = createPublicClient({
      chain: chainInfo.chain,
      transport: http(rpcUrl),
    });

    console.log(`\n=== ${chainInfo.name} (chainId=${chainId}) ===`);

    for (const token of tokens) {
      const isProxy = await checkProxy(client, token.address);
      const tag = isProxy ? "🔵 PROXY" : "⚪ 非代理";
      console.log(`  ${tag}  ${token.symbol.padEnd(8)} ${token.address}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
