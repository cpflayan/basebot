/**
 * Offline Aave V3 account backfill — run once (or periodically), then the bot only does incremental scans.
 *
 * Sources:
 *   subgraph  — The Graph Aave protocol subgraph (borrowers with debt only; needs THEGRAPH_API_KEY)
 *   rpc       — eth_getLogs via AaveAccountRegistry (full history from deploy block)
 *   auto      — subgraph if configured, else rpc
 *
 * Usage:
 *   pnpm backfill:aave
 *   pnpm backfill:aave -- --chain 8453 --source subgraph
 *   pnpm backfill:aave -- --source rpc --from-block 2357134
 *
 * Env:
 *   THEGRAPH_API_KEY / AAVE_SUBGRAPH_URL — subgraph access
 *   RPC_URL_BASE / RPC_URL_BASE2..7 / scanRpcUrls — RPC backfill
 *   AAVE_SCAN_BATCH_SIZE / AAVE_SCAN_DELAY_MS — RPC pacing
 */
import "dotenv/config";

import { chainConfigs } from "@morpho-blue-liquidation-bot/config";
import { createPublicClient, http, type Address, type Chain } from "viem";
import { getBlockNumber } from "viem/actions";
import { base, mainnet } from "viem/chains";

import { AaveAccountRegistry } from "./aaveAccountRegistry.js";
import { AAVE_V3_POOL_ADDRESSES } from "./abis/AaveV3.js";
import { canUseAaveSubgraph, fetchAaveBorrowersFromSubgraph } from "./utils/aaveAccountSources.js";
import { ensureRegistryDataDir, resolveAccountRegistryPath } from "./utils/registryPaths.js";
import { createScanClient } from "./utils/rpcFallback.js";

type Source = "auto" | "subgraph" | "rpc";

function parseArgs(argv: string[]) {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const chainId = Number(get("--chain") ?? process.env.AAVE_BACKFILL_CHAIN ?? "8453");
  const source = (get("--source") ?? process.env.AAVE_BACKFILL_SOURCE ?? "auto") as Source;
  const fromBlock = get("--from-block") ? Number(get("--from-block")) : undefined;
  const toBlock = get("--to-block") ? Number(get("--to-block")) : undefined;
  const out =
    get("--out") ??
    process.env.AAVE_REGISTRY_PATH ??
    resolveAccountRegistryPath(`aave-accounts.${chainId}.json`);
  const replace = argv.includes("--replace");
  return { chainId, source, fromBlock, toBlock, out, replace };
}

function viemChain(chainId: number): Chain {
  if (chainId === 8453) return base;
  if (chainId === 1) return mainnet;
  throw new Error(`Unsupported chainId ${chainId} for Aave backfill (supported: 1, 8453)`);
}

function resolvePoolAndDeploy(chainId: number): { pool: Address; deployBlock: number } {
  const cfg = chainConfigs[chainId] as
    | { options?: { aaveWatchlist?: { poolAddress?: Address; poolDeployBlock?: number } } }
    | undefined;
  const wl = cfg?.options?.aaveWatchlist;
  const pool = wl?.poolAddress ?? AAVE_V3_POOL_ADDRESSES[chainId];
  const deployBlock = wl?.poolDeployBlock ?? (chainId === 8453 ? 2_357_134 : 16_291_127);
  if (!pool) throw new Error(`No Aave pool address for chain ${chainId}`);
  return { pool, deployBlock };
}

function resolveRpcUrls(chainId: number): string[] {
  const cfg = chainConfigs[chainId] as { options?: { scanRpcUrls?: string[] } } | undefined;
  const fromConfig = (cfg?.options?.scanRpcUrls ?? []).filter(Boolean);
  const envRpc =
    chainId === 8453 ? process.env.RPC_URL_BASE : chainId === 1 ? process.env.RPC_URL_1 : undefined;
  const urls = [
    envRpc,
    ...fromConfig,
    chainId === 8453 ? "https://mainnet.base.org" : "https://ethereum.publicnode.com",
  ].filter((u): u is string => Boolean(u));
  return [...new Set(urls)];
}

