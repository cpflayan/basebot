/**
 * P0-1: Aerodrome must not treat swap(0,0) as success.
 * Unit-level checks on ABI surface (fork tests cover live convert when RPC available).
 */
import { describe, expect, it } from "vitest";

import { aerodromePoolAbi } from "../../src/abis/aerodrome.js";

describe("P0-1 Aerodrome pool ABI", () => {
  it("exposes getAmountOut for exact Solidly quotes", () => {
    const fn = aerodromePoolAbi.find((e) => e.type === "function" && e.name === "getAmountOut");
    expect(fn).toBeDefined();
    expect(fn!.inputs.map((i) => i.name)).toEqual(["amountIn", "tokenIn"]);
  });

  it("swap takes amount0Out and amount1Out (not optional)", () => {
    const swap = aerodromePoolAbi.find((e) => e.type === "function" && e.name === "swap");
    expect(swap).toBeDefined();
    expect(swap!.inputs[0]?.name).toBe("amount0Out");
    expect(swap!.inputs[1]?.name).toBe("amount1Out");
  });
});
