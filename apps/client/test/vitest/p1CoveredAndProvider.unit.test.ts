/**
 * Unit tests: coveredMarkets fast-path gate + provider failure ≠ idle empty.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DataProviderError } from "@morpho-blue-liquidation-bot/data-providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getHealthServer, type BotHealthStatus } from "../../src/health.js";

describe("Morpho fast path coveredMarkets gate (source contract)", () => {
  it("handleEvents skips markets not in coveredMarkets", () => {
    const src = readFileSync(resolve(process.cwd(), "apps/client/src/bot.ts"), "utf8");
    expect(src).toContain("coveredSet.has(marketId.toLowerCase())");
    expect(src).toContain("Do not cache or liquidate markets outside the whitelist");
    expect(src).toContain("never liquidate outside coveredMarkets");
  });
});

describe("DataProviderError", () => {
  it("is a named Error subclass", () => {
    const err = new DataProviderError("api down");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DataProviderError");
    expect(err.message).toBe("api down");
  });

  it("providers throw instead of returning empty on failure (source)", () => {
    const morpho = readFileSync(
      resolve(process.cwd(), "apps/data-providers/src/morphoApi/index.ts"),
      "utf8",
    );
    const hyper = readFileSync(
      resolve(process.cwd(), "apps/data-providers/src/hyperIndex/index.ts"),
      "utf8",
    );
    expect(morpho).toContain("throw new DataProviderError");
    expect(morpho).not.toMatch(
      /Error fetching liquidatable positions:.*\n.*return \{ liquidatablePositions: \[\], preLiquidatablePositions: \[\] \}/s,
    );
    expect(hyper).toContain("throw new DataProviderError");
    expect(hyper).not.toMatch(
      /Error fetching liquidatable positions from HyperIndex:[\s\S]*return \{ liquidatablePositions: \[\], preLiquidatablePositions: \[\] \}/,
    );
  });

  it("bot marks providerError unhealthy (source)", () => {
    const src = readFileSync(resolve(process.cwd(), "apps/client/src/bot.ts"), "utf8");
    expect(src).toContain("_providerError");
    expect(src).toContain("providerError: this._providerError");
    expect(src).toContain("isHealthy: providerOk && rpcErrorRate < 0.3");
    expect(src).toContain("FAILED (not empty)");
  });
});

describe("Health 503 on degraded", () => {
  const port = 3211;
  let server: ReturnType<typeof getHealthServer>;

  beforeAll(async () => {
    server = getHealthServer(port, "127.0.0.1");
    server.registerBot("morpho-test", () => {
      const status: BotHealthStatus = {
        protocol: "morpho",
        lastCheckTimestamp: Date.now() / 1000,
        lastCheckBlock: 0,
        registryAccountCount: 0,
        liquidationsAttempted: 0,
        liquidationsSucceeded: 0,
        liquidationsFailed: 0,
        rpcErrorRate: 0,
        isHealthy: false,
        providerError: true,
        lastProviderError: "Morpho API down",
      };
      return status;
    });
    // start only if not already listening — HealthServer.start may throw if port in use
    try {
      await server.start();
    } catch {
      // may already be started in this process from a prior test
    }
  });

  afterAll(async () => {
    try {
      await server.stop();
    } catch {
      // ignore
    }
  });

  it("returns 503 when a registered bot is unhealthy", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; bots: Record<string, BotHealthStatus> };
    expect(body.status).toBe("degraded");
    expect(body.bots["morpho-test"]?.providerError).toBe(true);
  });
});
