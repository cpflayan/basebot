/**
 * Residual ops fixes (#1 Moonwell error scope, #2 Comet no-debt, #3 soft empty revert,
 * #4 DP fallback address, #5 SimExecResult outcomes).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AAVE_V3_PROTOCOL_DATA_PROVIDER,
  resolveAaveProtocolDataProvider,
  AAVE_V3_POOL_ADDRESSES,
} from "../../src/abis/AaveV3.js";
import { classifyLiquidationFailure } from "../../src/utils/cooldownMechanisms.js";

describe("#1 Moonwell accountError scoping", () => {
  it("liquidateAccount uses local accountError, not sticky _lastError for cooldown", () => {
    const src = readFileSync(resolve(process.cwd(), "apps/client/src/moonwellBot.ts"), "utf8");
    expect(src).toContain("let accountError: string | undefined");
    expect(src).toContain("if (accountError)");
    expect(src).toContain("this.armCooldownFromError(account, accountError)");
    // must not arm from bare this._lastError after exhaust
    expect(src).not.toMatch(
      /All borrow positions exhausted[\s\S]{0,200}if \(this\._lastError\) \{\s*this\.armCooldownFromError\(account, this\._lastError\)/,
    );
  });
});

describe("#2 Comet debt==0 cooldown", () => {
  it("arms race cooldown when flashLoanAmount is 0", () => {
    const src = readFileSync(resolve(process.cwd(), "apps/client/src/cometBot.ts"), "utf8");
    expect(src).toMatch(/flashLoanAmount === 0n[\s\S]{0,200}armCooldown\([\s\S]{0,80}"race"/);
  });
});

describe("#3 soft empty-revert patterns", () => {
  it("returned no data is soft", () => {
    expect(classifyLiquidationFailure('returned no data ("0x")')).toBe("soft");
    expect(classifyLiquidationFailure("empty revert/return")).toBe("soft");
  });
});

describe("#4 Base ProtocolDataProvider static fallback", () => {
  it("matches live PoolDataProvider address", () => {
    expect(AAVE_V3_PROTOCOL_DATA_PROVIDER[8453]!.toLowerCase()).toBe(
      "0x0f43731eb8d45a581f4a36dd74f5f358bc90c73a",
    );
    const pool = AAVE_V3_POOL_ADDRESSES[8453]!;
    expect(resolveAaveProtocolDataProvider(pool, 8453)!.toLowerCase()).toBe(
      "0x0f43731eb8d45a581f4a36dd74f5f358bc90c73a",
    );
  });
});

describe("#5 SimExecResult outcomes", () => {
  it("sharedExecution exports structured fail reasons", () => {
    const src = readFileSync(
      resolve(process.cwd(), "apps/client/src/utils/sharedExecution.ts"),
      "utf8",
    );
    expect(src).toContain("export type SimExecResult");
    expect(src).toContain('simExecFail("sim_fail"');
    expect(src).toContain('simExecFail("profit_fail")');
    expect(src).toContain('simExecFail("slippage_fail"');
    expect(src).toContain('simExecFail("exec_revert"');
  });

  it("bots log reason instead of blanket not profitable", () => {
    for (const f of ["bot.ts", "cometBot.ts", "aaveBot.ts", "moonwellBot.ts"]) {
      const src = readFileSync(resolve(process.cwd(), `apps/client/src/${f}`), "utf8");
      expect(src).toContain("execResult.reason");
    }
  });
});
