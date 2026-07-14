import fs from "node:fs";

import type { Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { AaveAccountRegistry } from "../../src/aaveAccountRegistry.js";
import { HEALTH_FACTOR_THRESHOLD, AAVE_V3_POOL_ADDRESSES } from "../../src/abis/AaveV3.js";
import {
  AAVE_V3_SUBGRAPH_IDS,
  canUseAaveSubgraph,
  resolveAaveSubgraphEndpoint,
} from "../../src/utils/aaveAccountSources.js";
import { calculateCloseFactor } from "../../src/utils/aaveAssetPairSelector.js";
import {
  classifyLiquidationFailure,
  PositionLiquidationCooldownMechanism,
} from "../../src/utils/cooldownMechanisms.js";
import { RaceMetrics } from "../../src/utils/raceMetrics.js";

describe("Aave V3 Integration", () => {
  describe("calculateCloseFactor", () => {
    it("should return 50% when HF >= 0.95", () => {
      const hf = HEALTH_FACTOR_THRESHOLD; // 1.0
      const closeFactor = calculateCloseFactor(hf);
      expect(closeFactor).toBe(5000n); // 50% in bps
    });

    it("should return 50% when HF = 0.95 exactly", () => {
      const hf = (95n * HEALTH_FACTOR_THRESHOLD) / 100n; // 0.95
      const closeFactor = calculateCloseFactor(hf);
      expect(closeFactor).toBe(5000n);
    });

    it("should return 100% when HF < 0.95 (binary close factor)", () => {
      const hf = (90n * HEALTH_FACTOR_THRESHOLD) / 100n; // 0.90
      const closeFactor = calculateCloseFactor(hf);
      // Aave V3: HF < 0.95 → 100% close factor (not linear)
      expect(closeFactor).toBe(10000n);
    });

    it("should return 100% when HF = 0", () => {
      const closeFactor = calculateCloseFactor(0n);
      expect(closeFactor).toBe(10000n); // 100% in bps
    });

    it("should return 100% for very low HF", () => {
      const hf = 1n; // Very close to 0
      const closeFactor = calculateCloseFactor(hf);
      expect(closeFactor).toBe(10000n);
    });

    // ── Boundary tests matching Aave V3 binary close factor ──

    it("should return 50% for HF just above 0.95 threshold", () => {
      const hf = (95n * HEALTH_FACTOR_THRESHOLD) / 100n + 1n;
      expect(calculateCloseFactor(hf)).toBe(5000n);
    });

    it("should return 100% for HF just below 0.95 threshold", () => {
      const hf = (95n * HEALTH_FACTOR_THRESHOLD) / 100n - 1n;
      expect(calculateCloseFactor(hf)).toBe(10000n);
    });

    it("should return 100% for HF at 0.475", () => {
      const hf = (475n * HEALTH_FACTOR_THRESHOLD) / 1000n; // 0.475
      expect(calculateCloseFactor(hf)).toBe(10000n);
    });

    it("should return 100% for HF at 0.80", () => {
      const hf = (80n * HEALTH_FACTOR_THRESHOLD) / 100n; // 0.80
      expect(calculateCloseFactor(hf)).toBe(10000n);
    });

    it("should handle HF values above 1.0 correctly", () => {
      const hf = 2n * HEALTH_FACTOR_THRESHOLD; // 2.0
      expect(calculateCloseFactor(hf)).toBe(5000n);
    });

    it("should be binary: 100% below threshold, 50% at/above", () => {
      for (let hfPct = 0; hfPct <= 200; hfPct += 5) {
        const hf = (BigInt(hfPct) * HEALTH_FACTOR_THRESHOLD) / 100n;
        const cf = calculateCloseFactor(hf);
        const threshold = (95n * HEALTH_FACTOR_THRESHOLD) / 100n;
        expect(cf).toBe(hf >= threshold ? 5000n : 10000n);
      }
    });
  });

  describe("AaveAccountRegistry", () => {
    const testPool = AAVE_V3_POOL_ADDRESSES[1]!; // Mainnet pool
    const testFilePath = "/tmp/test-aave-registry.json";
    const testCheckpointPath = "/tmp/test-aave-registry.checkpoint.json";

    afterEach(() => {
      for (const p of [
        testFilePath,
        testCheckpointPath,
        testFilePath + ".tmp",
        testCheckpointPath + ".tmp",
      ]) {
        try {
          fs.unlinkSync(p);
        } catch {
          // ignore
        }
      }
    });

    it("should add and retrieve accounts", () => {
      const registry = new AaveAccountRegistry(testFilePath);
      const account1 = "0x1234567890123456789012345678901234567890" as Address;
      const account2 = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Address;

      // Use private method via any cast
      (registry as any).addAccount(testPool, account1);
      (registry as any).addAccount(testPool, account2);

      const accounts = registry.getAccounts(testPool);
      expect(accounts).toHaveLength(2);
      expect(accounts.map((a) => a.toLowerCase())).toContain(account1.toLowerCase());
      expect(accounts.map((a) => a.toLowerCase())).toContain(account2.toLowerCase());
    });

    it("should deduplicate accounts", () => {
      const registry = new AaveAccountRegistry(testFilePath);
      const account = "0x1234567890123456789012345678901234567890" as Address;

      (registry as any).addAccount(testPool, account);
      (registry as any).addAccount(testPool, account);
      (registry as any).addAccount(testPool, account);

      const accounts = registry.getAccounts(testPool);
      expect(accounts).toHaveLength(1);
    });

    it("should remove accounts", () => {
      const registry = new AaveAccountRegistry(testFilePath);
      const account = "0x1234567890123456789012345678901234567890" as Address;

      (registry as any).addAccount(testPool, account);
      expect(registry.getAccounts(testPool)).toHaveLength(1);

      registry.removeAccount(testPool, account);
      expect(registry.getAccounts(testPool)).toHaveLength(0);
    });

    it("should persist and load from split accounts + checkpoint files", () => {
      const registry1 = new AaveAccountRegistry(testFilePath);
      const account = "0x1234567890123456789012345678901234567890" as Address;

      (registry1 as any).addAccount(testPool, account);
      (registry1 as any).lastScannedBlock.set(testPool.toLowerCase(), 12345);
      registry1.saveToFile();

      expect(fs.existsSync(testFilePath)).toBe(true);
      expect(fs.existsSync(testCheckpointPath)).toBe(true);

      const accountsRaw = JSON.parse(fs.readFileSync(testFilePath, "utf-8"));
      expect(accountsRaw.accounts).toBeDefined();
      // Accounts file should not need lastScanned (lives in checkpoint)
      expect(accountsRaw.lastScannedBlock).toBeUndefined();

      const checkpointRaw = JSON.parse(fs.readFileSync(testCheckpointPath, "utf-8"));
      expect(checkpointRaw.lastScannedBlock[testPool.toLowerCase()]).toBe(12345);
      expect(checkpointRaw.accountsSyncedBlock[testPool.toLowerCase()]).toBe(12345);

      const registry2 = new AaveAccountRegistry(testFilePath);
      registry2.loadFromFile();

      const accounts = registry2.getAccounts(testPool);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]!.toLowerCase()).toBe(account.toLowerCase());
      expect(registry2.getLastScannedBlock(testPool)).toBe(12345);
    });

    it("should load legacy single-file format with embedded lastScannedBlock", () => {
      const poolKey = testPool.toLowerCase();
      const account = "0x1234567890123456789012345678901234567890";
      fs.writeFileSync(
        testFilePath,
        JSON.stringify({
          accounts: { [poolKey]: [account] },
          lastScannedBlock: { [poolKey]: 99999 },
        }),
      );

      const registry = new AaveAccountRegistry(testFilePath);
      registry.loadFromFile();
      expect(registry.getAccounts(testPool)).toHaveLength(1);
      expect(registry.getLastScannedBlock(testPool)).toBe(99999);
    });

    it("should resume from accountsSyncedBlock when checkpoint is ahead of accounts flush", () => {
      const poolKey = testPool.toLowerCase();
      const account = "0x1234567890123456789012345678901234567890";
      fs.writeFileSync(testFilePath, JSON.stringify({ accounts: { [poolKey]: [account] } }));
      // Cursor advanced to 200000 but accounts only durable through 100000
      fs.writeFileSync(
        testCheckpointPath,
        JSON.stringify({
          lastScannedBlock: { [poolKey]: 200000 },
          accountsSyncedBlock: { [poolKey]: 100000 },
        }),
      );

      const registry = new AaveAccountRegistry(testFilePath);
      registry.loadFromFile();
      // Must resume from accountsSynced so we re-scan the dirty gap, not skip it
      expect(registry.getLastScannedBlock(testPool)).toBe(100000);
    });

    it("saveCheckpoint alone should not rewrite accounts file mtime when clean", () => {
      const registry = new AaveAccountRegistry(testFilePath);
      const account = "0x1234567890123456789012345678901234567890" as Address;
      (registry as any).addAccount(testPool, account);
      (registry as any).lastScannedBlock.set(testPool.toLowerCase(), 1000);
      registry.saveToFile();

      const before = fs.readFileSync(testFilePath);
      (registry as any).lastScannedBlock.set(testPool.toLowerCase(), 1200);
      registry.saveCheckpoint();
      const after = fs.readFileSync(testFilePath);
      expect(Buffer.compare(before, after)).toBe(0);

      const ckpt = JSON.parse(fs.readFileSync(testCheckpointPath, "utf-8"));
      expect(ckpt.lastScannedBlock[testPool.toLowerCase()]).toBe(1200);
    });

    it("should return total account count across pools", () => {
      const registry = new AaveAccountRegistry(testFilePath);
      const pool1 = AAVE_V3_POOL_ADDRESSES[1]!;
      const pool2 = AAVE_V3_POOL_ADDRESSES[8453]!;

      (registry as any).addAccount(pool1, "0x1111111111111111111111111111111111111111");
      (registry as any).addAccount(pool1, "0x2222222222222222222222222222222222222222");
      (registry as any).addAccount(pool2, "0x3333333333333333333333333333333333333333");

      expect(registry.totalAccounts).toBe(3);
    });

    it("should importAccounts + markSynced for offline/subgraph backfill", () => {
      const registry = new AaveAccountRegistry(testFilePath);
      const added = registry.importAccounts(testPool, [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
        "0x1111111111111111111111111111111111111111", // dup
      ]);
      expect(added).toBe(2);
      registry.markSynced(testPool, 42_000_000);
      registry.saveToFile();

      const registry2 = new AaveAccountRegistry(testFilePath);
      registry2.loadFromFile();
      expect(registry2.getAccounts(testPool)).toHaveLength(2);
      expect(registry2.getLastScannedBlock(testPool)).toBe(42_000_000);
      expect(registry2.hasCheckpoint(testPool)).toBe(true);
    });
  });

  describe("registryPaths", () => {
    it("resolveAccountRegistryPath uses ACCOUNT_REGISTRY_DIR when set", async () => {
      const { resolveAccountRegistryPath, resolveRegistryDataDir } = await import(
        "../../src/utils/registryPaths.js"
      );
      const prev = process.env.ACCOUNT_REGISTRY_DIR;
      process.env.ACCOUNT_REGISTRY_DIR = "/var/lib/liq-bot";
      expect(resolveRegistryDataDir()).toBe("/var/lib/liq-bot");
      expect(resolveAccountRegistryPath("aave-accounts.8453.json")).toBe(
        "/var/lib/liq-bot/aave-accounts.8453.json",
      );
      if (prev !== undefined) process.env.ACCOUNT_REGISTRY_DIR = prev;
      else delete process.env.ACCOUNT_REGISTRY_DIR;
    });
  });

  describe("aaveAccountSources", () => {
    it("should resolve Base subgraph id", () => {
      expect(AAVE_V3_SUBGRAPH_IDS[8453]).toBe("GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF");
    });

    it("should not resolve URL without API key or override", () => {
      const prevKey = process.env.THEGRAPH_API_KEY;
      const prevUrl = process.env.AAVE_SUBGRAPH_URL;
      delete process.env.THEGRAPH_API_KEY;
      delete process.env.AAVE_SUBGRAPH_URL;
      expect(resolveAaveSubgraphEndpoint(8453)).toBeUndefined();
      expect(canUseAaveSubgraph(8453)).toBe(false);
      if (prevKey !== undefined) process.env.THEGRAPH_API_KEY = prevKey;
      if (prevUrl !== undefined) process.env.AAVE_SUBGRAPH_URL = prevUrl;
    });

    it("should use Bearer auth gateway URL (key not in path)", () => {
      const prevKey = process.env.THEGRAPH_API_KEY;
      const prevUrl = process.env.AAVE_SUBGRAPH_URL;
      delete process.env.AAVE_SUBGRAPH_URL;
      process.env.THEGRAPH_API_KEY = "test-key";
      const ep = resolveAaveSubgraphEndpoint(8453);
      expect(ep?.url).toBe(
        "https://gateway.thegraph.com/api/subgraphs/id/GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF",
      );
      expect(ep?.authorization).toBe("Bearer test-key");
      if (prevKey !== undefined) process.env.THEGRAPH_API_KEY = prevKey;
      else delete process.env.THEGRAPH_API_KEY;
      if (prevUrl !== undefined) process.env.AAVE_SUBGRAPH_URL = prevUrl;
    });
  });

  describe("PositionLiquidationCooldownMechanism race helpers", () => {
    const market = "0xpool" as `0x${string}`;
    const account = "0x1234567890123456789012345678901234567890" as `0x${string}`;

    it("isCoolingDown peeks without arming; markAttempted arms", () => {
      const cd = new PositionLiquidationCooldownMechanism(3600);
      expect(cd.isCoolingDown(market, account)).toBe(false);
      expect(cd.isCoolingDown(market, account)).toBe(false); // still not armed
      cd.markAttempted(market, account, "hard");
      expect(cd.isCoolingDown(market, account)).toBe(true);
    });

    it("race class uses short cooldown (15s default)", () => {
      const cd = new PositionLiquidationCooldownMechanism(3600, { race: 15, soft: 120 });
      expect(cd.secondsForClass("race")).toBe(15);
      expect(cd.secondsForClass("soft")).toBe(120);
      expect(cd.secondsForClass("hard")).toBe(3600);
      cd.markClass(market, account, "race");
      expect(cd.isCoolingDown(market, account)).toBe(true);
      expect(cd.remainingSeconds(market, account)).toBeLessThanOrEqual(15);
      expect(cd.remainingSeconds(market, account)).toBeGreaterThan(0);
    });

    it("classifyLiquidationFailure detects Aave race vs soft", () => {
      expect(classifyLiquidationFailure("HEALTH_FACTOR_NOT_BELOW_THRESHOLD")).toBe("race");
      expect(classifyLiquidationFailure("error 51 health factor")).toBe("race");
      expect(classifyLiquidationFailure("not liquidatable")).toBe("race");
      expect(classifyLiquidationFailure("profit below threshold")).toBe("soft");
      expect(classifyLiquidationFailure("random rpc timeout xyz")).toBe("hard");
      // empty revert + structured sim outcomes → soft (not hard 1h)
      expect(classifyLiquidationFailure('contract returned no data ("0x")')).toBe("soft");
      expect(classifyLiquidationFailure("sim_fail")).toBe("soft");
      expect(classifyLiquidationFailure("profit_fail")).toBe("soft");
      expect(classifyLiquidationFailure("all borrow positions exhausted")).toBe("soft");
    });
  });

  describe("RaceMetrics", () => {
    it("aggregates stages and outcomes for bottleneck summary", () => {
      const m = new RaceMetrics(100);
      m.recordStage("hfScan", 100);
      m.recordStage("hfScan", 300);
      m.recordStage("pair", 50);
      m.recordConvert(20, "cache");
      m.recordConvert(400, "probe");
      m.recordOutcome("fail_race");
      m.recordOutcome("fail_race");
      m.recordOutcome("success");
      const snap = m.snapshot();
      expect(snap.stages.hfScan?.avgMs).toBe(200);
      expect(snap.stages.hfScan?.maxMs).toBe(300);
      expect(snap.convertCacheHits).toBe(1);
      expect(snap.convertCacheMisses).toBe(1);
      expect(snap.outcomes.fail_race).toBe(2);
      expect(snap.outcomes.success).toBe(1);
    });
  });

  describe("Aave V3 Constants", () => {
    it("should have correct health factor threshold", () => {
      expect(HEALTH_FACTOR_THRESHOLD).toBe(10n ** 18n);
    });

    it("should have pool addresses for Base and Mainnet", () => {
      expect(AAVE_V3_POOL_ADDRESSES[8453]).toBeDefined();
      expect(AAVE_V3_POOL_ADDRESSES[1]).toBeDefined();
    });
  });
});
