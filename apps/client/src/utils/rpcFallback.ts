import {
  createPublicClient,
  fallback,
  http,
  type Chain,
  type Client,
  type PublicClient,
  type Transport,
} from "viem";

/**
 * RPC fallback manager — tries primary RPC first, falls back to alternatives.
 */
export class RPCFallbackManager {
  private rpcUrls: string[];
  private currentIndex = 0;
  private failureCounts: number[];
  private readonly maxFailures = 3;

  constructor(rpcUrls: string[]) {
    this.rpcUrls = rpcUrls;
    this.failureCounts = new Array(rpcUrls.length).fill(0);
  }

  /**
   * Get the current best RPC URL, skipping endpoints with too many failures.
   */
  getUrl(): string {
    // Find the first URL with failures < maxFailures
    for (let i = 0; i < this.rpcUrls.length; i++) {
      const idx = (this.currentIndex + i) % this.rpcUrls.length;
      if (this.failureCounts[idx]! < this.maxFailures) {
        this.currentIndex = idx;
        return this.rpcUrls[idx]!;
      }
    }
    // All URLs exhausted, reset and try primary
    this.failureCounts.fill(0);
    return this.rpcUrls[0]!;
  }

  recordSuccess(): void {
    this.failureCounts[this.currentIndex] = 0;
  }

  recordFailure(): void {
    this.failureCounts[this.currentIndex] = (this.failureCounts[this.currentIndex] ?? 0) + 1;
    // Move to next url
    this.currentIndex = (this.currentIndex + 1) % this.rpcUrls.length;
  }
}

/**
 * Create a scan client with fallback RPC support.
 * BUGFIX: previously only ever used rpcUrls[0] and silently discarded the rest,
 * despite the name/docstring implying fallback across the whole list. Now uses
 * viem's `fallback()` transport so if the primary RPC errors (e.g. rate limit),
 * later calls automatically move on to the next URL in the list.
 */
export function createScanClient(chain: Chain, rpcUrls: string[]): Client<Transport, Chain> {
  const urls = rpcUrls.length > 0 ? rpcUrls : ["https://mainnet.base.org"];
  const transports = urls.map((url) => http(url, { retryCount: 2, retryDelay: 500 }));
  return createPublicClient({
    chain,
    transport: transports.length > 1 ? fallback(transports, { rank: false }) : transports[0]!,
  });
}

// ─── Read client pool (round-robin + health tracking) ───

interface PoolEntry {
  label: string;
  client: PublicClient;
  failures: number;
  unhealthyUntil: number;
}

export interface ReadClientPoolConfig {
  entries: { label: string; url: string }[];
  chain: Chain;
  maxFailures?: number;
  cooldownMs?: number;
  retryCount?: number;
}

export class ReadClientPool {
  private entries: PoolEntry[];
  private cursor = 0;
  private readonly maxFailures: number;
  private readonly cooldownMs: number;
  private readonly retryCount: number;

  constructor(config: ReadClientPoolConfig) {
    this.maxFailures = config.maxFailures ?? 3;
    this.cooldownMs = config.cooldownMs ?? 30_000;
    this.retryCount = config.retryCount ?? 3;
    this.entries = config.entries.map((e) => ({
      label: e.label,
      client: createPublicClient({
        chain: config.chain,
        transport: http(e.url, { retryCount: this.retryCount }),
      }),
      failures: 0,
      unhealthyUntil: 0,
    }));
  }

  get size(): number {
    return this.entries.length;
  }

  next(): PublicClient {
    const now = Date.now();
    const total = this.entries.length;

    for (let i = 0; i < total; i++) {
      const idx = (this.cursor + i) % total;
      const entry = this.entries[idx]!;

      if (entry.unhealthyUntil > now) continue;

      this.cursor = (idx + 1) % total;
      return entry.client;
    }

    const entry = this.entries[this.cursor % total]!;
    console.warn(`[ReadClientPool] all endpoints unhealthy, forcing ${entry.label}`);
    entry.unhealthyUntil = 0;
    entry.failures = 0;
    this.cursor = (this.cursor + 1) % total;
    return entry.client;
  }

  nextWithLabel(): { client: PublicClient; label: string } {
    const now = Date.now();
    const total = this.entries.length;

    for (let i = 0; i < total; i++) {
      const idx = (this.cursor + i) % total;
      const entry = this.entries[idx]!;

      if (entry.unhealthyUntil > now) continue;

      this.cursor = (idx + 1) % total;
      return { client: entry.client, label: entry.label };
    }

    const entry = this.entries[this.cursor % total]!;
    console.warn(`[ReadClientPool] all endpoints unhealthy, forcing ${entry.label}`);
    entry.unhealthyUntil = 0;
    entry.failures = 0;
    this.cursor = (this.cursor + 1) % total;
    return { client: entry.client, label: entry.label };
  }

  recordSuccess(label: string): void {
    const entry = this.entries.find((e) => e.label === label);
    if (entry) {
      entry.failures = 0;
    }
  }

  recordFailure(label: string): void {
    const entry = this.entries.find((e) => e.label === label);
    if (!entry) return;
    entry.failures++;
    if (entry.failures >= this.maxFailures) {
      entry.unhealthyUntil = Date.now() + this.cooldownMs;
      console.warn(
        `[ReadClientPool] ${label} marked unhealthy for ${this.cooldownMs / 1000}s (${entry.failures} failures)`,
      );
    }
  }
}
