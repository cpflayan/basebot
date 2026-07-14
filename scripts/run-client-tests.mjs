#!/usr/bin/env node
/**
 * Run client tests filtered by chain.
 *
 * Usage:
 *   node scripts/run-client-tests.mjs                  # all client tests
 *   node scripts/run-client-tests.mjs --chainId 8453    # Base only
 *   node scripts/run-client-tests.mjs --chainId 1       # Ethereum mainnet fork tests
 *   pnpm test:client -- --chainId 8453
 *   pnpm test:client:base
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Pure unit tests (no chain fork). Always included when filtering by chain. */
const UNIT = [
  "apps/client/test/vitest/aaveBot.test.ts",
  "apps/client/test/vitest/health.test.ts",
  "apps/client/test/vitest/liquidationState.test.ts",
  "apps/client/test/vitest/crossProtocol.test.ts",
  "apps/client/test/vitest/execution/cacheLiquidation.test.ts",
  "apps/client/test/vitest/execution/cacheLiquidation.realData.test.ts",
];

/** Chain-specific (anvil fork) tests. */
const BY_CHAIN = {
  8453: [
    "apps/client/test/vitest/allBots.fork.test.ts",
    "apps/client/test/vitest/aaveBot.fork.test.ts",
    "apps/client/test/vitest/realChainData.fork.test.ts",
    "apps/client/test/vitest/execution/flashLoanLiquidation.test.ts",
  ],
  1: [
    "apps/client/test/vitest/deployExecutor.test.ts",
    "apps/client/test/vitest/execution/liquidation.test.ts",
    "apps/client/test/vitest/execution/preLiquidation.test.ts",
  ],
};

function parseArgs(argv) {
  // Strip bare `--` left by `pnpm run script -- --chainId X`
  const args = argv.filter((a) => a !== "--");
  let chainId;
  const passthrough = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--chainId" || a === "--chain-id") {
      const raw = args[++i];
      chainId = Number(raw);
      if (!Number.isFinite(chainId)) {
        console.error(`Invalid --chainId value: ${raw}`);
        process.exit(1);
      }
    } else if (a.startsWith("--chainId=") || a.startsWith("--chain-id=")) {
      chainId = Number(a.split("=")[1]);
      if (!Number.isFinite(chainId)) {
        console.error(`Invalid --chainId value: ${a}`);
        process.exit(1);
      }
    } else {
      passthrough.push(a);
    }
  }

  return { chainId, passthrough };
}

const { chainId, passthrough } = parseArgs(process.argv.slice(2));

/** @type {string[]} */
let vitestArgs;

if (chainId === undefined) {
  console.log("[test:client] chainId=all (unit + Base + mainnet forks)");
  vitestArgs = ["run", "--dir", "apps/client", ...passthrough];
} else if (BY_CHAIN[chainId]) {
  const files = [...UNIT, ...BY_CHAIN[chainId]];
  console.log(
    `[test:client] chainId=${chainId} → ${files.length} files (unit + chain forks)`,
  );
  for (const f of files) console.log(`  - ${f}`);
  vitestArgs = ["run", ...files, ...passthrough];
} else {
  console.error(
    `Unsupported --chainId ${chainId}. Supported: ${Object.keys(BY_CHAIN).join(", ")} (or omit for all).`,
  );
  process.exit(1);
}

const result = spawnSync("pnpm", ["exec", "vitest", ...vitestArgs], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    // Hint for any future test that wants to read it
    TEST_CHAIN_ID: chainId !== undefined ? String(chainId) : process.env.TEST_CHAIN_ID ?? "",
  },
});

process.exit(result.status ?? 1);
