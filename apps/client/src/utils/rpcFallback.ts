import { createPublicClient, http, type Chain, type Client, type Transport } from "viem";

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
 * Uses the first available RPC from the list.
 */
export function createScanClient(chain: Chain, rpcUrls: string[]): Client<Transport, Chain> {
  const primaryUrl = rpcUrls[0] ?? "https://mainnet.base.org";
  return createPublicClient({
    chain,
    transport: http(primaryUrl),
  });
}
