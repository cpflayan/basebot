/**
 * Moonwell Core Markets Scanner v2
 * Sequential reads with retry to avoid RPC rate limits.
 */
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const COMPTROLLER = "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C";

const comptrollerAbi = [
  { inputs: [], name: "getAllMarkets", outputs: [{ name: "", type: "address[]" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "oracle", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  {
    inputs: [{ name: "", type: "address" }],
    name: "markets",
    outputs: [
      { name: "isListed", type: "bool" },
      { name: "collateralFactorMantissa", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
];

const chainlinkOracleAbi = [
  { inputs: [{ name: "symbol", type: "string" }], name: "getFeed", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
];

const erc20Abi = [
  { inputs: [], name: "symbol", outputs: [{ name: "", type: "string" }], stateMutability: "view", type: "function" },
];

// OEV wrappers expose maxRoundDelay(); plain Chainlink aggregators and
// ChainlinkCompositeOracle instances do not. A successful call here is
// the on-chain signal, matching how Moonwell's own OEV docs describe
// verifying wrapper registration via ChainlinkOracle.getFeed().
const oevWrapperAbi = [
  { inputs: [], name: "maxRoundDelay", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
];

const mTokenAbi = [
  { inputs: [], name: "underlying", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "symbol", outputs: [{ name: "", type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ name: "", type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "totalBorrows", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "getCash", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "reserveFactorMantissa", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "protocolSeizeShareMantissa", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
];

async function safeRead(client, address, abi, fn, retries = 3, args = []) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await client.readContract({ address, abi, functionName: fn, args });
    } catch (e) {
      if (i === retries) return null;
      // exponential backoff: 300ms, 600ms, 1200ms...
      await new Promise(r => setTimeout(r, 300 * 2 ** i));
    }
  }
}

// Binary-search the contract creation block via eth_getCode, so deployBlock
// doesn't have to be filled in by hand for every market.
async function findDeployBlock(client, address, latestBlock) {
  const hasCode = async (blockNumber) => {
    const code = await client.getCode({ address, blockNumber });
    return code !== undefined && code !== "0x";
  };
  if (!(await hasCode(latestBlock))) return null; // shouldn't happen, but stay safe
  let lo = 0n, hi = latestBlock;
  // find any lower bound with no code first (cap search depth to avoid infinite loop on ancient chains)
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    if (await hasCode(mid)) hi = mid; else lo = mid + 1n;
  }
  return lo;
}

async function main() {
  const rpcUrl = process.env.RPC_URL || process.env.RPC_URL_8453 || "https://mainnet.base.org";
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

  console.log(`\n🔍 Moonwell Core Markets Scanner v2`);
  console.log(`   Comptroller: ${COMPTROLLER}`);
  console.log(`   RPC: ${rpcUrl}\n`);

  const markets = await client.readContract({ address: COMPTROLLER, abi: comptrollerAbi, functionName: "getAllMarkets" });
  console.log(`📋 Found ${markets.length} entries in getAllMarkets() — this includes delisted markets, filtering below\n`);

  const oracleAddress = await safeRead(client, COMPTROLLER, comptrollerAbi, "oracle");
  console.log(`🔮 ChainlinkOracle: ${oracleAddress ?? "? (failed to read — OEV classification will be skipped)"}\n`);

  const latestBlock = await client.getBlockNumber();

  const results = [];
  for (let i = 0; i < markets.length; i++) {
    const mToken = markets[i];
    process.stdout.write(`  [${i + 1}/${markets.length}] ${mToken} ... `);

    const [underlying, symbol, decimals, totalBorrows, cash, reserveFactor, protocolSeizeShare, marketInfo, deployBlock] = await Promise.all([
      safeRead(client, mToken, mTokenAbi, "underlying"),
      safeRead(client, mToken, mTokenAbi, "symbol"),
      safeRead(client, mToken, mTokenAbi, "decimals"),
      safeRead(client, mToken, mTokenAbi, "totalBorrows"),
      safeRead(client, mToken, mTokenAbi, "getCash"),
      safeRead(client, mToken, mTokenAbi, "reserveFactorMantissa"),
      safeRead(client, mToken, mTokenAbi, "protocolSeizeShareMantissa"),
      safeRead(client, COMPTROLLER, comptrollerAbi, "markets", 3, [mToken]),
      findDeployBlock(client, mToken, latestBlock),
    ]);

    // OEV classification: getFeed() takes the UNDERLYING ERC20's symbol, not the mToken's.
    // Native ETH markets have no `underlying` — skip classification for those.
    let oevStatus = "n/a";
    if (oracleAddress && underlying) {
      const underlyingSymbol = await safeRead(client, underlying, erc20Abi, "symbol");
      if (underlyingSymbol) {
        const feedAddress = await safeRead(client, oracleAddress, chainlinkOracleAbi, "getFeed", 3, [underlyingSymbol]);
        if (feedAddress) {
          const roundDelay = await safeRead(client, feedAddress, oevWrapperAbi, "maxRoundDelay", 1);
          oevStatus = roundDelay != null ? `🟢 OEV (wrapper=${feedAddress})` : `⚪ traditional (feed=${feedAddress})`;
        } else {
          oevStatus = "❓ no feed found";
        }
      }
    }

    const sym = symbol ?? "???";
    const dec = decimals ?? "?";
    const rf = reserveFactor != null ? `${(Number(reserveFactor) / 1e18 * 100).toFixed(1)}%` : "?";
    const pss = protocolSeizeShare != null ? `${(Number(protocolSeizeShare) / 1e18 * 100).toFixed(2)}%` : "?";
    const isListed = marketInfo ? marketInfo[0] : null;
    const cf = marketInfo != null ? `${(Number(marketInfo[1]) / 1e18 * 100).toFixed(1)}%` : "?";
    const hasBorrows = totalBorrows != null && totalBorrows > 0n ? "✅ BORROW" : "";
    const underlyingStr = underlying ?? "(no underlying — native?)";
    const listedFlag = isListed === false ? "⛔ DELISTED" : isListed === null ? "❓ unknown" : "";
    const collateralFlag = marketInfo != null && marketInfo[1] === 0n ? "🚫 not usable as collateral" : "";

    console.log(`${sym.padEnd(10)} dec=${dec} rf=${rf.padEnd(7)} cf=${cf.padEnd(7)} seizeShare=${pss.padEnd(7)} deployBlock=${deployBlock ?? "?"} underlying=${underlyingStr} ${hasBorrows} ${listedFlag} ${collateralFlag}\n      → ${oevStatus}`);

    results.push({ mToken, underlying, symbol: sym, decimals: dec, totalBorrows, cash, reserveFactor, protocolSeizeShare, isListed, collateralFactorMantissa: marketInfo ? marketInfo[1] : null, deployBlock, oevStatus });

    // Small delay between markets to avoid rate limiting
    if (i < markets.length - 1) await new Promise(r => setTimeout(r, 200));
  }

  const usableForCollateral = results.filter(r => r.isListed !== false && r.collateralFactorMantissa != null && r.collateralFactorMantissa > 0n);
  const delisted = results.filter(r => r.isListed === false);
  console.log(`\n🔎 Usable as collateral: ${usableForCollateral.length} / ${results.length}`);
  if (delisted.length > 0) {
    console.log(`⛔ Delisted (exclude from account scanning): ${delisted.map(r => r.symbol).join(", ")}`);
  }

  console.log("\n" + "═".repeat(80));
  console.log("🟢 OEV vs ⚪ TRADITIONAL BREAKDOWN");
  console.log("═".repeat(80));
  const oevMarkets = results.filter(r => r.oevStatus.startsWith("🟢"));
  const traditionalMarkets = results.filter(r => r.oevStatus.startsWith("⚪"));
  const unknownMarkets = results.filter(r => !r.oevStatus.startsWith("🟢") && !r.oevStatus.startsWith("⚪"));
  console.log(`🟢 OEV-wrapped: ${oevMarkets.map(r => r.symbol).join(", ") || "(none)"}`);
  console.log(`⚪ Traditional (plain/composite feed): ${traditionalMarkets.map(r => r.symbol).join(", ") || "(none)"}`);
  if (unknownMarkets.length > 0) {
    console.log(`❓ Could not classify: ${unknownMarkets.map(r => `${r.symbol} (${r.oevStatus})`).join(", ")}`);
  }

  // Config-ready output
  console.log("\n" + "═".repeat(80));
  console.log("📝 CONFIG-READY (config.ts moonwellWatchlist.mTokens)");
  console.log("═".repeat(80) + "\n");

  for (const r of results) {
    if (r.isListed === false) continue; // don't emit delisted markets into config
    const underlyingAddr = r.underlying ?? r.mToken; // fallback to mToken for native
    const comment = r.symbol !== "???" ? r.symbol : "unknown";
    const cfComment = r.collateralFactorMantissa != null ? `${(Number(r.collateralFactorMantissa) / 1e18 * 100).toFixed(1)}% CF` : "CF unknown";
    console.log(`          {`);
    console.log(`            address: "${r.mToken}", // ${comment} — ${cfComment}`);
    console.log(`            underlying: "${underlyingAddr}",`);
    console.log(`            deployBlock: ${r.deployBlock ?? "0, // TODO: verify — auto-discovery failed"},`);
    console.log(`          },`);
  }

  // Summary
  console.log("\n" + "═".repeat(80));
  console.log("📊 SUMMARY");
  console.log("═".repeat(80));
  console.log(`Total markets: ${results.length}`);

  const withBorrows = results.filter(r => r.totalBorrows != null && r.totalBorrows > 0n);
  console.log(`Markets with active borrows: ${withBorrows.length}`);
  for (const r of withBorrows) {
    console.log(`  ${r.symbol.padEnd(10)} borrows=${r.totalBorrows}`);
  }

  const newMarkets = results.filter(r => !["0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22", "0x628ff693426583D9a7FB391E54366292F509D457", "0xF877ACaFA28c19b96727966690b2f44d35aD5976"].includes(r.mToken));
  console.log(`\nMarkets NOT in current config: ${newMarkets.length}`);
  for (const r of newMarkets) {
    console.log(`  ${r.mToken}  ${r.symbol}`);
  }

  console.log("\n✅ Done\n");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
