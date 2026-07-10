/**
 * LiquidationStateTracker unit tests.
 *
 * Tests the shared cross-protocol liquidation event tracker:
 *   - Event reporting and retrieval
 *   - Time-window cleanup (15 min rolling window)
 *   - Cross-protocol filtering (excludes same-protocol events)
 *   - USD aggregation
 *   - Max events cap
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

import { LiquidationStateTracker } from "../../src/utils/liquidationState.js";

const WETH = "0x4200000000000000000000000000000000000006";
const CBETH = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

describe("LiquidationStateTracker", () => {
  let tracker: LiquidationStateTracker;

  beforeEach(() => {
    vi.useRealTimers();
    tracker = new LiquidationStateTracker();
  });

  // ─── Basic reporting ───

  it("should start with zero events", () => {
    expect(tracker.recentEventCount).toBe(0);
  });

  it("should report and count events", () => {
    tracker.report({
      protocol: "[Morpho]",
      collateralToken: WETH,
      collateralAmount: 5n * 10n ** 18n,
      collateralUsdEstimate: 10000,
      timestamp: Date.now(),
    });

    expect(tracker.recentEventCount).toBe(1);
  });

  // ─── Cross-protocol filtering ───

  it("should return dump amount only from OTHER protocols", () => {
    const now = Date.now();

    tracker.report({
      protocol: "[Morpho]",
      collateralToken: CBETH,
      collateralAmount: 3n * 10n ** 18n,
      collateralUsdEstimate: 6000,
      timestamp: now,
    });

    tracker.report({
      protocol: "[Aave]",
      collateralToken: CBETH,
      collateralAmount: 2n * 10n ** 18n,
      collateralUsdEstimate: 4000,
      timestamp: now,
    });

    const fromMorpho = tracker.getRecentDumpAmount(CBETH, "[Morpho]");
    expect(fromMorpho).toBe(2n * 10n ** 18n);

    const fromAave = tracker.getRecentDumpAmount(CBETH, "[Aave]");
    expect(fromAave).toBe(3n * 10n ** 18n);

    const fromComet = tracker.getRecentDumpAmount(CBETH, "[Comet]");
    expect(fromComet).toBe(5n * 10n ** 18n);
  });

  it("should return 0n for tokens with no recent dumps", () => {
    const amount = tracker.getRecentDumpAmount(USDC, "[Morpho]");
    expect(amount).toBe(0n);
  });

  // ─── USD aggregation ───

  it("should aggregate USD estimates across protocols", () => {
    const now = Date.now();

    tracker.report({
      protocol: "[Moonwell]",
      collateralToken: WETH,
      collateralAmount: 10n * 10n ** 18n,
      collateralUsdEstimate: 20000,
      timestamp: now,
    });

    tracker.report({
      protocol: "[Comet]",
      collateralToken: WETH,
      collateralAmount: 5n * 10n ** 18n,
      collateralUsdEstimate: 10000,
      timestamp: now,
    });

    const usdFromMorpho = tracker.getRecentDumpUsd(WETH, "[Morpho]");
    expect(usdFromMorpho).toBe(30000);
  });

  it("should return 0 USD for same-protocol events", () => {
    const now = Date.now();

    tracker.report({
      protocol: "[TestProto]",
      collateralToken: WETH,
      collateralAmount: 1n * 10n ** 18n,
      collateralUsdEstimate: 2000,
      timestamp: now,
    });

    const usd = tracker.getRecentDumpUsd(WETH, "[TestProto]");
    expect(usd).toBe(0);
  });

  // ─── Case-insensitive token matching ───

  it("should match tokens case-insensitively", () => {
    const now = Date.now();

    tracker.report({
      protocol: "[Morpho]",
      collateralToken: WETH.toLowerCase(),
      collateralAmount: 1n * 10n ** 18n,
      collateralUsdEstimate: 2000,
      timestamp: now,
    });

    const amount = tracker.getRecentDumpAmount(WETH.toUpperCase(), "[Aave]");
    expect(amount).toBe(1n * 10n ** 18n);
  });

  // ─── Time window cleanup ───

  it("should expire events outside the 15-minute window", () => {
    vi.useFakeTimers();
    const fakeNow = Date.now();
    vi.setSystemTime(fakeNow);

    tracker.report({
      protocol: "[OldProto]",
      collateralToken: USDC,
      collateralAmount: 100n * 10n ** 6n,
      collateralUsdEstimate: 100,
      timestamp: fakeNow,
    });

    const beforeExpiry = tracker.getRecentDumpAmount(USDC, "[Other]");
    expect(beforeExpiry).toBe(100n * 10n ** 6n);

    vi.setSystemTime(fakeNow + 16 * 60 * 1000);

    const afterExpiry = tracker.getRecentDumpAmount(USDC, "[Other]");
    expect(afterExpiry).toBe(0n);

    vi.useRealTimers();
  });

  it("should keep events within the window", () => {
    vi.useFakeTimers();
    const fakeNow = Date.now();
    vi.setSystemTime(fakeNow);

    tracker.report({
      protocol: "[RecentProto]",
      collateralToken: USDC,
      collateralAmount: 50n * 10n ** 6n,
      collateralUsdEstimate: 50,
      timestamp: fakeNow,
    });

    vi.setSystemTime(fakeNow + 10 * 60 * 1000);

    const withinWindow = tracker.getRecentDumpAmount(USDC, "[Other]");
    expect(withinWindow).toBe(50n * 10n ** 6n);

    vi.useRealTimers();
  });

  // ─── Max events cap ───

  it("should cap at 200 events", () => {
    const now = Date.now();
    for (let i = 0; i < 250; i++) {
      tracker.report({
        protocol: `[Proto${i}]`,
        collateralToken: WETH,
        collateralAmount: 1n,
        collateralUsdEstimate: 1,
        timestamp: now,
      });
    }
    expect(tracker.recentEventCount).toBe(200);
  });
});
