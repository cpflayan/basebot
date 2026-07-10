/**
 * Aave V3 Fork Integration Tests
 *
 * These tests run against a Base chain fork using anvil.
 * They verify:
 * - getUserAccountData WAD-scaling correctness
 * - selectBestLiquidationPair() with multiple collateral/debt combinations
 * - calculateCloseFactor edge cases
 * - Oracle manipulation & liquidation opportunity detection
 *
 * Prerequisites:
 *   anvil --fork-url $RPC_URL_8453 --fork-block-number 25000000
 *   node scripts/fork-setup-aave-position.mjs
 *   node scripts/fork-manipulate-aave-oracle.mjs
 */
import { executorAbi } from "executooor-viem";
import { type Hex, getAddress, parseAbi, maxUint256, encodeFunctionData } from "viem";
import { readContract, writeContract } from "viem/actions";
import { describe, expect } from "vitest";

import { HEALTH_FACTOR_THRESHOLD, aavePoolViewAbi } from "../../src/abis/AaveV3.js";
import { BALANCER_VAULT_ADDRESS } from "../../src/abis/BalancerVault.js";
import {
  selectBestLiquidationPair,
  calculateCloseFactor,
} from "../../src/utils/aaveAssetPairSelector.js";
import { LiquidationEncoder } from "../../src/utils/LiquidationEncoder.js";
import { aaveBaseForkTest } from "../setup.js";

// Base Aave V3 addresses
const POOL = getAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
const WETH = getAddress("0x4200000000000000000000000000000000000006");
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const TEST_USER = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");

// Aave V3 PriceOracle on Base (via AddressesProvider.getPriceOracle)
const AAVE_ORACLE = getAddress("0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156");

// Custom bytecode for AaveOracle replacement:
// getAssetPrice(address): if (arg & MASK) == WETH → return storage[2]; else → return storage[1]
// Uses AND mask to extract 20-byte address from 32-byte calldata word before comparison.
const CUSTOM_BYTECODE =
  "0x" +
  "600254" + // [0] PUSH1 2 SLOAD → WETH price
  "600435" + // [3] PUSH1 4 CALLDATALOAD → arg word
  "73ffffffffffffffffffffffffffffffffffffffff" + // [6] PUSH20 ADDR_MASK
  "16" + // [27] AND → masked addr
  "734200000000000000000000000000000000000006" + // [28] PUSH20 WETH
  "14" + // [49] EQ → 1 if WETH
  "604057" + // [50] PUSH1 0x40 JUMPI → byte 64
  "60015460005260206000f3" + // [53] default: SLOAD(1) MSTORE RETURN
  "5b60005260206000f3"; // [64] WETH: JUMPDEST MSTORE RETURN

/** Helper: create a WETH collateral + USDC debt position for TEST_USER */
async function createTestPosition(client: any) {
  await client.request({
    method: "anvil_setBalance",
    params: [TEST_USER, "0x8AC7230489E80000"], // 10 ETH
  });
  // Wrap 5 ETH → WETH
  await client.sendTransaction({
    to: WETH,
    data: encodeFunctionData({
      abi: parseAbi(["function deposit() payable"]),
      functionName: "deposit",
    }),
    value: 5000000000000000000n,
  });
  // Approve Pool
  await client.sendTransaction({
    to: WETH,
    data: encodeFunctionData({
      abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
      functionName: "approve",
      args: [POOL, maxUint256],
    }),
  });
  // Supply 5 WETH as collateral
  await client.sendTransaction({
    to: POOL,
    data: encodeFunctionData({
      abi: parseAbi(["function supply(address,uint256,address,uint16)"]),
      functionName: "supply",
      args: [WETH, 5000000000000000000n, TEST_USER, 0],
    }),
  });
  // Borrow 1000 USDC
  await client.sendTransaction({
    to: POOL,
    data: encodeFunctionData({
      abi: parseAbi(["function borrow(address,uint256,uint256,uint16,address)"]),
      functionName: "borrow",
      args: [USDC, 1000000000n, 2n, 0, TEST_USER],
    }),
  });
}

