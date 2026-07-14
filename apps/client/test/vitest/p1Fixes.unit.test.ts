/**
 * Unit tests for P1 audit fixes (no fork required).
 * - Webhook: cooldown still applies cache (liquidationsThrottled)
 * - sharedExecution: submit path uses waitForTransactionReceipt (source contract)
 * - Moonwell: RF threshold docs / high-RF no longer strips discovery (code-path strings)
 */
import { toEventSelector } from "viem";
import { describe, expect, it } from "vitest";

import { WebhookServer, MORPHO_EVENT_SIGNATURES } from "../../src/webhook.js";

describe("P1 webhook cooldown — cache always applied", () => {
  it("second webhook within cooldown returns cacheApplied + liquidationsThrottled", async () => {
    const server = new WebhookServer(3196, "127.0.0.1", 10_000);
    await server.start();

    const topic0 = toEventSelector(MORPHO_EVENT_SIGNATURES[0]);
    const payload = {
      event: {
        data: {
          block: {
            logs: [
              {
                topics: [
                  topic0,
                  "0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda",
                  "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
                  "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
                ],
                data: "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000000000000000000000001e848000000000000000000000000000000000000000000000000000000000001e8480",
              },
            ],
          },
        },
      },
    };

    try {
      const r1 = await fetch("http://127.0.0.1:3196/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j1 = (await r1.json()) as {
        triggered: boolean;
        cacheApplied?: boolean;
        liquidationsThrottled?: boolean;
        reason?: string;
      };

      const r2 = await fetch("http://127.0.0.1:3196/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j2 = (await r2.json()) as {
        triggered: boolean;
        cacheApplied?: boolean;
        liquidationsThrottled?: boolean;
        reason?: string;
      };

      expect(j1.triggered).toBe(true);
      expect(j1.cacheApplied).toBe(true);
      expect(j1.liquidationsThrottled).toBe(false);

      expect(j2.triggered).toBe(true);
      expect(j2.cacheApplied).toBe(true);
      expect(j2.liquidationsThrottled).toBe(true);
      expect(j2.reason).toBe("cooldown");
    } finally {
      await server.stop();
    }
  });
});

describe("P1 receipt success — source contract", () => {
  it("sharedExecution imports waitForTransactionReceipt and submitAndConfirm pattern", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = path.resolve(process.cwd(), "apps/client/src/utils/sharedExecution.ts");
    const src = fs.readFileSync(file, "utf8");
    expect(src).toContain("waitForTransactionReceipt");
    expect(src).toContain("submitAndConfirm");
    expect(src).toContain('receipt.status !== "success"');
    // Must not return true immediately after writeContract without waiting
    expect(src).toMatch(/Transaction sent:.*waiting for receipt/s);
  });
});

describe("P1 Moonwell RF — discovery not stripped", () => {
  it("cacheReserveFactors no longer filters mTokenList by RF≥99%", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const file = path.resolve(process.cwd(), "apps/client/src/moonwellBot.ts");
    const src = fs.readFileSync(file, "utf8");
    expect(src).not.toContain(
      "this.mTokenList = this.mTokenList.filter((m) => !this.highRfMarkets",
    );
    expect(src).toContain("not excluded from discovery");
    expect(src).toContain("attempting with profit gate");
  });
});
