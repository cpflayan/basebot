/**
 * LiquidationState — cross-protocol liquidation event tracking.
 *
 * Tracks recent liquidation events across all protocol bots (Morpho, Comet,
 * Moonwell, Aave) to detect cross-protocol collateral dump patterns.
 *
 * Used by checkProfit() to apply a conservative penalty when the same
 * collateral token was recently dumped by another protocol's liquidation,
 * which may have depressed DEX prices below what the simulation predicts.
 */

export interface LiquidationEvent {
  protocol: string;
  collateralToken: string;
  collateralAmount: bigint;
  collateralUsdEstimate: number;
  timestamp: number;
}

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const MAX_EVENTS = 200;

export class LiquidationStateTracker {
  private events: LiquidationEvent[] = [];
  private windowMs: number;

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  report(event: LiquidationEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
    this.cleanup();
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    const idx = this.events.findIndex((e) => e.timestamp >= cutoff);
    if (idx === -1) {
      this.events = [];
    } else if (idx > 0) {
      this.events = this.events.slice(idx);
    }
  }

  /**
   * Total amount of `token` recently dumped by protocols OTHER than `fromProtocol`.
   * Returns 0n if no cross-protocol dumps found.
   */
  getRecentDumpAmount(token: string, fromProtocol: string): bigint {
    this.cleanup();
    const normalized = token.toLowerCase();
    let total = 0n;
    for (const e of this.events) {
      if (e.protocol !== fromProtocol && e.collateralToken.toLowerCase() === normalized) {
        total += e.collateralAmount;
      }
    }
    return total;
  }

  /**
   * USD value of cross-protocol dumps for a given token.
   */
  getRecentDumpUsd(token: string, fromProtocol: string): number {
    this.cleanup();
    const normalized = token.toLowerCase();
    let total = 0;
    for (const e of this.events) {
      if (e.protocol !== fromProtocol && e.collateralToken.toLowerCase() === normalized) {
        total += e.collateralUsdEstimate;
      }
    }
    return total;
  }

  get recentEventCount(): number {
    this.cleanup();
    return this.events.length;
  }
}

export const liquidationTracker = new LiquidationStateTracker();
