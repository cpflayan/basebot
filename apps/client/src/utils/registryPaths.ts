/**
 * Shared paths for protocol account registries (Aave / Comet / Moonwell) and related caches.
 *
 * Priority for data directory:
 *   1. ACCOUNT_REGISTRY_DIR
 *   2. REGISTRY_DATA_DIR
 *   3. DATA_DIR
 *   4. ./data (relative to process.cwd())
 *
 * On Docker/Railway, mount a volume at /app/data and set ACCOUNT_REGISTRY_DIR=/app/data
 * so checkpoints survive restarts (do not rely on image layers alone).
 */
import fs from "node:fs";
import path from "node:path";

export function resolveRegistryDataDir(): string {
  const fromEnv =
    process.env.ACCOUNT_REGISTRY_DIR?.trim() ||
    process.env.REGISTRY_DATA_DIR?.trim() ||
    process.env.DATA_DIR?.trim();
  const dir = fromEnv ? path.resolve(fromEnv) : path.resolve(process.cwd(), "data");
  return dir;
}

/** Absolute path for e.g. `aave-accounts.8453.json` under the registry data dir. */
export function resolveAccountRegistryPath(fileName: string): string {
  return path.join(resolveRegistryDataDir(), fileName);
}

/** Ensure the registry data directory exists (mkdir -p). */
export function ensureRegistryDataDir(): string {
  const dir = resolveRegistryDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** True when any paid/private Base (or generic) RPC env is set — used for scan pacing defaults. */
export function hasPaidRpcConfigured(): boolean {
  return Boolean(
    process.env.RPC_URL_BASE?.trim() ||
      process.env.RPC_URL_8453?.trim() ||
      process.env.RPC_URL_BASE2?.trim() ||
      process.env.RPC_URL_BASE3?.trim() ||
      process.env.RPC_URL_BASE4?.trim() ||
      process.env.RPC_URL_BASE5?.trim() ||
      process.env.RPC_URL_BASE6?.trim() ||
      process.env.RPC_URL_BASE7?.trim(),
  );
}
