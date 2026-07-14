/**
 * P0 fork validation (Base anvil fork)
 *
 * 1. selectBestLiquidationPair on real HF<1 Aave position → non-null pair
 * 2. Comet estimateDebt formula ≈ borrowBalanceOf (rel error < 1%)
 * 3. Aerodrome WETH→USDC convert encodes amountOut > 0 (not swap(0,0) success)
 *
 * RPC: FORK_RPC_URL | RPC_URL_BASE | RPC_URL_8453 (see test/setup.ts)
 */
import { AerodromeVenue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import { executorAbi } from "executooor-viem";
import {
  type Hex,
  getAddress,
  parseAbi,
  maxUint256,
  encodeFunctionData,
  decodeFunctionData,
} from "viem";
import { readContract } from "viem/actions";
import { describe, expect } from "vitest";

import {
  HEALTH_FACTOR_THRESHOLD,
  aavePoolViewAbi,
  resolveAaveProtocolDataProvider,
} from "../../src/abis/AaveV3.js";
import { cometViewAbi } from "../../src/abis/Comet.js";
import { selectBestLiquidationPair } from "../../src/utils/aaveAssetPairSelector.js";
import { aaveBaseForkTest } from "../setup.js";

const POOL = getAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
const WETH = getAddress("0x4200000000000000000000000000000000000006");
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const COMET_USDC = getAddress("0xb125E6687d4313864e53df431d5425969c15Eb2F");
const AAVE_ORACLE = getAddress("0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156");
const TEST_USER = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
const LIQ_USER = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");

// Custom AaveOracle: getAssetPrice → storage[2] for WETH else storage[1]
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

const aerodromePoolAbi = parseAbi([
  "function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)",
  "function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)",
  "function token0() view returns (address)",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createAaveWethUsdcPosition(client: any) {
  await client.request({
    method: "anvil_setBalance",
    params: [TEST_USER, "0x8AC7230489E80000"], // 10 ETH
  });
  await client.sendTransaction({
    to: WETH,
    data: encodeFunctionData({
      abi: parseAbi(["function deposit() payable"]),
      functionName: "deposit",
    }),
    value: 5_000_000_000_000_000_000n,
  });
  await client.sendTransaction({
    to: WETH,
    data: encodeFunctionData({
      abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
      functionName: "approve",
      args: [POOL, maxUint256],
    }),
  });
  await client.sendTransaction({
    to: POOL,
    data: encodeFunctionData({
      abi: parseAbi(["function supply(address,uint256,address,uint16)"]),
      functionName: "supply",
      args: [WETH, 5_000_000_000_000_000_000n, TEST_USER, 0],
    }),
  });
  await client.sendTransaction({
    to: POOL,
    data: encodeFunctionData({
      abi: parseAbi(["function borrow(address,uint256,uint256,uint16,address)"]),
      functionName: "borrow",
      args: [USDC, 1_000_000_000n, 2n, 0, TEST_USER], // 1000 USDC variable
    }),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function crashAaveWethOracle(client: any) {
  await client.request({
    method: "anvil_setCode",
    params: [AAVE_ORACLE, AAVE_ORACLE_BYTECODE],
  });
  const defaultPrice: Hex = `0x${300000000000n.toString(16).padStart(64, "0")}`;
  await client.request({
    method: "anvil_setStorageAt",
    params: [AAVE_ORACLE, `0x${"0".repeat(63)}1`, defaultPrice],
  });
  const crashPrice: Hex = `0x${100000000n.toString(16).padStart(64, "0")}`; // $1
  await client.request({
    method: "anvil_setStorageAt",
    params: [AAVE_ORACLE, `0x${"0".repeat(63)}2`, crashPrice],
  });
}

/** Mirror cometBot estimateDebt fallback (corrected totalsBasic index). */
async function estimateDebtFallback(
  client: Parameters<typeof readContract>[0],
  comet: `0x${string}`,
  account: `0x${string}`,
): Promise<bigint> {
  const [userBasic, totalsBasic] = await Promise.all([
    readContract(client, {
      address: comet,
      abi: cometViewAbi,
      functionName: "userBasic",
      args: [account],
    }),
    readContract(client, {
      address: comet,
      abi: cometViewAbi,
      functionName: "totalsBasic",
    }),
  ]);
  const principal = userBasic[0];
  const baseBorrowIndex = totalsBasic[1]; // fixed: was wrongly [3]
  if (principal >= 0n) return 0n;
  return (-principal * baseBorrowIndex) / 1_000_000_000_000_000n;
}

/** Old buggy index for regression check. */
async function estimateDebtBuggy(
  client: Parameters<typeof readContract>[0],
  comet: `0x${string}`,
  account: `0x${string}`,
): Promise<bigint> {
  const [userBasic, totalsBasic] = await Promise.all([
    readContract(client, {
      address: comet,
      abi: cometViewAbi,
      functionName: "userBasic",
      args: [account],
    }),
    readContract(client, {
      address: comet,
      abi: cometViewAbi,
      functionName: "totalsBasic",
    }),
  ]);
  const principal = userBasic[0];
  // Wrong: treating tuple[3] as baseBorrowIndex (actually trackingBorrowIndex)
  const wrongIndex = totalsBasic[3];
  if (principal >= 0n) return 0n;
  return (-principal * wrongIndex) / 1_000_000_000_000_000n;
}

describe("P0 fork validation", () => {
  aaveBaseForkTest.sequential(
    "P0-2: selectBestLiquidationPair non-null for HF<1 Aave position",
    async ({ client }) => {
      // On-chain AddressesProvider (correct at any fork block) + static fallback
      const staticDp = resolveAaveProtocolDataProvider(POOL, 8453);
      expect(staticDp).toBeDefined();

      await createAaveWethUsdcPosition(client);
      await crashAaveWethOracle(client);

      const accountData = await readContract(client, {
        address: POOL,
        abi: aavePoolViewAbi,
        functionName: "getUserAccountData",
        args: [TEST_USER],
      });
      const hf = accountData[5];
      const hfNum = Number(hf) / 1e18;
      console.log(`[P0-2] HF after crash = ${hfNum}`);
      expect(hf).toBeLessThan(HEALTH_FACTOR_THRESHOLD);

      const reserves = await readContract(client, {
        address: POOL,
        abi: aavePoolViewAbi,
        functionName: "getReservesList",
      });

      // Do NOT pass a hard-coded latest provider — let selectBest resolve via AddressesProvider
      const pair = await selectBestLiquidationPair(
        client,
        POOL,
        TEST_USER,
        hf,
        Array.from(reserves),
        undefined,
        undefined,
        undefined,
        "[P0-2]",
      );

      // Hard assertion: ProtocolDataProvider path must surface WETH/USDC pair
      expect(
        pair,
        "expected non-null pair after oracle crash (was skip_no_pair with Pool ABI)",
      ).not.toBeNull();
      expect(pair!.collateralAsset.toLowerCase()).toBe(WETH.toLowerCase());
      expect(pair!.debtAsset.toLowerCase()).toBe(USDC.toLowerCase());
      expect(pair!.debtToCover).toBeGreaterThan(0n);
      expect(pair!.seizableCollateral).toBeGreaterThan(0n);
      console.log(
        `[P0-2] pair collat=${pair!.collateralAsset.slice(0, 10)} debt=${pair!.debtAsset.slice(0, 10)} ` +
          `debtToCover=${pair!.debtToCover} seize=${pair!.seizableCollateral} bonus=${pair!.liquidationBonus}`,
      );
    },
  );

  aaveBaseForkTest.sequential(
    "P0-4: Comet estimateDebt ≈ borrowBalanceOf (rel err < 1%)",
    async ({ client }) => {
      // Create a real borrow on USDC Comet for LIQ_USER
      await client.request({
        method: "anvil_setBalance",
        params: [LIQ_USER, "0x8AC7230489E80000"],
      });
      // Impersonate not needed if client.account is anvil#0 — use TEST_USER as supplier,
      // LIQ_USER as borrower via send from default account after funding.
      // Fund LIQ_USER by switching: anvil tests use client.account as signer.
      // Supply WETH collateral + withdraw USDC as debt for the test account.
      const borrower = client.account.address;

      await client.request({
        method: "anvil_setBalance",
        params: [borrower, "0x8AC7230489E80000"],
      });
      await client.sendTransaction({
        to: WETH,
        data: encodeFunctionData({
          abi: parseAbi(["function deposit() payable"]),
          functionName: "deposit",
        }),
        value: 2_000_000_000_000_000_000n,
      });
      await client.sendTransaction({
        to: WETH,
        data: encodeFunctionData({
          abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
          functionName: "approve",
          args: [COMET_USDC, maxUint256],
        }),
      });
      // supply WETH collateral
      await client.sendTransaction({
        to: COMET_USDC,
        data: encodeFunctionData({
          abi: parseAbi(["function supply(address,uint256)"]),
          functionName: "supply",
          args: [WETH, 2_000_000_000_000_000_000n],
        }),
      });
      // withdraw USDC (= borrow)
      await client.sendTransaction({
        to: COMET_USDC,
        data: encodeFunctionData({
          abi: parseAbi(["function withdraw(address,uint256)"]),
          functionName: "withdraw",
          args: [USDC, 500_000_000n], // 500 USDC
        }),
      });

      const direct = await readContract(client, {
        address: COMET_USDC,
        abi: cometViewAbi,
        functionName: "borrowBalanceOf",
        args: [borrower],
      });
      expect(direct).toBeGreaterThan(0n);

      const fixed = await estimateDebtFallback(client, COMET_USDC, borrower);
      const buggy = await estimateDebtBuggy(client, COMET_USDC, borrower);

      const rel =
        direct > 0n ? Number(direct > fixed ? direct - fixed : fixed - direct) / Number(direct) : 0;
      console.log(
        `[P0-4] borrowBalanceOf=${direct} fixed=${fixed} buggy=${buggy} relErr=${(rel * 100).toFixed(4)}%`,
      );

      expect(rel).toBeLessThan(0.01); // < 1%
      // Buggy index should diverge when trackingBorrowIndex != baseBorrowIndex
      // (almost always true on live Comet); soft-check only if divergence visible
      if (buggy !== fixed) {
        const buggyRel = Number(direct > buggy ? direct - buggy : buggy - direct) / Number(direct);
        expect(buggyRel).toBeGreaterThan(rel);
        console.log(`[P0-4] buggy relErr=${(buggyRel * 100).toFixed(2)}% (worse than fixed)`);
      }
    },
  );

  aaveBaseForkTest.sequential(
    "P0-1: Aerodrome WETH→USDC convert encodes amountOut > 0",
    async ({ encoder }) => {
      const venue = new AerodromeVenue();
      const srcAmount = 10n ** 16n; // 0.01 WETH

      const supported = await venue.supportsRoute(encoder, WETH, USDC);
      expect(supported, "Aerodrome should have WETH/USDC pool on Base").toBe(true);

      encoder.flush(); // clear stack

      const result = await venue.convert(encoder, {
        src: WETH,
        dst: USDC,
        srcAmount,
      });

      // Success path: fully converted (src === dst === USDC) with amountOut > 0
      // Fail path: same tokens returned (hop continues) — also OK if pool quotes 0
      const calls = encoder.flush(); // Hex[] of Executor call_g0oyU7o wrappers

      if (
        result.src.toLowerCase() === USDC.toLowerCase() &&
        result.dst.toLowerCase() === USDC.toLowerCase()
      ) {
        expect(result.srcAmount, "amountOut must be > 0 on success").toBeGreaterThan(0n);
        expect(calls.length).toBeGreaterThanOrEqual(2); // transfer + swap

        let foundSwap = false;
        for (const wrapped of calls) {
          let inner: Hex;
          try {
            const outer = decodeFunctionData({ abi: executorAbi, data: wrapped });
            if (outer.functionName !== "call_g0oyU7o") continue;
            inner = outer.args[3];
          } catch {
            continue;
          }
          try {
            const decoded = decodeFunctionData({ abi: aerodromePoolAbi, data: inner });
            if (decoded.functionName !== "swap") continue;
            const [amount0Out, amount1Out] = decoded.args as [
              bigint,
              bigint,
              `0x${string}`,
              `0x${string}`,
            ];
            expect(amount0Out + amount1Out, "must not encode swap(0,0)").toBeGreaterThan(0n);
            expect(amount0Out === 0n || amount1Out === 0n).toBe(true);
            foundSwap = true;
            console.log(
              `[P0-1] Aerodrome success amountOut=${result.srcAmount} swap=(${amount0Out},${amount1Out}) calls=${calls.length}`,
            );
          } catch {
            // not a pool swap selector
          }
        }
        expect(foundSwap, "expected a pool.swap call in encoder stack").toBe(true);
      } else {
        // Fail-closed: unchanged toConvert — hop continues (not fake success)
        expect(result.src.toLowerCase()).toBe(WETH.toLowerCase());
        expect(result.dst.toLowerCase()).toBe(USDC.toLowerCase());
        expect(calls.length).toBe(0);
        console.log("[P0-1] Aerodrome fail-closed (amountOut=0) — hop may continue");
      }
    },
  );
});
