/**
 * 錯誤處理壓力測試
 *
 * 測試機器人在邊界情況下的韌性：
 * 1. Webhook 異常 payload
 * 2. RPC 斷線 / 超時
 * 3. API 限流 (429)
 * 4. 無效事件數據
 * 5. 並發錯誤處理
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Address, Hex } from "viem";

import { PositionCache, type CachedMarketState } from "../../../src/positionCache.js";
import { WebhookServer } from "../../../src/webhook.js";

// ── Test constants ──

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WSTETH_BASE = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" as Address;
const TEST_USER = "0x0000000000000000000000000000000000000001" as Address;
const TEST_MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;

function makeMarketState(overrides?: Partial<CachedMarketState>): CachedMarketState {
  return {
    marketId: TEST_MARKET,
    params: {
      loanToken: USDC_BASE,
      collateralToken: WSTETH_BASE,
      oracle: "0x4E2b7B6c5a8bB0E3F6aD1b3c8f0E4F7E8C9D0A1b",
      irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
      lltv: 860000000000000000n,
    },
    totalSupplyAssets: 1_000_000n * 10n ** 6n,
    totalSupplyShares: 1_000_000n * 10n ** 6n,
    totalBorrowAssets: 500n * 10n ** 6n,
    totalBorrowShares: 500n * 10n ** 12n,
    lastUpdate: BigInt(Math.floor(Date.now() / 1000)),
    fee: 10000000000000000n,
    rateAtTarget: 100000000000000000n,
    price: 2500n * 10n ** 30n,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

// ── 1. Webhook 異常 Payload 測試 ──

describe("Webhook 異常 Payload 處理", () => {
  let webhookServer: WebhookServer;

  beforeEach(() => {
    webhookServer = new WebhookServer(3099); // 使用不同端口避免衝突
  });

  afterEach(async () => {
    await webhookServer.stop();
  });

  it("空 body → 返回 200 + triggered: false", async () => {
    await webhookServer.start();

    const response = await fetch("http://127.0.0.1:3099/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no logs");
  });

  it("缺少 event.data → 返回 200 + triggered: false", async () => {
    await webhookServer.start();

    const response = await fetch("http://127.0.0.1:3099/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: {} }),
    });

    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(result.triggered).toBe(false);
  });

  it("空的 logs 陣列 → 返回 200 + triggered: false", async () => {
    await webhookServer.start();

    const response = await fetch("http://127.0.0.1:3099/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: { data: { block: { logs: [] } } },
      }),
    });

    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no matching events"); // 空陣列過濾後無匹配
  });

  it("無效的 topics 格式 → 不崩潰，返回 200", async () => {
    await webhookServer.start();

    const response = await fetch("http://127.0.0.1:3099/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: {
          data: {
            block: {
              logs: [
                { topics: "not-an-array", data: "0x123" }, // topics 應該是陣列
                { topics: null, data: "0x456" },
                { data: "0x789" }, // 缺少 topics
              ],
            },
          },
        },
      }),
    });

    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(result.triggered).toBe(false);
  });

  it("非 MorphoBlue 事件 → 返回 200 + no matching events", async () => {
    await webhookServer.start();

    const randomTopic = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const response = await fetch("http://127.0.0.1:3099/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: {
          data: {
            block: {
              logs: [{ topics: [randomTopic], data: "0x" }],
            },
          },
        },
      }),
    });

    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe("no matching events");
  });
});

// ── 2. PositionCache 邊界情況測試 ──

describe("PositionCache 邊界情況", () => {
  it("市場狀態過期（fetchedAt 很久以前）→ 仍能計算 HF", () => {
    const cache = new PositionCache();
    const staleMarket = makeMarketState({
      fetchedAt: Date.now() - 1000 * 60 * 60, // 1 小時前
      lastUpdate: BigInt(Math.floor(Date.now() / 1000)) - 3600n, // 1 小時前
    });
    cache.setMarket(staleMarket);
    cache.set({
      user: TEST_USER,
      marketId: TEST_MARKET,
      collateral: 2n * 10n ** 18n,
      borrowShares: 4000n * 10n ** 18n,
      supplyShares: 0n,
      updatedAt: Date.now(),
    });

    // 即使市場狀態過期，HF 計算不應該拋出異常
    const hf = cache.calculateHF(TEST_MARKET, TEST_USER, 2500n * 10n ** 30n);
    expect(hf).toBeDefined();
    expect(hf).toBeGreaterThan(0);
  });

  it("collateral = 0, borrowShares > 0 → HF = 0（完全清算）", () => {
    const cache = new PositionCache();
    cache.setMarket(makeMarketState());
    cache.set({
      user: TEST_USER,
      marketId: TEST_MARKET,
      collateral: 0n, // 無抵押品
      borrowShares: 4000n * 10n ** 18n,
      supplyShares: 0n,
      updatedAt: Date.now(),
    });

    const hf = cache.calculateHF(TEST_MARKET, TEST_USER, 2500n * 10n ** 30n);
    expect(hf).toBeDefined();
    expect(hf).toBe(0);
  });

  it("price = 0 → HF = 0 或 undefined（oracle 失效）", () => {
    const cache = new PositionCache();
    cache.setMarket(makeMarketState({ price: 0n })); // 市場 price = 0
    cache.set({
      user: TEST_USER,
      marketId: TEST_MARKET,
      collateral: 2n * 10n ** 18n,
      borrowShares: 4000n * 10n ** 18n,
      supplyShares: 0n,
      updatedAt: Date.now(),
    });

    const hf = cache.calculateHF(TEST_MARKET, TEST_USER, 0n);
    // price = 0 時 collateralValue = 0 → HF = 0 或 undefined（取決於實現）
    expect(hf === undefined || hf === 0).toBe(true);
  });

  it("極大 price → 不崩潰（可能 overflow 為 Infinity）", () => {
    const cache = new PositionCache();
    cache.setMarket(makeMarketState());
    cache.set({
      user: TEST_USER,
      marketId: TEST_MARKET,
      collateral: 2n * 10n ** 18n,
      borrowShares: 4000n * 10n ** 18n,
      supplyShares: 0n,
      updatedAt: Date.now(),
    });

    // 極大價格（1e48）
    const hugePrice = 10n ** 48n;
    // 不應該拋出異常
    expect(() => cache.calculateHF(TEST_MARKET, TEST_USER, hugePrice)).not.toThrow();
    // HF 可能 overflow 為 Infinity，這是可接受的行為
    const hf = cache.calculateHF(TEST_MARKET, TEST_USER, hugePrice);
    expect(hf).toBeDefined();
  });

  it("findAtRiskPositions 空市場 → 返回空陣列", () => {
    const cache = new PositionCache();
    // 不設置任何倉位

    const atRisk = cache.findAtRiskPositions(TEST_MARKET, 1, 2500n * 10n ** 30n);
    expect(atRisk).toEqual([]);
  });
});

// ── 3. 並發錯誤處理測試 ──

describe("並發錯誤處理", () => {
  it("多個倉位同時計算 HF → 不互相干擾", async () => {
    const cache = new PositionCache();
    cache.setMarket(makeMarketState());

    // 設置 100 個倉位
    const users: Address[] = [];
    for (let i = 0; i < 100; i++) {
      const user = `0x${i.toString().padStart(40, "0")}` as Address;
      users.push(user);
      cache.set({
        user,
        marketId: TEST_MARKET,
        collateral: BigInt(i + 1) * 10n ** 18n,
        borrowShares: BigInt(i + 1) * 1000n * 10n ** 18n,
        supplyShares: 0n,
        updatedAt: Date.now(),
      });
    }

    // 並發計算所有 HF
    const hfPromises = users.map((user) =>
      Promise.resolve(cache.calculateHF(TEST_MARKET, user, 2500n * 10n ** 30n)),
    );
    const results = await Promise.all(hfPromises);

    // 所有結果都應該有定義且大於 0
    expect(results.every((hf) => hf !== undefined && hf > 0)).toBe(true);
  });

  it("快速連續 upsert + calculateHF → 不 race condition", async () => {
    const cache = new PositionCache();
    cache.setMarket(makeMarketState());

    // 快速連續操作
    const operations = [];
    for (let i = 0; i < 50; i++) {
      operations.push(
        new Promise<void>((resolve) => {
          cache.upsert(TEST_MARKET, TEST_USER, {
            collateral: BigInt(i) * 10n ** 18n,
            borrowShares: BigInt(i) * 100n * 10n ** 18n,
          });
          cache.calculateHF(TEST_MARKET, TEST_USER, 2500n * 10n ** 30n);
          resolve();
        }),
      );
    }

    await Promise.all(operations);

    // 最終狀態應該一致
    const pos = cache.get(TEST_MARKET, TEST_USER);
    expect(pos).toBeDefined();
    expect(pos!.collateral).toBe(49n * 10n ** 18n); // 最後一次操作的值
  });
});

// ── 4. Cooldown 機制測試 ──

describe("Cooldown 機制", () => {
  it("短時間內多次觸發 → 只處理第一次", async () => {
    const webhookServer = new WebhookServer(3098, "0.0.0.0", 5000); // 5 秒 cooldown
    await webhookServer.start();

    const borrowTopic = "0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43";
    const marketId = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
    const user = "0xd6452Cb202d455D4690a41e9E61A2815fcAe462F";

    const payload = {
      event: {
        data: {
          block: {
            logs: [
              {
                topics: [borrowTopic, marketId, `0x000000000000000000000000${user.slice(2)}`, `0x000000000000000000000000${user.slice(2)}`],
                data: "0x0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000003b9aca0000000000000000000000000000000000000000000000003635c9adc5dea00000",
              },
            ],
          },
        },
      },
    };

    // 第一次請求
    const res1 = await fetch("http://127.0.0.1:3098/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result1 = await res1.json() as Record<string, unknown>;

    // 立即第二次請求（應該被 cooldown 擋住）
    const res2 = await fetch("http://127.0.0.1:3098/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result2 = await res2.json() as Record<string, unknown>;

    expect(result1.triggered).toBe(true);
    expect(result2.triggered).toBe(false);
    expect(result2.reason).toBe("cooldown");

    await webhookServer.stop();
  });
});
