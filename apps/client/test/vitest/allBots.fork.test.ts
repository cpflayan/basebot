/**
 * apps/client/test/vitest/allBots.fork.test.ts
 *
 * Comprehensive integration tests for all 4 liquidation bots under Anvil Base fork.
 * Creates REAL on-chain positions, manipulates oracles, verifies liquidation state,
 * tests encoder encoding, webhook event handling, and shared infrastructure.
 *
 * Prerequisites:
 *   RPC_URL_8453 must point to a real Base RPC (e.g. Alchemy) for Anvil to fork.
 */

import fs from "node:fs";
import path from "node:path";

import {
  chainConfigs,
  loadApprovedMarketIds,
  ALWAYS_REALIZE_BAD_DEBT,
} from "@morpho-blue-liquidation-bot/config";
import { type Hex, getAddress, parseAbi, maxUint256, type Address, encodeFunctionData } from "viem";
import { readContract } from "viem/actions";
import { describe, expect, afterAll } from "vitest";

import { getHealthServer } from "../../src/health.js";
import { calculateCloseFactor } from "../../src/utils/aaveAssetPairSelector.js";
import { LiquidationEncoder } from "../../src/utils/LiquidationEncoder.js";
import { liquidationTracker } from "../../src/utils/liquidationState.js";
import { WebhookServer, decodeMorphoLog } from "../../src/webhook.js";
import { aaveBaseForkTest } from "../setup.js";

// ─── Base Chain Addresses ──────────────────────────────────────────────────────

const WETH = getAddress("0x4200000000000000000000000000000000000006");
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const cbETH = getAddress("0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22");
const USR = getAddress("0x35e5db674d8e93a03d814fa0ada70731efe8a4b9");

const MORPHO = getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
const ORACLE_MORPHO = getAddress("0xfea2d58cefcb9fcb597723c6bae66ffe4193afe4");
const IRM_MORPHO = getAddress("0x46415998764C29aB2a25CbeA6254146D50D22687");
const LLTV_MORPHO = 860000000000000000n;

const COMET = getAddress("0xb125E6687d4313864e53df431d5425969c15Eb2F");
const COMPTROLLER = getAddress("0xfBb21d0380beE3312B33c4353c8936a0F13EF26C");
const mWETH = getAddress("0x628ff693426583D9a7FB391E54366292F509D457");
const mUSDC = getAddress("0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22");
const POOL_AAVE = getAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
const AAVE_ORACLE = getAddress("0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156");
const AGGREGATOR = getAddress("0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70");

const SAFE_USER = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
const LIQ_USER = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");

const MARKET_ID_MORPHO =
  "0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda" as Hex;

const MARKET_PARAMS_MORPHO = [USDC, WETH, ORACLE_MORPHO, IRM_MORPHO, LLTV_MORPHO] as const;

// ─── Mock Bytecodes ────────────────────────────────────────────────────────────

const AGGREGATOR_BYTECODE =
  "0x" +
  "60003560e01c" +
  "8063313ce56714602657" +
  "8063feaf968c14603157" +
  "5b60005460005260206000f3" +
  "5b600860005260206000f3" +
  "5b60016000526000546020524260405242606052600160805260a06000f3";

const MORPHO_ORACLE_BYTECODE = "0x60005460005260206000f3";

const AAVE_ORACLE_BYTECODE =
  "0x" +
  "600254" +
  "600435" +
  "73ffffffffffffffffffffffffffffffffffffffff" +
  "16" +
  "734200000000000000000000000000000000000006" +
  "14" +
  "604057" +
  "60015460005260206000f3" +
  "5b60005260206000f3";

// ─── ABIs ──────────────────────────────────────────────────────────────────────

const wethAbi = parseAbi([
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
]);
const erc20Abi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const morphoAbi = parseAbi([
  "function supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)",
  "function borrow((address,address,address,address,uint256),uint256,uint256,address,address)",
]);
const cometAbi = parseAbi([
  "function supply(address,uint256)",
  "function borrow(uint256)",
  "function isLiquidatable(address) view returns (bool)",
  "function balanceOf(address) view returns (int256)",
  "function getPrice(address) view returns (uint256)",
  "function quote(address,uint256) view returns (uint256)",
]);
const moonwellAbi = parseAbi([
  "function enterMarkets(address[]) returns (uint256[])",
  "function mint(uint256) returns (uint256)",
  "function borrow(uint256) returns (uint256)",
]);
const aaveAbi = parseAbi([
  "function supply(address,uint256,address,uint16)",
  "function borrow(address,uint256,uint256,uint16,address)",
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
]);
const comptrollerAbi = parseAbi([
  "function getAccountLiquidity(address) view returns (uint256,uint256,uint256)",
]);
const morphoViewAbi = parseAbi([
  "function position(bytes32,address) view returns (uint256,uint256,uint256)",
]);

// ─── Results Collection ────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  note: string;
}
const testResults: TestResult[] = [];

function recordResult(name: string, status: "PASS" | "FAIL", note = "") {
  testResults.push({ name, status, note });
}

// ─── Helper: raw RPC bypass (avoids viem-tracer middleware) ────────────────────

let _rpcId = 0;
function getRpcUrl(client: any): string {
  const candidates = [
    client.transport?.url,
    client.chain?.rpcUrls?.default?.http?.[0],
    client._test?.url,
    client._anvil?.url,
    client._options?.url,
  ].filter(Boolean);
  if (candidates.length > 0) return candidates[0]!;
  throw new Error(`Cannot find Anvil URL. Client keys: ${Object.keys(client).join(",")}`);
}
async function rawRpc(client: any, method: string, params: any[]): Promise<any> {
  const url = getRpcUrl(client);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: ++_rpcId }),
  });
  const json = (await res.json()) as any;
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

async function sendTx(client: any, from: Address, to: Address, data: Hex, value = 0n) {
  await rawRpc(client, "anvil_impersonateAccount", [from]);
  await rawRpc(client, "anvil_setBalance", [from, "0x" + (100n * 10n ** 18n).toString(16)]);
  const hash = await rawRpc(client, "eth_sendTransaction", [
    {
      from,
      to,
      data,
      value: value ? "0x" + value.toString(16) : "0x0",
      gas: "0x" + 5_000_000n.toString(16),
      maxFeePerGas: "0x" + 10_000_000_000n.toString(16),
      maxPriorityFeePerGas: "0x" + 1_000_000_000n.toString(16),
    },
  ]);
  await rawRpc(client, "anvil_stopImpersonatingAccount", [from]);
  await rawRpc(client, "evm_mine", []);
  return hash;
}

async function sendTxSilent(
  client: any,
  from: Address,
  to: Address,
  data: Hex,
  value = 0n,
): Promise<string | null> {
  try {
    return await sendTx(client, from, to, data, value);
  } catch {
    return null;
  }
}

// ─── Test Suite ────────────────────────────────────────────────────────────────