async function backfillFromSubgraph(
  registry: AaveAccountRegistry,
  chainId: number,
  pool: Address,
  replace: boolean,
): Promise<void> {
  console.log(`[backfill] source=subgraph chain=${chainId}`);
  const result = await fetchAaveBorrowersFromSubgraph(chainId, { logTag: "[backfill] " });
  console.log(
    `[backfill] subgraph returned ${result.accounts.length} borrowers @ block ${result.blockNumber} (${result.sourceUrl})`,
  );

  if (replace) {
    // Drop prior accounts for this pool so pure liquidators / suppliers from old RPC scans vanish.
    const existing = registry.getAccounts(pool);
    for (const a of existing) registry.removeAccount(pool, a);
    console.log(`[backfill] --replace: cleared ${existing.length} existing accounts for pool`);
  }

  const added = registry.importAccounts(pool, result.accounts);
  const checkpoint = result.blockNumber > 0 ? result.blockNumber : undefined;
  if (checkpoint === undefined) {
    throw new Error("Subgraph response missing _meta.block.number");
  }
  registry.markSynced(pool, checkpoint);
  registry.saveToFile();
  console.log(
    `[backfill] saved: +${added} new (total ${registry.totalAccounts}), checkpoint=${checkpoint}`,
  );
}

async function backfillFromRpc(
  registry: AaveAccountRegistry,
  chainId: number,
  pool: Address,
  deployBlock: number,
  fromBlock: number | undefined,
  toBlock: number | undefined,
): Promise<void> {
  const chain = viemChain(chainId);
  const rpcUrls = resolveRpcUrls(chainId);
  console.log(`[backfill] source=rpc chain=${chainId} rpcs=${rpcUrls.length}`);

  const scanClient = createScanClient(chain, rpcUrls);
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrls[0]),
  });

  // If caller wants a custom window, temporarily seed checkpoint so initialScan resumes there.
  if (fromBlock !== undefined) {
    const seed = Math.max(0, fromBlock - 1);
    registry.markSynced(pool, seed);
    console.log(`[backfill] seeded resume cursor to ${seed} (--from-block ${fromBlock})`);
  }

  if (toBlock !== undefined) {
    // initialScan always scans to chain tip — for capped runs, scan via mark + loop would need
    // a custom path; keep it simple: warn and scan to tip, or stop early by env.
    console.log(
      `[backfill] note: --to-block ${toBlock} is advisory; RPC path scans to chain tip via initialScan`,
    );
  }

  const tip = Number(await getBlockNumber(publicClient));
  console.log(
    `[backfill] RPC scan pool=${pool} deploy=${deployBlock} tip=${tip} (batch=${process.env.AAVE_SCAN_BATCH_SIZE ?? 100})`,
  );

  await registry.initialScan(publicClient, pool, deployBlock, "[backfill] ", scanClient);
  console.log(`[backfill] RPC complete: ${registry.totalAccounts} accounts`);
}

async function main() {
  const { chainId, source, fromBlock, toBlock, out, replace } = parseArgs(process.argv.slice(2));
  const { pool, deployBlock } = resolvePoolAndDeploy(chainId);

  ensureRegistryDataDir();
  console.log("=== Aave V3 account backfill ===");
  console.log(`chain=${chainId} pool=${pool} out=${out} source=${source} replace=${replace}`);

  const registry = new AaveAccountRegistry(out);
  if (!replace) {
    registry.loadFromFile();
  }

  let mode: "subgraph" | "rpc";
  if (source === "subgraph") {
    mode = "subgraph";
  } else if (source === "rpc") {
    mode = "rpc";
  } else {
    mode = canUseAaveSubgraph(chainId) ? "subgraph" : "rpc";
    console.log(
      `[backfill] auto → ${mode}` +
        (mode === "rpc" ? " (set THEGRAPH_API_KEY or AAVE_SUBGRAPH_URL to prefer subgraph)" : ""),
    );
  }

  if (mode === "subgraph") {
    if (!canUseAaveSubgraph(chainId) && !process.env.AAVE_SUBGRAPH_URL) {
      throw new Error(
        "source=subgraph requires THEGRAPH_API_KEY or AAVE_SUBGRAPH_URL (see aaveAccountSources.ts)",
      );
    }
    await backfillFromSubgraph(registry, chainId, pool, replace);
  } else {
    await backfillFromRpc(registry, chainId, pool, deployBlock, fromBlock, toBlock);
  }

  const last = registry.getLastScannedBlock(pool);
  console.log(
    `[backfill] done. accounts=${registry.totalAccounts} lastScanned=${last ?? "n/a"} files:\n` +
      `  ${out}\n  ${out.replace(/\.json$/, ".checkpoint.json")}`,
  );
  console.log("[backfill] Bot will now only do incremental scans from this checkpoint.");
}

main().catch((e: unknown) => {
  console.error("[backfill] failed:", e);
  process.exit(1);
});
