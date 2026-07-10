import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import { AaveAccountRegistry } from "../../src/aaveAccountRegistry.js";
import { HEALTH_FACTOR_THRESHOLD, AAVE_V3_POOL_ADDRESSES } from "../../src/abis/AaveV3.js";
import { calculateCloseFactor } from "../../src/utils/aaveAssetPairSelector.js";

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

    it("should scale up when HF < 0.95", () => {
      const hf = (90n * HEALTH_FACTOR_THRESHOLD) / 100n; // 0.90
      const closeFactor = calculateCloseFactor(hf);
      // Should be between 50% and 100%
      expect(closeFactor).toBeGreaterThan(5000n);
      expect(closeFactor).toBeLessThan(10000n);
    });

    it("should return 100% when HF = 0", () => {
      const closeFactor = calculateCloseFactor(0n);
      expect(closeFactor).toBe(10000n); // 100% in bps
    });

    it("should cap at 100% for very low HF", () => {
      const hf = 1n; // Very close to 0
      const closeFactor = calculateCloseFactor(hf);
      expect(closeFactor).toBeLessThanOrEqual(10000n);
    });

    // ── Enhanced boundary tests (matching Aave V3 ValidationLogic.sol) ──

    it("should return 50% for HF just above 0.95 threshold", () => {
      const hf = (95n * HEALTH_FACTOR_THRESHOLD) / 100n + 1n;
      expect(calculateCloseFactor(hf)).toBe(5000n);
    });

    it("should return >=50% for HF just below 0.95 threshold", () => {
      const hf = (95n * HEALTH_FACTOR_THRESHOLD) / 100n - 1n;
      const cf = calculateCloseFactor(hf);
      // Integer division: (5000 * 1) / threshold = 0, so cf stays at 5000
      // This matches Aave V3's integer math behavior
      expect(cf).toBeGreaterThanOrEqual(5000n);
      expect(cf).toBeLessThan(5100n);
    });

    it("should return ~75% for HF at 0.475 (midpoint)", () => {
      const hf = (475n * HEALTH_FACTOR_THRESHOLD) / 1000n; // 0.475
      const cf = calculateCloseFactor(hf);
      // Linear interp: 5000 + (10000-5000) * (0.95 - 0.475) / 0.95
      // = 5000 + 5000 * 0.475 / 0.95 = 5000 + 2500 = 7500
      expect(cf).toBe(7500n);
    });

    it("should match Aave V3 integer division rounding", () => {
      // Aave V3 formula: DEFAULT + (MAX - DEFAULT) * (threshold - HF) / threshold
      // Integer division truncates toward zero
      const threshold = (95n * HEALTH_FACTOR_THRESHOLD) / 100n;
      const hf = (80n * HEALTH_FACTOR_THRESHOLD) / 100n; // 0.80
      const expected = 5000n + (5000n * (threshold - hf)) / threshold;
      expect(calculateCloseFactor(hf)).toBe(expected);
    });

    it("should handle HF values above 1.0 correctly", () => {
      const hf = 2n * HEALTH_FACTOR_THRESHOLD; // 2.0
      expect(calculateCloseFactor(hf)).toBe(5000n);
    });

    it("should be monotonically non-increasing as HF increases", () => {
      let prevCf = 0n;
      for (let hfPct = 0; hfPct <= 200; hfPct += 5) {
        const hf = (BigInt(hfPct) * HEALTH_FACTOR_THRESHOLD) / 100n;
        const cf = calculateCloseFactor(hf);
        if (hfPct > 0) {
          expect(cf).toBeLessThanOrEqual(prevCf);
        }
        prevCf = cf;
      }
    });
  });

  describe("AaveAccountRegistry", () => {
    const testPool = AAVE_V3_POOL_ADDRESSES[1]!; // Mainnet pool
    const testFilePath = "/tmp/test-aave-registry.json";

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

    it("should persist and load from file", () => {
      const registry1 = new AaveAccountRegistry(testFilePath);
      const account = "0x1234567890123456789012345678901234567890" as Address;

      (registry1 as any).addAccount(testPool, account);
      (registry1 as any).lastScannedBlock.set(testPool.toLowerCase(), 12345);
      registry1.saveToFile();

      const registry2 = new AaveAccountRegistry(testFilePath);
      registry2.loadFromFile();

      const accounts = registry2.getAccounts(testPool);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]!.toLowerCase()).toBe(account.toLowerCase());
      expect(registry2.getLastScannedBlock(testPool)).toBe(12345);
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
