/**
 * Unit tests for P0 audit fixes (no fork required).
 * Covers: Aave event ABI indexed flags, ProtocolDataProvider resolution,
 * Morpho Liquidate topic0 / decode, Comet totalsBasic field layout.
 */
import { encodeEventTopics, toEventSelector, encodeAbiParameters, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import {
  aaveEventAbi,
  AAVE_V3_POOL_ADDRESSES,
  resolveAaveProtocolDataProvider,
  AAVE_V3_PROTOCOL_DATA_PROVIDER,
} from "../../src/abis/AaveV3.js";
import { cometViewAbi } from "../../src/abis/Comet.js";
import { morphoBlueAbi } from "../../src/abis/morpho/morphoBlue.js";
import { decodeMorphoLog, MORPHO_EVENT_SIGNATURES } from "../../src/webhook.js";

describe("P0-2/P0-3 Aave ABI + DataProvider", () => {
  it("resolves Base ProtocolDataProvider for known Pool", () => {
    const pool = AAVE_V3_POOL_ADDRESSES[8453]!;
    const resolved = resolveAaveProtocolDataProvider(pool, 8453);
    expect(resolved).toBeDefined();
    expect(resolved).toBe(AAVE_V3_PROTOCOL_DATA_PROVIDER[8453]);
    expect(resolveAaveProtocolDataProvider(pool)).toBe(AAVE_V3_PROTOCOL_DATA_PROVIDER[8453]);
  });

  it("Supply event has user non-indexed and ≤3 indexed fields", () => {
    const supply = aaveEventAbi.find((e) => e.type === "event" && e.name === "Supply");
    expect(supply).toBeDefined();
    const inputs = supply!.inputs;
    expect(inputs.find((i) => i.name === "user")?.indexed).toBe(false);
    expect(inputs.filter((i) => i.indexed).length).toBeLessThanOrEqual(3);
  });

  it("Borrow event has user + interestRateMode non-indexed", () => {
    const borrow = aaveEventAbi.find((e) => e.type === "event" && e.name === "Borrow");
    expect(borrow).toBeDefined();
    const inputs = borrow!.inputs;
    expect(inputs.find((i) => i.name === "user")?.indexed).toBe(false);
    expect(inputs.find((i) => i.name === "interestRateMode")?.indexed).toBe(false);
    expect(inputs.filter((i) => i.indexed).length).toBeLessThanOrEqual(3);
  });

  it("Repay useATokens is non-indexed (official IPool)", () => {
    const repay = aaveEventAbi.find((e) => e.type === "event" && e.name === "Repay");
    expect(repay!.inputs.find((i) => i.name === "useATokens")?.indexed).toBe(false);
  });

  it("Supply topic0 matches encodeEventTopics from ABI", () => {
    const [topic0] = encodeEventTopics({ abi: aaveEventAbi, eventName: "Supply" });
    expect(topic0).toMatch(/^0x[0-9a-f]{64}$/i);
  });
});

describe("P0-4 Comet totalsBasic / borrowBalanceOf ABI", () => {
  it("totalsBasic has official 8-field order starting with baseSupplyIndex", () => {
    const totals = cometViewAbi.find((f) => f.type === "function" && f.name === "totalsBasic");
    expect(totals).toBeDefined();
    const names = totals!.outputs.map((o) => o.name);
    expect(names[0]).toBe("baseSupplyIndex");
    expect(names[1]).toBe("baseBorrowIndex");
    expect(names[4]).toBe("totalSupplyBase");
    expect(names[5]).toBe("totalBorrowBase");
    expect(names).toHaveLength(8);
  });

  it("borrowBalanceOf is present on view ABI", () => {
    const fn = cometViewAbi.find((f) => f.type === "function" && f.name === "borrowBalanceOf");
    expect(fn).toBeDefined();
  });
});

describe("P0-5 Morpho Liquidate webhook ABI", () => {
  const LIQUIDATE_SIG =
    "Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)";

  it("MORPHO_EVENT_SIGNATURES includes 5×uint256 Liquidate", () => {
    expect(MORPHO_EVENT_SIGNATURES).toContain(LIQUIDATE_SIG);
    expect(MORPHO_EVENT_SIGNATURES).not.toContain(
      "Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256)",
    );
  });

  it("webhook Liquidate topic0 matches morphoBlue.ts", () => {
    const fromSig = toEventSelector(LIQUIDATE_SIG);
    const fromBlueAbi = encodeEventTopics({
      abi: morphoBlueAbi,
      eventName: "Liquidate",
    })[0];
    expect(fromSig).toBe(fromBlueAbi);
  });

  it("decodeMorphoLog Liquidate yields borrower as user", () => {
    const topic0 = toEventSelector(LIQUIDATE_SIG);
    const marketId = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836" as Hex;
    const caller = "0x000000000000000000000000f39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const borrower = "0x00000000000000000000000070997970C51812dc3A010C7d01b50e0d17dc79C8";

    const d = decodeMorphoLog({
      topics: [topic0, marketId, caller, borrower],
      data: encodeAbiParameters(
        [
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
        ],
        [1n, 2n, 3n, 0n, 0n],
      ),
    });

    expect(d?.eventName).toBe("Liquidate");
    expect(d?.user.toLowerCase()).toBe("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    expect(d?.marketId).toBe(marketId);
  });
});
