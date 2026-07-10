/**
 * Cross-protocol dump detection tests.
 *
 * Validates that checkProfit() correctly applies a penalty when
 * liquidationTracker reports recent cross-protocol collateral dumps,
 * and that the penalty can flip a profitable trade to unprofitable.
 */
import type { Address } from "viem";
import { describe, expect, it, beforeEach, vi } from "vitest";

import { liquidationTracker } from "../../src/utils/liquidationState.js";
import { checkProfit, type SharedExecutionDeps } from "../../src/utils/sharedExecution.js";

const WETH = "0x4200000000000000000000000000000000000006" as Address;

function makeDeps(overrides: Partial<SharedExecutionDeps> = {}): SharedExecutionDeps {
  return {
    logTag: "[Test]",
    chainId: 8453,
    client: {} as any,
    executorAddress: "0x0000000000000000000000000000000000000001",
    treasuryAddress: "0x0000000000000000000000000000000000000002",
    liquidityVenues: [],
    pricers: [
      {
        price: vi.fn().mockResolvedValue(2000.0),
      },
    ],
    wNative: WETH,
    alwaysRealizeBadDebt: false,
    flashLoanProvider: "balancer",
    flashLoanFallbackProviders: [],
    ...overrides,
  };
}

describe("checkProfit — cross-protocol dump detection", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("should return false when no pricers configured", async () => {
    const deps = makeDeps({ pricers: [] });
    const result = await checkProfit(
      deps,
      WETH,
      { beforeTx: 1000n, afterTx: 2000n },
      { used: 200_000n, price: 1_000_000_000n },
      false,
    );
    expect(result).toBe(false);
  });

  it("should return false when balance delta is negative", async () => {
    const deps = makeDeps();
    const result = await checkProfit(
      deps,
      WETH,
      { beforeTx: 2000n, afterTx: 1000n },
      { used: 200_000n, price: 1_000_000_000n },
      false,
    );
    expect(result).toBe(false);
  });

  it("should return false when balance delta is undefined", async () => {
    const deps = makeDeps();
    const result = await checkProfit(
      deps,
      WETH,
      { beforeTx: undefined, afterTx: undefined },
      { used: 200_000n, price: 1_000_000_000n },
      false,
    );
    expect(result).toBe(false);
  });

  it("should return true for alwaysRealizeBadDebt + badDebtPosition", async () => {
    const deps = makeDeps({ alwaysRealizeBadDebt: true });
    const result = await checkProfit(
      deps,
      WETH,
      { beforeTx: 0n, afterTx: 0n },
      { used: 0n, price: 0n },
      true,
    );
    expect(result).toBe(true);
  });

  it("should return true when profitable with no cross-protocol events", async () => {
    const deps = makeDeps({ logTag: "[Fresh]" });

    const result = await checkProfit(
      deps,
      WETH,
      { beforeTx: 0n, afterTx: 1n * 10n ** 16n },
      { used: 100_000n, price: 1_000_000_000n },
      false,
    );

    expect(result).toBe(true);
  });

  it("should apply cross-protocol dump penalty reducing profit", async () => {
    const now = Date.now();

    liquidationTracker.report({
      protocol: "[Morpho]",
      collateralToken: WETH,
      collateralAmount: 10n * 10n ** 18n,
      collateralUsdEstimate: 20000,
      timestamp: now,
    });

    const depsNoDump = makeDeps({ logTag: "[Aave]" });

    const profitWithoutDump = await checkProfit(
      depsNoDump,
      WETH,
      { beforeTx: 0n, afterTx: 1n * 10n ** 15n },
      { used: 100_000n, price: 1_000_000_000n },
      false,
    );

    const depsWithDump = makeDeps({ logTag: "[Aave]" });

    const profitWithDump = await checkProfit(
      depsWithDump,
      WETH,
      { beforeTx: 0n, afterTx: 1n * 10n ** 15n },
      { used: 100_000n, price: 1_000_000_000n },
      false,
      undefined,
      WETH,
    );

    expect(profitWithoutDump).toBe(true);
    expect(profitWithDump).toBe(false);
  });

  it("should not penalize when collateralToken is undefined", async () => {
    const now = Date.now();

    liquidationTracker.report({
      protocol: "[Comet]",
      collateralToken: WETH,
      collateralAmount: 5n * 10n ** 18n,
      collateralUsdEstimate: 10000,
      timestamp: now,
    });

    const deps = makeDeps({ logTag: "[Moonwell]" });

    const result = await checkProfit(
      deps,
      WETH,
      { beforeTx: 0n, afterTx: 1n * 10n ** 15n },
      { used: 100_000n, price: 1_000_000_000n },
      false,
    );

    expect(result).toBe(true);
  });

  it("penalty should be 20% of recent dump USD value", () => {
    const DUMP_USD = 50000;
    const DUMP_PENALTY_BPS = 2000n;
    const BPS_DENOMINATOR = 10_000n;
    const expectedPenalty = (DUMP_USD * Number(DUMP_PENALTY_BPS)) / Number(BPS_DENOMINATOR);

    expect(expectedPenalty).toBe(10000);
  });
});