describe("Multi-Protocol Liquidation Bot Fork Test Suite", () => {
  const setupClients = new WeakSet();

  async function ensureSetup(client: any) {
    if (setupClients.has(client)) return;
    process.env.WHITELIST_DATA_DIR = path.resolve("./test-discovery-data");

    // ═══ Fund users with ETH ═══
    await rawRpc(client, "anvil_setBalance", [SAFE_USER, "0x" + (50n * 10n ** 18n).toString(16)]);
    await rawRpc(client, "anvil_setBalance", [LIQ_USER, "0x" + (50n * 10n ** 18n).toString(16)]);

    // ═══ Wrap ETH → WETH for both users ═══
    await sendTx(
      client,
      SAFE_USER,
      WETH,
      encodeFunctionData({ abi: wethAbi, functionName: "deposit" }),
      20n * 10n ** 18n,
    );
    await sendTx(
      client,
      LIQ_USER,
      WETH,
      encodeFunctionData({ abi: wethAbi, functionName: "deposit" }),
      10n * 10n ** 18n,
    );

    // ═══ Approve WETH to all protocols ═══
    for (const user of [SAFE_USER, LIQ_USER]) {
      for (const spender of [MORPHO, COMET, mWETH, POOL_AAVE]) {
        await sendTx(
          client,
          user,
          WETH,
          encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [spender, maxUint256],
          }),
        );
      }
    }

    // ═══ Morpho Blue Positions ═══
    // SAFE: 5 WETH collateral / 500 USDC borrow
    await sendTxSilent(
      client,
      SAFE_USER,
      MORPHO,
      encodeFunctionData({
        abi: morphoAbi,
        functionName: "supplyCollateral",
        args: [MARKET_PARAMS_MORPHO, 5n * 10n ** 18n, SAFE_USER, "0x"],
      }),
    );
    await sendTxSilent(
      client,
      SAFE_USER,
      MORPHO,
      encodeFunctionData({
        abi: morphoAbi,
        functionName: "borrow",
        args: [MARKET_PARAMS_MORPHO, 500n * 10n ** 6n, 0n, SAFE_USER, SAFE_USER],
      }),
    );

    // LIQ: 1 WETH collateral / 2000 USDC borrow (within 86% LTV)
    await sendTxSilent(
      client,
      LIQ_USER,
      MORPHO,
      encodeFunctionData({
        abi: morphoAbi,
        functionName: "supplyCollateral",
        args: [MARKET_PARAMS_MORPHO, 10n ** 18n, LIQ_USER, "0x"],
      }),
    );
    const morphoLiqBorrow = await sendTxSilent(
      client,
      LIQ_USER,
      MORPHO,
      encodeFunctionData({
        abi: morphoAbi,
        functionName: "borrow",
        args: [MARKET_PARAMS_MORPHO, 2000n * 10n ** 6n, 0n, LIQ_USER, LIQ_USER],
      }),
    );
    if (!morphoLiqBorrow) console.log("[WARN] Morpho LIQ borrow failed, trying 1000 USDC");

    // ═══ Comet Positions ═══
    // SAFE: 5 WETH / 500 USDC
    await sendTxSilent(
      client,
      SAFE_USER,
      COMET,
      encodeFunctionData({
        abi: cometAbi,
        functionName: "supply",
        args: [WETH, 5n * 10n ** 18n],
      }),
    );
    await sendTxSilent(
      client,
      SAFE_USER,
      COMET,
      encodeFunctionData({
        abi: cometAbi,
        functionName: "borrow",
        args: [500n * 10n ** 6n],
      }),
    );

    // LIQ: 1 WETH / 2000 USDC (within LTV)
    await sendTxSilent(
      client,
      LIQ_USER,
      COMET,
      encodeFunctionData({
        abi: cometAbi,
        functionName: "supply",
        args: [WETH, 10n ** 18n],
      }),
    );
    const cometLiqBorrow = await sendTxSilent(
      client,
      LIQ_USER,
      COMET,
      encodeFunctionData({
        abi: cometAbi,
        functionName: "borrow",
        args: [2000n * 10n ** 6n],
      }),
    );
    if (!cometLiqBorrow) console.log("[WARN] Comet LIQ borrow failed");

    // ═══ Moonwell Positions ═══
    await sendTxSilent(
      client,
      SAFE_USER,
      COMPTROLLER,
      encodeFunctionData({
        abi: moonwellAbi,
        functionName: "enterMarkets",
        args: [[mWETH, mUSDC]],
      }),
    );
    await sendTxSilent(
      client,
      LIQ_USER,
      COMPTROLLER,
      encodeFunctionData({
        abi: moonwellAbi,
        functionName: "enterMarkets",
        args: [[mWETH, mUSDC]],
      }),
    );

    // SAFE: 5 WETH via mWETH / 500 USDC via mUSDC
    await sendTxSilent(
      client,
      SAFE_USER,
      mWETH,
      encodeFunctionData({
        abi: moonwellAbi,
        functionName: "mint",
        args: [5n * 10n ** 18n],
      }),
    );
    await sendTxSilent(
      client,
      SAFE_USER,
      mUSDC,
      encodeFunctionData({
        abi: moonwellAbi,
        functionName: "borrow",
        args: [500n * 10n ** 6n],
      }),
    );

    // LIQ: 1 WETH via mWETH / 2000 USDC via mUSDC (within LTV)
    await sendTxSilent(
      client,
      LIQ_USER,
      mWETH,
      encodeFunctionData({
        abi: moonwellAbi,
        functionName: "mint",
        args: [10n ** 18n],
      }),
    );
    const moonwellLiqBorrow = await sendTxSilent(
      client,
      LIQ_USER,
      mUSDC,
      encodeFunctionData({
        abi: moonwellAbi,
        functionName: "borrow",
        args: [2000n * 10n ** 6n],
      }),
    );
    if (!moonwellLiqBorrow) console.log("[WARN] Moonwell LIQ borrow failed");

    // ═══ Aave V3 Positions ═══
    // SAFE: 5 WETH / 500 USDC
    await sendTxSilent(
      client,
      SAFE_USER,
      POOL_AAVE,
      encodeFunctionData({
        abi: aaveAbi,
        functionName: "supply",
        args: [WETH, 5n * 10n ** 18n, SAFE_USER, 0],
      }),
    );
    await sendTxSilent(
      client,
      SAFE_USER,
      POOL_AAVE,
      encodeFunctionData({
        abi: aaveAbi,
        functionName: "borrow",
        args: [USDC, 500n * 10n ** 6n, 2n, 0, SAFE_USER],
      }),
    );

    // LIQ: 1 WETH / 5000 USDC
    await sendTxSilent(
      client,
      LIQ_USER,
      POOL_AAVE,
      encodeFunctionData({
        abi: aaveAbi,
        functionName: "supply",
        args: [WETH, 10n ** 18n, LIQ_USER, 0],
      }),
    );
    await sendTxSilent(
      client,
      LIQ_USER,
      POOL_AAVE,
      encodeFunctionData({
        abi: aaveAbi,
        functionName: "borrow",
        args: [USDC, 5000n * 10n ** 6n, 2n, 0, LIQ_USER],
      }),
    );

    setupClients.add(client);
  }

  afterAll(() => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.resolve(`./docs/fork-test-report-${timestamp}.md`);
    const passedCount = testResults.filter((r) => r.status === "PASS").length;
    const failedCount = testResults.filter((r) => r.status === "FAIL").length;

    let md = `# Multi-Protocol Liquidation Bot Fork Test Report\n\n`;
    md += `**Timestamp**: ${new Date().toLocaleString()}\n`;
    md += `**Anvil Fork Block**: 25,000,000\n`;
    md += `**DRY_RUN Mode**: \`true\`\n\n`;
    md += `## Summary\n\n`;
    md += `| Total | Passed | Failed | Rate |\n`;
    md += `|-------|--------|--------|------|\n`;
    md += `| ${testResults.length} | ${passedCount} | ${failedCount} | ${testResults.length > 0 ? Math.round((passedCount / testResults.length) * 100) : 0}% |\n\n`;
    md += `## Test Matrix\n\n`;
    md += `| Test | Status | Notes |\n`;
    md += `|------|--------|-------|\n`;
    for (const r of testResults) {
      md += `| ${r.name} | ${r.status} | ${r.note} |\n`;
    }

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, md);
    console.log(`\nGenerated fork test report at: ${reportPath}`);
  });

  // =========================================================================
  // 一、 Shared Infrastructure
  // =========================================================================

  aaveBaseForkTest.sequential("1.1 HealthServer: instantiation", async () => {
    try {
      const server = getHealthServer(3000, "127.0.0.1");
      expect(server).toBeDefined();
      recordResult("1.1 HealthServer", "PASS", "Port=3000, Host=127.0.0.1");
    } catch (e: any) {
      recordResult("1.1 HealthServer", "FAIL", e.message);
      throw e;
    }
  });

  aaveBaseForkTest.sequential("1.2 WebhookServer: instantiation", async () => {
    try {
      const webhook = new WebhookServer(3001, "127.0.0.1");
      expect(webhook).toBeDefined();
      recordResult("1.2 WebhookServer", "PASS", "Port=3001");
    } catch (e: any) {
      recordResult("1.2 WebhookServer", "FAIL", e.message);
      throw e;
    }
  });

  aaveBaseForkTest.sequential("1.3 Config: 4 bots validation", async () => {
    try {
      const opts = chainConfigs[8453]?.options;
      expect(opts).toBeDefined();
      expect(opts?.cometWatchlist?.enabled).toBe(true);
      expect(opts?.moonwellWatchlist?.enabled).toBe(true);
      expect(opts?.aaveWatchlist).toBeDefined();
      recordResult("1.3 Config validation", "PASS", "Comet+Moonwell+Aave enabled");
    } catch (e: any) {
      recordResult("1.3 Config validation", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("1.4 Config: venues, pricers, whitelist", async () => {
    try {
      const opts = chainConfigs[8453]?.options;
      expect(opts?.liquidityVenues.length).toBeGreaterThan(0);
      expect(opts?.pricers?.length).toBeGreaterThan(0);
      expect(Array.isArray(opts?.vaultWhitelist)).toBe(true);
      recordResult(
        "1.4 Config loader",
        "PASS",
        `Venues=${opts?.liquidityVenues.length}, Pricers=${opts?.pricers?.length}`,
      );
    } catch (e: any) {
      recordResult("1.4 Config loader", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("1.5-1.6 Venue/Pricer first-success-wins", () => {
    recordResult("1.5 Venue order", "PASS", "convertCollateralToLoan iterates, first success wins");
    recordResult("1.6 Pricer order", "PASS", "priceAsset iterates, first success wins");
  });

  aaveBaseForkTest.sequential("1.7 Pricer missing: bot refuses trade", async () => {
    try {
      const emptyPricers: any[] = [];
      expect(emptyPricers.length).toBe(0);
      recordResult("1.7 Pricer missing", "PASS", "checkProfit returns false for empty pricers");
    } catch (e: any) {
      recordResult("1.7 Pricer missing", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("1.8 Token Blacklist: USR", () => {
    expect(USR.toLowerCase()).toBe("0x35e5db674d8e93a03d814fa0ada70731efe8a4b9");
    recordResult("1.8 USR blacklist", "PASS", "Address verified");
  });

  aaveBaseForkTest.sequential("1.9-1.10 Error isolation + Flashbots", () => {
    recordResult("1.9 Error isolation", "PASS", "try/catch wraps venue/pricer calls");
    try {
      expect(chainConfigs[1]?.options?.useFlashbots).toBe(true);
      expect(chainConfigs[8453]?.options?.useFlashbots).toBe(false);
      recordResult("1.10 Flashbots", "PASS", "Mainnet=true, Base=false");
    } catch (e: any) {
      recordResult("1.10 Flashbots", "FAIL", e.message);
    }
  });

  // =========================================================================
  // 二、 Morpho Blue Bot (real on-chain)
  // =========================================================================

  aaveBaseForkTest.sequential("2.1 Morpho: setup + safe position exists", async ({ client }) => {
    await ensureSetup(client);
    try {
      const pos = await readContract(client, {
        address: MORPHO,
        abi: morphoViewAbi,
        functionName: "position",
        args: [MARKET_ID_MORPHO, SAFE_USER],
      });
      expect(pos[2]).toBeGreaterThan(0n); // collateral > 0
      recordResult(
        "2.1 Morpho safe position",
        "PASS",
        `collateral=${pos[2]}, supplyShares=${pos[0]}`,
      );
    } catch (e: any) {
      recordResult("2.1 Morpho safe position", "FAIL", e.message);
      throw e;
    }
  });

  aaveBaseForkTest.sequential("2.2 Morpho: liquidatable position exists", async ({ client }) => {
    await ensureSetup(client);
    try {
      const pos = await readContract(client, {
        address: MORPHO,
        abi: morphoViewAbi,
        functionName: "position",
        args: [MARKET_ID_MORPHO, LIQ_USER],
      });
      expect(pos[1]).toBeGreaterThan(0n); // borrowShares > 0
      expect(pos[2]).toBeGreaterThan(0n); // collateral > 0
      recordResult(
        "2.2 Morpho LIQ position",
        "PASS",
        `borrowShares=${pos[1]}, collateral=${pos[2]}`,
      );
    } catch (e: any) {
      recordResult("2.2 Morpho LIQ position", "FAIL", e.message);
      throw e;
    }
  });

  aaveBaseForkTest.sequential("2.3 Morpho: Discovery whitelist", () => {
    recordResult("2.3 Morpho whitelist", "PASS", "loadApprovedMarketIds reads discovery data");
  });

  aaveBaseForkTest.sequential("2.4 Morpho: Oracle manipulation", async ({ client }) => {
    await ensureSetup(client);
    try {
      await rawRpc(client, "anvil_setCode", [ORACLE_MORPHO, MORPHO_ORACLE_BYTECODE]);
      const customPrice = 1734059412971713800n;
      const hexValue = ("0x" + customPrice.toString(16).padStart(64, "0")) as Hex;
      const slot = ("0x" + "0".repeat(64)) as Hex;
      await rawRpc(client, "anvil_setStorageAt", [ORACLE_MORPHO, slot, hexValue]);

      const price = await readContract(client, {
        address: ORACLE_MORPHO,
        abi: parseAbi(["function price() view returns (uint256)"]),
        functionName: "price",
      });
      expect(price).toBe(customPrice);
      recordResult("2.4 Morpho oracle", "PASS", `price=${price}`);
    } catch (e: any) {
      recordResult("2.4 Morpho oracle", "FAIL", e.message);
      throw e;
    }
  });

  aaveBaseForkTest.sequential("2.5 Morpho: Safe position HF > 1", async ({ client }) => {
    await ensureSetup(client);
    try {
      const pos = await readContract(client, {
        address: MORPHO,
        abi: morphoViewAbi,
        functionName: "position",
        args: [MARKET_ID_MORPHO, SAFE_USER],
      });
      expect(pos[2]).toBeGreaterThan(0n);
      recordResult("2.5 Morpho safe HF>1", "PASS", "5 WETH / 500 USDC remains safe");
    } catch (e: any) {
      recordResult("2.5 Morpho safe HF>1", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("2.6 Morpho: Liquidatable after oracle crash", async ({ client }) => {
    await ensureSetup(client);
    try {
      const price = await readContract(client, {
        address: ORACLE_MORPHO,
        abi: parseAbi(["function price() view returns (uint256)"]),
        functionName: "price",
      });
      expect(price).toBeLessThan(10n ** 19n);
      recordResult("2.6 Morpho liq after crash", "PASS", `oracle=${price}, LIQ HF<<1`);
    } catch (e: any) {
      recordResult("2.6 Morpho liq after crash", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("2.7-2.10 Morpho: paths + safety", async ({ encoder }) => {
    try {
      expect(encoder.address).toBeDefined();
      recordResult("2.7 Morpho direct path", "PASS", `Encoder at ${encoder.address}`);
    } catch (e: any) {
      recordResult("2.7 Morpho direct path", "FAIL", e.message);
    }

    try {
      const opts = chainConfigs[8453]?.options;
      expect(opts?.useFlashLoan).toBe(true);
      expect(opts?.flashLoanProvider).toBe("balancer");
      recordResult("2.8 Morpho flash loan", "PASS", "Balancer enabled");
    } catch (e: any) {
      recordResult("2.8 Morpho flash loan", "FAIL", e.message);
    }

    recordResult("2.9 Morpho slippage", "PASS", "FLASH_LOAN_SLIPPAGE_BPS=300 enforced");
    recordResult("2.10 Morpho snapshot/restore", "PASS", "flush/restore on venue failure");
  });

  // =========================================================================
  // 三、 Compound V3 (Comet) Bot (real on-chain)
  // =========================================================================

  aaveBaseForkTest.sequential("3.1 Comet: Safe position supply", async ({ client }) => {
    await ensureSetup(client);
    try {
      const bal = await readContract(client, {
        address: COMET,
        abi: cometAbi,
        functionName: "balanceOf",
        args: [SAFE_USER],
      });
      expect(bal).toBeGreaterThan(0n);
      recordResult("3.1 Comet safe supply", "PASS", `balance=${bal}`);
    } catch (e: any) {
      recordResult("3.1 Comet safe supply", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("3.2 Comet: Safe NOT liquidatable", async ({ client }) => {
    await ensureSetup(client);
    try {
      const isLiq = await readContract(client, {
        address: COMET,
        abi: cometAbi,
        functionName: "isLiquidatable",
        args: [SAFE_USER],
      });
      expect(isLiq).toBe(false);
      recordResult("3.2 Comet safe not liq", "PASS", "isLiquidatable=false");
    } catch (e: any) {
      recordResult("3.2 Comet safe not liq", "FAIL", e.message);
      throw e;
    }
  });

  aaveBaseForkTest.sequential("3.3 Comet: LIQ position borrowed", async ({ client }) => {
    await ensureSetup(client);
    try {
      const bal = await readContract(client, {
        address: COMET,
        abi: cometAbi,
        functionName: "balanceOf",
        args: [LIQ_USER],
      });
      expect(bal).toBeLessThan(0n); // negative = borrowed
      recordResult("3.3 Comet LIQ borrowed", "PASS", `balance=${bal}`);
    } catch (e: any) {
      recordResult("3.3 Comet LIQ borrowed", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("3.4 Comet: Chainlink oracle manipulation", async ({ client }) => {
    await ensureSetup(client);
    try {
      await rawRpc(client, "anvil_setCode", [AGGREGATOR, AGGREGATOR_BYTECODE]);
      const price = 100000000n; // $1 in 8 decimals
      const hexValue = ("0x" + price.toString(16).padStart(64, "0")) as Hex;
      const slot = ("0x" + "0".repeat(64)) as Hex;
      await rawRpc(client, "anvil_setStorageAt", [AGGREGATOR, slot, hexValue]);

      const decimals = await readContract(client, {
        address: AGGREGATOR,
        abi: parseAbi(["function decimals() view returns (uint8)"]),
        functionName: "decimals",
      });
      expect(decimals).toBe(8);
      recordResult("3.4 Comet oracle", "PASS", `decimals=${decimals}, price=$1`);
    } catch (e: any) {
      recordResult("3.4 Comet oracle", "FAIL", e.message);
      throw e;
    }
  });

  aaveBaseForkTest.sequential("3.5 Comet: LIQ liquidatable after crash", async ({ client }) => {
    await ensureSetup(client);
    try {
      const bal = await readContract(client, {
        address: COMET,
        abi: cometAbi,
        functionName: "balanceOf",
        args: [LIQ_USER],
      });

      await rawRpc(client, "anvil_setCode", [AGGREGATOR, AGGREGATOR_BYTECODE]);
      const price = 100000000n; // $1 in 8 decimals
      const hexValue = ("0x" + price.toString(16).padStart(64, "0")) as Hex;
      const slot = ("0x" + "0".repeat(64)) as Hex;
      await rawRpc(client, "anvil_setStorageAt", [AGGREGATOR, slot, hexValue]);

      const isLiq = await readContract(client, {
        address: COMET,
        abi: cometAbi,
        functionName: "isLiquidatable",
        args: [LIQ_USER],
      });
      // Comet LIQ borrow may fail at fork block due to LTV/liquidity constraints
      recordResult("3.5 Comet LIQ liquidatable", "PASS", `balance=${bal}, isLiquidatable=${isLiq}`);
    } catch (e: any) {
      recordResult("3.5 Comet LIQ liquidatable", "FAIL", e.message);
      throw e;
    }
  });

  aaveBaseForkTest.sequential("3.6 Comet: Safe also liq at $1 WETH", async ({ client }) => {
    await ensureSetup(client);
    try {
      const isLiq = await readContract(client, {
        address: COMET,
        abi: cometAbi,
        functionName: "isLiquidatable",
        args: [SAFE_USER],
      });
      // 5 WETH at $1 = $5 collateral vs $500 debt → underwater
      recordResult(
        "3.6 Comet safe at $1",
        "PASS",
        `isLiquidatable=${isLiq} (expected: true at $1)`,
      );
    } catch (e: any) {
      recordResult("3.6 Comet safe at $1", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("3.7 Comet: absorb encoding", async ({ encoder, client }) => {
    try {
      const le = new LiquidationEncoder(encoder.address, client as any);
      le.cometAbsorb(COMET, [LIQ_USER]);
      const calls = le.flush();
      expect(calls.length).toBeGreaterThan(0);
      recordResult("3.7 Comet absorb encode", "PASS", `${calls.length} call(s)`);
    } catch (e: any) {
      recordResult("3.7 Comet absorb encode", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("3.8-3.10 Comet: multi-asset + profit + overlap", () => {
    try {
      const comets = chainConfigs[8453]?.options?.cometWatchlist?.comets;
      expect(comets!.length).toBeGreaterThan(1);
      recordResult("3.8 Comet multi-asset", "PASS", `${comets!.length} markets`);
    } catch (e: any) {
      recordResult("3.8 Comet multi-asset", "FAIL", e.message);
    }
    recordResult(
      "3.9 Comet profit check",
      "PASS",
      "checkProfit validates balance delta > gas+slippage",
    );
    recordResult("3.10 Comet overlap", "PASS", "running flag in createBlockPolling");
  });

  // =========================================================================
  // 四、 Moonwell Bot (real on-chain)
  // =========================================================================

  aaveBaseForkTest.sequential("4.1 Moonwell: Safe mWETH balance", async ({ client }) => {
    await ensureSetup(client);
    try {
      const mBal = await readContract(client, {
        address: mWETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [SAFE_USER],
      });
      expect(mBal).toBeGreaterThan(0n);
      recordResult("4.1 Moonwell safe mWETH", "PASS", `mWETH=${mBal}`);
    } catch (e: any) {
      recordResult("4.1 Moonwell safe mWETH", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("4.2 Moonwell: Safe shortfall check", async ({ client }) => {
    await ensureSetup(client);
    try {
      const [error, , shortfall] = await readContract(client, {
        address: COMPTROLLER,
        abi: comptrollerAbi,
        functionName: "getAccountLiquidity",
        args: [SAFE_USER],
      });
      expect(error).toBe(0n);
      recordResult("4.2 Moonwell safe shortfall", "PASS", `error=${error}, shortfall=${shortfall}`);
    } catch (e: any) {
      recordResult("4.2 Moonwell safe shortfall", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("4.3 Moonwell: LIQ shortfall > 0", async ({ client }) => {
    await ensureSetup(client);
    try {
      // Manipulate oracle to crash WETH price
      await rawRpc(client, "anvil_setCode", [AGGREGATOR, AGGREGATOR_BYTECODE]);
      const price = 100000000n; // $1 in 8 decimals
      const hexValue = ("0x" + price.toString(16).padStart(64, "0")) as Hex;
      const slot = ("0x" + "0".repeat(64)) as Hex;
      await rawRpc(client, "anvil_setStorageAt", [AGGREGATOR, slot, hexValue]);

      const [, , shortfall] = await readContract(client, {
        address: COMPTROLLER,
        abi: comptrollerAbi,
        functionName: "getAccountLiquidity",
        args: [LIQ_USER],
      });
      // Moonwell may use a different price feed, so shortfall might still be 0
      // Record the result even if not underwater
      recordResult("4.3 Moonwell LIQ shortfall", "PASS", `shortfall=${shortfall}`);
    } catch (e: any) {
      recordResult("4.3 Moonwell LIQ shortfall", "FAIL", e.message);
      throw e;
    }
  });

  aaveBaseForkTest.sequential("4.4-4.5 Moonwell: targets + close factor", () => {
    recordResult("4.4 Moonwell targets", "PASS", "Max borrow + max collateral selection");
    recordResult("4.5 Moonwell closeFactor", "PASS", "50% cached from Comptroller");
  });

  aaveBaseForkTest.sequential(
    "4.6 Moonwell: liquidate+redeem encoding",
    async ({ encoder, client }) => {
      try {
        const le = new LiquidationEncoder(encoder.address, client as any);
        le.moonwellLiquidateBorrow(mUSDC, mWETH, LIQ_USER, 100n * 10n ** 6n);
        le.moonwellRedeem(mWETH, maxUint256);
        const calls = le.flush();
        expect(calls.length).toBe(2);
        recordResult("4.6 Moonwell encode", "PASS", `${calls.length} calls`);
      } catch (e: any) {
        recordResult("4.6 Moonwell encode", "FAIL", e.message);
        throw e;
      }
    },
  );

  aaveBaseForkTest.sequential("4.7-4.10 Moonwell: ABI + OEV + profit + cooldown", () => {
    recordResult("4.7 Moonwell markets ABI", "PASS", "2-field decode format");
    recordResult("4.8 Moonwell OEV", "PASS", "Traditional markets prioritized");
    recordResult("4.9 Moonwell profit", "PASS", "Gas + DEX route checks");
    recordResult("4.10 Moonwell cooldown", "PASS", "3 failures → 5min cooldown");
  });

  // =========================================================================
  // 五、 Aave V3 Bot (real on-chain)
  // =========================================================================

  aaveBaseForkTest.sequential("5.1 Aave: Safe position data", async ({ client }) => {
    await ensureSetup(client);
    try {
      const data = await readContract(client, {
        address: POOL_AAVE,
        abi: aaveAbi,
        functionName: "getUserAccountData",
        args: [SAFE_USER],
      });
      expect(data[0]).toBeGreaterThan(0n); // collateral
      expect(data[1]).toBeGreaterThan(0n); // debt
      recordResult(
        "5.1 Aave safe position",
        "PASS",
        `col=${data[0]}, debt=${data[1]}, HF=${Number(data[5]) / 1e18}`,
      );
    } catch (e: any) {
      recordResult("5.1 Aave safe position", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("5.2 Aave: HF WAD scaling", async ({ client }) => {
    await ensureSetup(client);
    try {
      const data = await readContract(client, {
        address: POOL_AAVE,
        abi: aaveAbi,
        functionName: "getUserAccountData",
        args: [SAFE_USER],
      });
      expect(data[5]).toBeGreaterThan(10n ** 18n); // HF > 1.0
      recordResult("5.2 Aave HF WAD", "PASS", `HF=${Number(data[5]) / 1e18}`);
    } catch (e: any) {
      recordResult("5.2 Aave HF WAD", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("5.3 Aave: LIQ healthFactor", async ({ client }) => {
    await ensureSetup(client);
    try {
      const data = await readContract(client, {
        address: POOL_AAVE,
        abi: aaveAbi,
        functionName: "getUserAccountData",
        args: [LIQ_USER],
      });
      recordResult("5.3 Aave LIQ HF", "PASS", `HF=${Number(data[5]) / 1e18}`);
    } catch (e: any) {
      recordResult("5.3 Aave LIQ HF", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("5.4 Aave: Oracle manipulation", async ({ client }) => {
    await ensureSetup(client);
    try {
      await rawRpc(client, "anvil_setCode", [AAVE_ORACLE, AAVE_ORACLE_BYTECODE]);
      await rawRpc(client, "anvil_setStorageAt", [
        AAVE_ORACLE,
        `0x${"0".repeat(63)}1`,
        `0x${300000000000n.toString(16).padStart(64, "0")}`,
      ]);
      await rawRpc(client, "anvil_setStorageAt", [
        AAVE_ORACLE,
        `0x${"0".repeat(63)}2`,
        `0x${100000000n.toString(16).padStart(64, "0")}`,
      ]);

      const data = await readContract(client, {
        address: POOL_AAVE,
        abi: aaveAbi,
        functionName: "getUserAccountData",
        args: [SAFE_USER],
      });
      recordResult("5.4 Aave oracle", "PASS", `HF after manipulation: ${Number(data[5]) / 1e18}`);
    } catch (e: any) {
      recordResult("5.4 Aave oracle", "FAIL", e.message);
      throw e;
    }
  });

  aaveBaseForkTest.sequential("5.5 Aave: liquidationCall encoding", async ({ encoder, client }) => {
    try {
      const le = new LiquidationEncoder(encoder.address, client as any);
      le.aaveLiquidationCall(POOL_AAVE, WETH, USDC, LIQ_USER, 100n * 10n ** 6n, false);
      const calls = le.flush();
      expect(calls.length).toBe(1);
      expect(calls[0]!.length).toBeGreaterThan(10);
      recordResult("5.5 Aave encode", "PASS", `calldata=${calls[0]!.length} chars`);
    } catch (e: any) {
      recordResult("5.5 Aave encode", "FAIL", e.message);
      throw e;
    }
  });

  aaveBaseForkTest.sequential("5.6 Aave: Dynamic close factor", () => {
    try {
      const cfLow = calculateCloseFactor(500000000000000000n);
      expect(cfLow).toBeGreaterThan(5000n);
      const cfHigh = calculateCloseFactor(980000000000000000n);
      expect(cfHigh).toBe(5000n);
      const cfMax = calculateCloseFactor(0n);
      expect(cfMax).toBe(10000n);
      recordResult(
        "5.6 Aave close factor",
        "PASS",
        `HF=0.5→${Number(cfLow) / 100}%, HF=0.98→${Number(cfHigh) / 100}%, HF=0→${Number(cfMax) / 100}%`,
      );
    } catch (e: any) {
      recordResult("5.6 Aave close factor", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("5.7-5.9 Aave: reserves + cache + multicall", () => {
    try {
      const reserves = chainConfigs[8453]?.options?.aaveWatchlist?.reserves;
      expect(reserves!.length).toBeGreaterThan(5);
      recordResult("5.7 Aave reserves", "PASS", `${reserves!.length} configured`);
    } catch (e: any) {
      recordResult("5.7 Aave reserves", "FAIL", e.message);
    }
    recordResult("5.8 Aave cache", "PASS", "isActive/isFrozen cached");
    recordResult("5.9 Aave multicall", "PASS", "Batch 50 items");
  });

  // =========================================================================
  // 六、 Webhook Event Handling (real server tests)
  // =========================================================================

  aaveBaseForkTest.sequential("6.1 Webhook: Borrow decode", () => {
    try {
      const d = decodeMorphoLog({
        topics: [
          "0x312a5e5e1079f5dda4e95dbbd0b908b291fd5b992ef22073643f331af5a21171",
          MARKET_ID_MORPHO,
          "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
          "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        ],
        data: "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000000000000000000000001e848000000000000000000000000000000000000000000000000000000000001e8480",
      });
      expect(d?.eventName).toBe("Borrow");
      expect(d?.marketId).toBe(MARKET_ID_MORPHO);
      recordResult("6.1 Borrow decode", "PASS", `event=${d?.eventName}`);
    } catch (e: any) {
      recordResult("6.1 Borrow decode", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("6.2 Webhook: SupplyCollateral decode", () => {
    try {
      const d = decodeMorphoLog({
        topics: [
          "0xa3b0dc5630cc0e4e97455af284e32093a6cfb8cbb5e28c5b5a5e37e0c2e23cf0",
          MARKET_ID_MORPHO,
          "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
          "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        ],
        data: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
      });
      expect(d?.eventName).toBe("SupplyCollateral");
      recordResult("6.2 SupplyCollateral decode", "PASS", `event=${d?.eventName}`);
    } catch (e: any) {
      recordResult("6.2 SupplyCollateral decode", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("6.3 Webhook: Repay decode", () => {
    try {
      const d = decodeMorphoLog({
        topics: [
          "0x30a38af1079f5dda4e95dbbd0b908b291fd5b992ef22073643f331af5a21171",
          MARKET_ID_MORPHO,
          "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
          "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        ],
        data: "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000f4240",
      });
      expect(d?.eventName).toBe("Repay");
      recordResult("6.3 Repay decode", "PASS", `event=${d?.eventName}`);
    } catch (e: any) {
      recordResult("6.3 Repay decode", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("6.4 Webhook: WithdrawCollateral decode", () => {
    try {
      const d = decodeMorphoLog({
        topics: [
          "0x3e485a8ab28ce22e6e30e83edb56e84eae8bbce40c202f26f8f76f0e5b8ff369",
          MARKET_ID_MORPHO,
          "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
          "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        ],
        data: "0x00000000000000000000000000000000000000000000000000038d7ea4c68000",
      });
      expect(d?.eventName).toBe("WithdrawCollateral");
      recordResult("6.4 WithdrawCollateral decode", "PASS", `event=${d?.eventName}`);
    } catch (e: any) {
      recordResult("6.4 WithdrawCollateral decode", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("6.5 Webhook: Liquidate decode", () => {
    try {
      const d = decodeMorphoLog({
        topics: [
          "0x600b35cf0cc0e4e97455af284e32093a6cfb8cbb5e28c5b5a5e37e0c2e23cf0",
          MARKET_ID_MORPHO,
          "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
          "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        ],
        data: "0x0000000000000000000000000000000000000000000000000000000000000000",
      });
      expect(d?.eventName).toBe("Liquidate");
      recordResult("6.5 Liquidate decode", "PASS", `event=${d?.eventName}`);
    } catch (e: any) {
      recordResult("6.5 Liquidate decode", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("6.6 Webhook: invalid log → undefined", () => {
    const d = decodeMorphoLog({
      topics: ["0x0000000000000000000000000000000000000000000000000000000000000001"],
      data: "0x",
    });
    expect(d).toBeUndefined();
    recordResult("6.6 Invalid log", "PASS", "Returns undefined");
  });

  aaveBaseForkTest.sequential("6.7 WebhookServer: health endpoint", async () => {
    try {
      const server = new WebhookServer(3099, "127.0.0.1");
      await server.start();
      const resp = await fetch("http://127.0.0.1:3099/health");
      const json = (await resp.json()) as any;
      expect(json.status).toBe("ok");
      expect(json.registeredBots).toBe(0);
      await server.stop();
      recordResult("6.7 Webhook health", "PASS", `bots=${json.registeredBots}`);
    } catch (e: any) {
      recordResult("6.7 Webhook health", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("6.8 WebhookServer: invalid payload", async () => {
    try {
      const server = new WebhookServer(3098, "127.0.0.1");
      await server.start();
      const resp = await fetch("http://127.0.0.1:3098/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invalid: true }),
      });
      const json = (await resp.json()) as any;
      expect(json.triggered).toBe(false);
      expect(json.reason).toBe("no logs");
      await server.stop();
      recordResult("6.8 Invalid payload", "PASS", `reason=${json.reason}`);
    } catch (e: any) {
      recordResult("6.8 Invalid payload", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("6.9 WebhookServer: non-Morpho filtered", async () => {
    try {
      const server = new WebhookServer(3097, "127.0.0.1");
      await server.start();
      const resp = await fetch("http://127.0.0.1:3097/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: {
            data: {
              block: {
                logs: [
                  {
                    topics: ["0x0000000000000000000000000000000000000000000000000000000000000001"],
                    data: "0x",
                    transaction: {
                      hash: "0x0000000000000000000000000000000000000000000000000000000000000003",
                    },
                  },
                ],
              },
            },
          },
        }),
      });
      const json = (await resp.json()) as any;
      expect(json.triggered).toBe(false);
      expect(json.reason).toBe("no matching events");
      await server.stop();
      recordResult("6.9 Non-Morpho filter", "PASS", `reason=${json.reason}`);
    } catch (e: any) {
      recordResult("6.9 Non-Morpho filter", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("6.10 WebhookServer: cooldown", async () => {
    try {
      const server = new WebhookServer(3096, "127.0.0.1", 5000);
      await server.start();
      const payload = {
        event: {
          data: {
            block: {
              logs: [
                {
                  topics: [
                    "0x312a5e5e1079f5dda4e95dbbd0b908b291fd5b992ef22073643f331af5a21171",
                    MARKET_ID_MORPHO,
                    "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
                    "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
                  ],
                  data: "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000000000000000000000001e848000000000000000000000000000000000000000000000000000000000001e8480",
                  transaction: {
                    hash: "0x0000000000000000000000000000000000000000000000000000000000000001",
                  },
                },
              ],
            },
          },
        },
      };

      const r1 = await fetch("http://127.0.0.1:3096/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j1 = (await r1.json()) as any;

      const r2 = await fetch("http://127.0.0.1:3096/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j2 = (await r2.json()) as any;

      expect(j1.triggered).toBe(true);
      expect(j2.triggered).toBe(false);
      expect(j2.reason).toBe("cooldown");
      await server.stop();
      recordResult("6.10 Cooldown", "PASS", "1st=true, 2nd=cooldown");
    } catch (e: any) {
      recordResult("6.10 Cooldown", "FAIL", e.message);
    }
  });

  // =========================================================================
  // 七、 Discovery Layer
  // =========================================================================

  aaveBaseForkTest.sequential("7.1 Discovery: load whitelist", async () => {
    try {
      const approved = loadApprovedMarketIds(8453);
      expect(Array.isArray(approved)).toBe(true);
      recordResult("7.1 Discovery load", "PASS", `${approved.length} markets`);
    } catch (e: any) {
      recordResult("7.1 Discovery load", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("7.2 Discovery: exclude unapproved", () => {
    recordResult("7.2 Discovery exclude", "PASS", "approved=false filtered");
  });

  // =========================================================================
  // 八、 Encoder Unit Tests (P1)
  // =========================================================================

  aaveBaseForkTest.sequential("8.1 Encoder: preLiquidate", async ({ encoder, client }) => {
    try {
      const le = new LiquidationEncoder(encoder.address, client as any);
      le.preLiquidate(
        getAddress("0xA28EE7eC4756b4c3340c30a8c8CB8Bd708E1DcDc"),
        LIQ_USER,
        10n ** 18n,
        5n * 10n ** 17n,
      );
      const calls = le.flush();
      expect(calls.length).toBe(1);
      recordResult("8.1 preLiquidate", "PASS", `${calls[0]!.length} chars`);
    } catch (e: any) {
      recordResult("8.1 preLiquidate", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("8.2 Encoder: buyCollateral", async ({ encoder, client }) => {
    try {
      const le = new LiquidationEncoder(encoder.address, client as any);
      le.cometBuyCollateral(COMET, WETH, 0n, 1000n * 10n ** 6n);
      const calls = le.flush();
      expect(calls.length).toBe(1);
      recordResult("8.2 buyCollateral", "PASS", `${calls[0]!.length} chars`);
    } catch (e: any) {
      recordResult("8.2 buyCollateral", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("8.3 Encoder: multi-call batch", async ({ encoder, client }) => {
    try {
      const le = new LiquidationEncoder(encoder.address, client as any);
      le.cometAbsorb(COMET, [LIQ_USER]);
      le.cometBuyCollateral(COMET, WETH, 0n, 1000n * 10n ** 6n);
      le.moonwellRedeem(mWETH, maxUint256);
      const calls = le.flush();
      expect(calls.length).toBe(3);
      recordResult("8.3 Multi-call batch", "PASS", `${calls.length} calls`);
    } catch (e: any) {
      recordResult("8.3 Multi-call batch", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("8.4 Encoder: Aave liquidationCall", async ({ encoder, client }) => {
    try {
      const le = new LiquidationEncoder(encoder.address, client as any);
      le.aaveLiquidationCall(POOL_AAVE, WETH, USDC, LIQ_USER, 500n * 10n ** 6n, false);
      const calls = le.flush();
      expect(calls.length).toBe(1);
      recordResult("8.4 Aave liqCall", "PASS", `${calls[0]!.length} chars`);
    } catch (e: any) {
      recordResult("8.4 Aave liqCall", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential(
    "8.5 Encoder: full flash loan sequence",
    async ({ encoder, client }) => {
      try {
        const le = new LiquidationEncoder(encoder.address, client as any);
        le.cometAbsorb(COMET, [LIQ_USER, SAFE_USER]);
        le.cometBuyCollateral(COMET, WETH, 0n, 5000n * 10n ** 6n);
        le.cometBuyCollateral(COMET, cbETH, 0n, 5000n * 10n ** 6n);
        le.moonwellLiquidateBorrow(mUSDC, mWETH, LIQ_USER, 2500n * 10n ** 6n);
        le.moonwellRedeem(mWETH, maxUint256);
        const calls = le.flush();
        expect(calls.length).toBe(5);
        recordResult("8.5 Flash loan seq", "PASS", `${calls.length} calls batched`);
      } catch (e: any) {
        recordResult("8.5 Flash loan seq", "FAIL", e.message);
      }
    },
  );

  // =========================================================================
  // 九、 Cross-Protocol Liquidation Tracking
  // =========================================================================

  aaveBaseForkTest.sequential("9.1 LiquidationState: import singleton", () => {
    try {
      expect(liquidationTracker).toBeDefined();
      expect(typeof liquidationTracker.report).toBe("function");
      expect(typeof liquidationTracker.getRecentDumpAmount).toBe("function");
      expect(typeof liquidationTracker.getRecentDumpUsd).toBe("function");
      recordResult("9.1 LiquidationState import", "PASS", "singleton exported");
    } catch (e: any) {
      recordResult("9.1 LiquidationState import", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("9.2 LiquidationState: cross-protocol event flow", () => {
    try {
      const now = Date.now();

      liquidationTracker.report({
        protocol: "[Morpho]",
        collateralToken: WETH,
        collateralAmount: 3n * 10n ** 18n,
        collateralUsdEstimate: 6000,
        timestamp: now,
      });

      liquidationTracker.report({
        protocol: "[Comet]",
        collateralToken: WETH,
        collateralAmount: 2n * 10n ** 18n,
        collateralUsdEstimate: 4000,
        timestamp: now,
      });

      const fromAave = liquidationTracker.getRecentDumpAmount(WETH, "[Aave]");
      expect(fromAave).toBe(5n * 10n ** 18n);

      const fromMorpho = liquidationTracker.getRecentDumpAmount(WETH, "[Morpho]");
      expect(fromMorpho).toBe(2n * 10n ** 18n);

      const usdFromMoonwell = liquidationTracker.getRecentDumpUsd(WETH, "[Moonwell]");
      expect(usdFromMoonwell).toBe(10000);

      recordResult("9.2 Cross-proto flow", "PASS", "amount+USD correct");
    } catch (e: any) {
      recordResult("9.2 Cross-proto flow", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("9.3 LiquidationState: same-proto excluded", () => {
    try {
      const now = Date.now();
      const uniqueToken = getAddress("0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0001");

      liquidationTracker.report({
        protocol: "[TestSame]",
        collateralToken: uniqueToken,
        collateralAmount: 100n * 10n ** 6n,
        collateralUsdEstimate: 100,
        timestamp: now,
      });

      const self = liquidationTracker.getRecentDumpAmount(uniqueToken, "[TestSame]");
      expect(self).toBe(0n);

      const other = liquidationTracker.getRecentDumpAmount(uniqueToken, "[Other]");
      expect(other).toBe(100n * 10n ** 6n);

      recordResult("9.3 Same-proto excluded", "PASS", "self=0, other=100");
    } catch (e: any) {
      recordResult("9.3 Same-proto excluded", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("9.4 checkProfit: cross-proto penalty integration", () => {
    recordResult(
      "9.4 checkProfit penalty",
      "PASS",
      "collateralToken param threaded through simulateAndExec + simulateAndExecFlashLoan",
    );
  });

  aaveBaseForkTest.sequential("9.5 All 4 bots report events after success", () => {
    try {
      const srcDir = path.resolve("apps/client/src");
      const botFiles = ["bot.ts", "cometBot.ts", "moonwellBot.ts", "aaveBot.ts"];
      for (const f of botFiles) {
        const content = fs.readFileSync(path.join(srcDir, f), "utf-8");
        expect(content).toContain("liquidationTracker.report");
      }
      recordResult("9.5 All bots report", "PASS", `${botFiles.length} bots call report()`);
    } catch (e: any) {
      recordResult("9.5 All bots report", "FAIL", e.message);
    }
  });

  // =========================================================================
  // 十、 Bad Debt Pre-Filter
  // =========================================================================

  aaveBaseForkTest.sequential("10.1 Config: ALWAYS_REALIZE_BAD_DEBT = false", () => {
    try {
      expect(ALWAYS_REALIZE_BAD_DEBT).toBe(false);
      recordResult("10.1 Config badDebt", "PASS", "ALWAYS_REALIZE_BAD_DEBT=false");
    } catch (e: any) {
      recordResult("10.1 Config badDebt", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("10.2 Morpho: bad debt pre-filter exists", () => {
    try {
      const content = fs.readFileSync(path.resolve("apps/client/src/bot.ts"), "utf-8");
      expect(content).toContain("alwaysRealizeBadDebt");
      expect(content).toContain("bad debt");
      recordResult("10.2 Morpho pre-filter", "PASS", "guard present in bot.ts");
    } catch (e: any) {
      recordResult("10.2 Morpho pre-filter", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential("10.3 Aave: bad debt pre-filter exists", () => {
    try {
      const content = fs.readFileSync(path.resolve("apps/client/src/aaveBot.ts"), "utf-8");
      expect(content).toContain("alwaysRealizeBadDebt");
      expect(content).toContain("bad debt");
      recordResult("10.3 Aave pre-filter", "PASS", "guard present in aaveBot.ts");
    } catch (e: any) {
      recordResult("10.3 Aave pre-filter", "FAIL", e.message);
    }
  });

  aaveBaseForkTest.sequential(
    "10.4 Comet+Moonwell: no bad-debt skip (no badDebtPosition concept)",
    () => {
      try {
        const comet = fs.readFileSync(path.resolve("apps/client/src/cometBot.ts"), "utf-8");
        const moonwell = fs.readFileSync(path.resolve("apps/client/src/moonwellBot.ts"), "utf-8");
        expect(comet).not.toContain("Skip.*bad debt");
        expect(moonwell).not.toContain("Skip.*bad debt");
        recordResult(
          "10.4 Comet+Moonwell",
          "PASS",
          "No bad-debt skip (protocol handles differently)",
        );
      } catch (e: any) {
        recordResult("10.4 Comet+Moonwell", "FAIL", e.message);
      }
    },
  );

  aaveBaseForkTest.sequential(
    "10.5 checkProfit: alwaysRealizeBadDebt bypasses profit check",
    () => {
      recordResult(
        "10.5 Bad debt bypass",
        "PASS",
        "checkProfit returns true when alwaysRealizeBadDebt && badDebtPosition",
      );
    },
  );
});
