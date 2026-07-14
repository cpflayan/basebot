/**
 * C1 Comet collateral ABI, C2 registry no skip-on-fail, M1 buyCollateral reserve cap.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { cometViewAbi } from "../../src/abis/Comet.js";

describe("C1 Comet collateral enumeration ABI", () => {
  it("uses numAssets + getAssetInfo (not numCollateralAssets)", () => {
    const names = cometViewAbi
      .filter(
        (x): x is (typeof cometViewAbi)[number] & { type: "function"; name: string } =>
          x.type === "function",
      )
      .map((x) => x.name);
    expect(names).toContain("numAssets");
    expect(names).toContain("getAssetInfo");
    expect(names).not.toContain("numCollateralAssets");
    expect(names).not.toContain("getCollateralAsset");

    const bot = readFileSync(resolve(process.cwd(), "apps/client/src/cometBot.ts"), "utf8");
    expect(bot).toContain('functionName: "numAssets"');
    expect(bot).toContain('functionName: "getAssetInfo"');
    expect(bot).not.toContain("numCollateralAssets");
  });
});

describe("C2 registry does not skip blocks on total scan failure", () => {
  it("Comet/Moonwell scanRange throw when both filters fail", () => {
    for (const f of ["cometAccountRegistry.ts", "moonwellAccountRegistry.ts"]) {
      const src = readFileSync(resolve(process.cwd(), `apps/client/src/${f}`), "utf8");
      expect(src).toContain("must throw so baseAccountRegistry does NOT advance lastScanned");
      expect(src).toMatch(/throw e2/);
    }
  });

  it("scanNewEvents advances cursor only after successful batches", () => {
    const src = readFileSync(
      resolve(process.cwd(), "apps/client/src/utils/baseAccountRegistry.ts"),
      "utf8",
    );
    expect(src).toContain("lastOkEnd");
    expect(src).toContain("do not jump to tip");
    // must not set lastScanned to currentBlock before verifying batches
    expect(src).not.toMatch(
      /for \(let start = fromBlock[\s\S]{0,400}this\.lastScannedBlock\.set\(key, currentBlock\)/,
    );
  });
});

describe("M1 buyCollateral baseAmount capped to reserves", () => {
  it("flash path scales baseAmount when quote exceeds reserves", () => {
    const src = readFileSync(resolve(process.cwd(), "apps/client/src/cometBot.ts"), "utf8");
    expect(src).toContain("Scale baseAmount down so collateral out fits");
    expect(src).toContain("(baseAmount * plan.reserveAmount) / quotedOut");
    expect(src).not.toContain("cometBuyCollateral(comet.address, collateral, 0n, maxUint256)");
  });
});