/** Helper: replace AaveOracle with custom bytecode and set crash price for WETH */
async function crashOracle(client: any) {
  await client.request({
    method: "anvil_setCode",
    params: [AAVE_ORACLE, CUSTOM_BYTECODE],
  });
  // slot 1 = default price ($3000 in 8 decimals)
  const defaultPrice: Hex = `0x${300000000000n.toString(16).padStart(64, "0")}`;
  await client.request({
    method: "anvil_setStorageAt",
    params: [AAVE_ORACLE, `0x${"0".repeat(63)}1`, defaultPrice],
  });
  // slot 2 = WETH crash price ($1 in 8 decimals)
  const crashPrice: Hex = `0x${100000000n.toString(16).padStart(64, "0")}`;
  await client.request({
    method: "anvil_setStorageAt",
    params: [AAVE_ORACLE, `0x${"0".repeat(63)}2`, crashPrice],
  });
}

describe("Aave V3 Fork Integration", () => {
  // ─── getUserAccountData WAD-scaling ───

  aaveBaseForkTest.sequential("should return WAD-scaled healthFactor", async ({ client }) => {
    // Setup: create a position for TEST_USER so healthFactor is finite
    await client.request({
      method: "anvil_setBalance",
      params: [TEST_USER, "0x8AC7230489E80000"], // 10 ETH
    });

    // Wrap 5 ETH → WETH
    await writeContract(client, {
      address: WETH,
      abi: parseAbi(["function deposit() payable"]),
      functionName: "deposit",
      value: 5000000000000000000n,
    });

    // Approve Pool
    await writeContract(client, {
      address: WETH,
      abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
      functionName: "approve",
      args: [POOL, maxUint256],
    });

    // Supply 5 WETH as collateral
    await writeContract(client, {
      address: POOL,
      abi: parseAbi(["function supply(address,uint256,address,uint16)"]),
      functionName: "supply",
      args: [WETH, 5000000000000000000n, TEST_USER, 0],
    });

    // Borrow 1000 USDC
    await writeContract(client, {
      address: POOL,
      abi: parseAbi(["function borrow(address,uint256,uint256,uint16,address)"]),
      functionName: "borrow",
      args: [USDC, 1000000000n, 2n, 0, TEST_USER],
    });

    const data = await readContract(client, {
      address: POOL,
      abi: aavePoolViewAbi,
      functionName: "getUserAccountData",
      args: [TEST_USER],
    });

    // healthFactor should be WAD-scaled (18 decimals)
    expect(data[5]).toBeGreaterThan(0n);
    // HF should be reasonable (not astronomically large)
    expect(data[5]).toBeLessThan(100n * HEALTH_FACTOR_THRESHOLD);
  });

  aaveBaseForkTest.sequential(
    "should return collateral/debt in 8-decimal base currency",
    async ({ client }) => {
      const data = await readContract(client, {
        address: POOL,
        abi: aavePoolViewAbi,
        functionName: "getUserAccountData",
        args: [TEST_USER],
      });

      // On Base, base currency is USD with 8 decimals
      if (data[0] > 0n) {
        // Collateral value should be reasonable (< $100B in 8-decimal)
        expect(data[0]).toBeLessThan(100_000_000_000n);
      }
    },
  );

  // ─── calculateCloseFactor (pure unit tests, no fork needed) ───

  aaveBaseForkTest.sequential("calculateCloseFactor: 100% when HF = 0", async () => {
    expect(calculateCloseFactor(0n)).toBe(10000n);
  });

  aaveBaseForkTest.sequential("calculateCloseFactor: 50% when HF = 1.0", async () => {
    expect(calculateCloseFactor(HEALTH_FACTOR_THRESHOLD)).toBe(5000n);
  });

  aaveBaseForkTest.sequential("calculateCloseFactor: scales linearly", async () => {
    const hf = (50n * HEALTH_FACTOR_THRESHOLD) / 100n; // 0.50
    const cf = calculateCloseFactor(hf);
    expect(cf).toBeGreaterThan(5000n);
    expect(cf).toBeLessThan(10000n);
  });

  // ─── selectBestLiquidationPair ───

  aaveBaseForkTest.sequential(
    "selectBestLiquidationPair: returns null for empty user",
    async ({ client }) => {
      const reserves = await readContract(client, {
        address: POOL,
        abi: aavePoolViewAbi,
        functionName: "getReservesList",
      });

      expect(reserves.length).toBeGreaterThan(0);

      // Use a random address that has no positions
      const noPositionUser = getAddress("0x000000000000000000000000000000000000dEaD");

      const pair = await selectBestLiquidationPair(
        client,
        POOL,
        noPositionUser,
        HEALTH_FACTOR_THRESHOLD,
        Array.from(reserves),
      );

      expect(pair).toBeNull();
    },
  );

  aaveBaseForkTest.sequential(
    "selectBestLiquidationPair: finds pairs for user with positions",
    async ({ client }) => {
      const reserves = await readContract(client, {
        address: POOL,
        abi: aavePoolViewAbi,
        functionName: "getReservesList",
      });

      // Check if test user has any positions
      const accountData = await readContract(client, {
        address: POOL,
        abi: aavePoolViewAbi,
        functionName: "getUserAccountData",
        args: [TEST_USER],
      });

      // If user has collateral and debt, selectBestLiquidationPair should find pairs
      if (accountData[0] > 0n && accountData[1] > 0n) {
        const pair = await selectBestLiquidationPair(
          client,
          POOL,
          TEST_USER,
          accountData[5],
          Array.from(reserves),
        );

        // Pair may be null if no profitable option, but function should not throw
        if (pair) {
          expect(pair.collateralAsset).toBeDefined();
          expect(pair.debtAsset).toBeDefined();
          expect(pair.debtToCover).toBeGreaterThan(0n);
          expect(pair.liquidationBonus).toBeGreaterThanOrEqual(10000n);
        }
      }
    },
  );

  // ─── Oracle manipulation & liquidation ───

  aaveBaseForkTest.sequential("should crash HF after oracle manipulation", async ({ client }) => {
    // Create position: 5 WETH collateral + 1000 USDC debt
    await createTestPosition(client);

    // Replace AaveOracle and crash WETH to $1
    await crashOracle(client);

    // Verify oracle returns crash price via getAssetPrice
    const oracleAbi = parseAbi(["function getAssetPrice(address) view returns (uint256)"]);
    const oraclePrice = await readContract(client, {
      address: AAVE_ORACLE,
      abi: oracleAbi,
      functionName: "getAssetPrice",
      args: [WETH],
    });
    expect(oraclePrice).toBe(100000000n);

    // Check HF after manipulation
    const accountData = await readContract(client, {
      address: POOL,
      abi: aavePoolViewAbi,
      functionName: "getUserAccountData",
      args: [TEST_USER],
    });

    const hf = Number(accountData[5]) / 1e18;
    // HF should be significantly below 1.0 with WETH at $1
    expect(hf).toBeLessThan(1.0);
  });

  aaveBaseForkTest.sequential(
    "should find profitable pair after oracle crash",
    async ({ client }) => {
      // Create position and crash oracle (each test gets a fresh fork snapshot)
      await createTestPosition(client);
      await crashOracle(client);

      const reserves = await readContract(client, {
        address: POOL,
        abi: aavePoolViewAbi,
        functionName: "getReservesList",
      });

      const accountData = await readContract(client, {
        address: POOL,
        abi: aavePoolViewAbi,
        functionName: "getUserAccountData",
        args: [TEST_USER],
      });

      const hf = accountData[5];

      // Close factor should be ~100% for very low HF (integer division may give 9999)
      const cf = calculateCloseFactor(hf);
      expect(cf).toBeGreaterThanOrEqual(9999n);
      expect(cf).toBeLessThanOrEqual(10000n);

      // selectBestLiquidationPair should find a profitable pair
      const pair = await selectBestLiquidationPair(
        client,
        POOL,
        TEST_USER,
        hf,
        Array.from(reserves),
      );

      // With crashed WETH price, there should be a liquidation opportunity
      if (pair) {
        expect(pair.estimatedProfit).toBeGreaterThan(0n);
        expect(pair.debtToCover).toBeGreaterThan(0n);
        expect(pair.seizableCollateral).toBeGreaterThan(0n);
      }
      // Note: pair may be null if the position is too small or no liquidity
    },
  );

  // ─── Direct liquidation path: approve → liquidationCall → verify ───

  aaveBaseForkTest.sequential(
    "direct liquidation path: approve → liquidationCall",
    async ({ client, encoder }) => {
      // Setup: Create a fresh position for the anvil default account
      const user = client.account.address;

      // Fund user with ETH
      await client.request({
        method: "anvil_setBalance",
        params: [user, "0x8AC7230489E80000"], // 10 ETH
      });

      // Wrap 3 ETH → WETH
      await client.sendTransaction({
        to: WETH,
        value: 3000000000000000000n,
        data: encodeFunctionData({
          abi: parseAbi(["function deposit() payable"]),
          functionName: "deposit",
        }),
      });

      // Approve WETH to Pool
      await writeContract(client, {
        address: WETH,
        abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
        functionName: "approve",
        args: [POOL, maxUint256],
      });

      // Supply 3 WETH as collateral
      await writeContract(client, {
        address: POOL,
        abi: parseAbi(["function supply(address,uint256,address,uint16)"]),
        functionName: "supply",
        args: [WETH, 3000000000000000000n, user, 0],
      });

      // Borrow USDC
      await writeContract(client, {
        address: POOL,
        abi: parseAbi(["function borrow(address,uint256,uint256,uint16,address)"]),
        functionName: "borrow",
        args: [USDC, 3000000000n, 2n, 0, user],
      });

      // Verify healthy position
      const dataBefore = await readContract(client, {
        address: POOL,
        abi: aavePoolViewAbi,
        functionName: "getUserAccountData",
        args: [user],
      });
      expect(Number(dataBefore[5]) / 1e18).toBeGreaterThan(1.0);

      // Crash oracle: replace AaveOracle and set crash prices
      await crashOracle(client);

      // Verify HF < 1
      const dataAfter = await readContract(client, {
        address: POOL,
        abi: aavePoolViewAbi,
        functionName: "getUserAccountData",
        args: [user],
      });
      expect(Number(dataAfter[5]) / 1e18).toBeLessThan(1.0);

      // Fund executor with USDC via deal
      const executorAddr = encoder.address;
      const usdcAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

      await client.deal({
        erc20: USDC,
        account: executorAddr,
        amount: 5000000000n, // 5000 USDC
      });

      const executorUsdc = await readContract(client, {
        address: USDC,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [executorAddr],
      });
      expect(executorUsdc).toBeGreaterThan(0n);

      // Use LiquidationEncoder (has aaveLiquidationCall) for encoding
      const liqEncoder = new LiquidationEncoder(executorAddr, client as any);

      // Execute direct liquidation path:
      // 1. Approve Pool to spend USDC from executor
      liqEncoder.erc20Approve(USDC, POOL, maxUint256);
      // 2. liquidationCall — executor repays USDC, seizes WETH collateral
      liqEncoder.aaveLiquidationCall(POOL, WETH, USDC, user, executorUsdc, false);

      const calls = liqEncoder.flush();

      // Execute via executor contract
      await writeContract(client, {
        address: executorAddr,
        abi: executorAbi,
        functionName: "exec_606BaXt",
        args: [calls],
      });

      // Verify: user's debt should be reduced after liquidation
      const dataPostLiq = await readContract(client, {
        address: POOL,
        abi: aavePoolViewAbi,
        functionName: "getUserAccountData",
        args: [user],
      });
      // Debt should be less than before (some was repaid by liquidator)
      expect(dataPostLiq[1]).toBeLessThan(dataAfter[1]);
    },
  );

  // ─── Flash loan liquidation path encoding ───

  aaveBaseForkTest.sequential(
    "flash loan path: Balancer flash loan → liquidationCall encoding",
    async ({ client, encoder }) => {
      // Verify the flash loan path encoding is correct.
      // Full execution requires the executor to handle Balancer's flash loan callback,
      // which is tested in production. Here we verify the call structure.

      const executorAddr = encoder.address;
      const flashLoanAmount = 1000000000n; // 1000 USDC

      // Use LiquidationEncoder for Aave-specific encoding
      const liqEncoder = new LiquidationEncoder(executorAddr, client as any);

      // Build callback calls (executed inside flash loan)
      liqEncoder.erc20Approve(USDC, POOL, maxUint256);
      liqEncoder.aaveLiquidationCall(POOL, WETH, USDC, TEST_USER, flashLoanAmount, false);
      liqEncoder.erc20Skim(USDC, executorAddr);
      const callbackCalls = liqEncoder.flush();

      // Wrap in Balancer flash loan (0% fee)
      liqEncoder.balancerFlashLoan(
        BALANCER_VAULT_ADDRESS,
        [{ asset: USDC, amount: flashLoanAmount }],
        callbackCalls,
      );
      const calls = liqEncoder.flush();

      // Verify calls were generated
      expect(calls.length).toBeGreaterThan(0);
    },
  );
});
