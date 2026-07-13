/**
 * RPC budget helpers — tune for "fewer 429s, race path mostly intact".
 *
 * Env (all optional; **env wins over config** when set):
 *   HF_CONCURRENCY          max parallel multicall shards (default: min(3, poolSize))
 *   HF_BATCH_SIZE           accounts per multicall (default 100)
 *   RPC_WAVE_GAP_MS         pause between multicall waves (default 40)
 *   SKIP_ROUTE_WARM=1       skip DEX route warm-up at startup
 *   ROUTE_WARM_MAX_MAJORS   max tokens for Aave/Moonwell warm fan-out (default 6)
 *   AAVE_FULL_SCAN_INTERVAL_BLOCKS  override full-registry cadence
 *   AAVE_NEAR_HEALTH_FACTOR         override hot-set threshold (e.g. 1.05)
 */

/** Prefer env when set, else config/default — for ops tuning without rebuild. */
export function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Cap concurrent eth_call waves — 7-way fanout to one provider family causes 429s. */
export function defaultHfConcurrency(poolSize: number, configValue?: number): number {
  const fromEnv = envNumber("HF_CONCURRENCY");
  if (fromEnv !== undefined && fromEnv > 0) {
    return Math.max(1, Math.floor(fromEnv));
  }
  if (configValue !== undefined && configValue > 0) {
    return Math.max(1, Math.floor(configValue));
  }
  const size = Math.max(1, poolSize || 1);
  return Math.min(3, size);
}

export function defaultHfBatchSize(fallback = 100, configValue?: number): number {
  const fromEnv = envNumber("HF_BATCH_SIZE");
  if (fromEnv !== undefined && fromEnv > 0) return Math.floor(fromEnv);
  if (configValue !== undefined && configValue > 0) return Math.floor(configValue);
  return fallback;
}

/** Small gap between multicall waves to smooth rate limits without killing race. */
export function rpcWaveGapMs(): number {
  const fromEnv = envNumber("RPC_WAVE_GAP_MS");
  if (fromEnv !== undefined && fromEnv >= 0) return Math.floor(fromEnv);
  return 40;
}

export function shouldWarmRoutes(): boolean {
  const v = process.env.SKIP_ROUTE_WARM?.trim().toLowerCase();
  return v !== "1" && v !== "true" && v !== "yes";
}

export function routeWarmMaxMajors(fallback = 6): number {
  const fromEnv = envNumber("ROUTE_WARM_MAX_MAJORS");
  if (fromEnv !== undefined && fromEnv > 0) return Math.floor(fromEnv);
  return fallback;
}

/** Full-registry cadence: env > config > default 15. */
export function resolveAaveFullScanInterval(configValue?: number): number {
  const fromEnv = envNumber("AAVE_FULL_SCAN_INTERVAL_BLOCKS");
  if (fromEnv !== undefined && fromEnv > 0) return Math.floor(fromEnv);
  if (configValue !== undefined && configValue > 0) return Math.floor(configValue);
  return 15;
}

/** Hot-set HF threshold (float, e.g. 1.05): env > config > default. */
export function resolveAaveNearHealthFactor(configValue?: number): number {
  const fromEnv = envNumber("AAVE_NEAR_HEALTH_FACTOR");
  if (fromEnv !== undefined && fromEnv > 0) return fromEnv;
  if (configValue !== undefined && configValue > 0) return configValue;
  return 1.05;
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}
