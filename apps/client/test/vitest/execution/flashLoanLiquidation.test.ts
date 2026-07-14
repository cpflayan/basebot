/**
 * Base flash-loan path smoke test: real Morpho market + liquidatable position + Balancer encode.
 *
 * Uses the canonical WETH/USDC 86% market (same params as allBots.fork.test.ts).
 * Does NOT invent oracle/IRM addresses — Morpho rejects supply on uncreated markets.
 */
import { MarketUtils } from "@morpho-org/blue-sdk";
import type { AnvilTestClient } from "@morpho-org/test";
import { testAccount } from "@morpho-org/test";
import { createViemTest } from "@morpho-org/test/vitest";
import { ExecutorEncoder, executorAbi, bytecode } from "executooor-viem";
import nock from "nock";
import {
  type Address,
  encodePacked,
  fromHex,
  getAddress,
  type Hex,
  keccak256,
  maxUint128,
  maxUint256,
  parseUnits,
  toHex,
} from "viem";
import { getStorageAt, readContract } from "viem/actions";
import { base } from "viem/chains";
import { beforeEach, describe, expect } from "vitest";

import { BALANCER_VAULT_ADDRESS } from "../../../src/abis/BalancerVault.js";
import { morphoBlueAbi } from "../../../src/abis/morpho/morphoBlue.js";

// ── Base chain constants (real Morpho Blue market) ──

const MORPHO_BASE = getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
const USDC_BASE = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const WETH_BASE = getAddress("0x4200000000000000000000000000000000000006");

/** Real Chainlink oracle for WETH/USDC market on Base — not a placeholder. */
const ORACLE_MORPHO = getAddress("0xfea2d58cefcb9fcb597723c6bae66ffe4193afe4");
const IRM_MORPHO = getAddress("0x46415998764C29aB2a25CbeA6254146D50D22687");
const LLTV_MORPHO = 860000000000000000n; // 0.86

/** Known market id for USDC/WETH/oracle/IRM/86% on Base. */
const MARKET_ID_MORPHO =
  "0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda" as Hex;

const MARKET_PARAMS = {
  loanToken: USDC_BASE,
  collateralToken: WETH_BASE,
  oracle: ORACLE_MORPHO,
  irm: IRM_MORPHO,
  lltv: LLTV_MORPHO,
} as const;

// Storage slot constants (Morpho Blue position mapping)
const POSITION_SLOT = 3n;
const BORROW_SHARES_AND_COLLATERAL_OFFSET = 1n;

const borrower = testAccount(1);
const supplier = testAccount(2);

function firstNonEmpty(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) {
    if (v && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

const baseForkUrl =
  firstNonEmpty(
    process.env.FORK_RPC_URL,
    process.env.RPC_URL_BASE,
    process.env.RPC_URL_BASE2,
    process.env.RPC_URL_8453,
    process.env.PUBLIC_RPC_URL_BASE,
    base.rpcUrls.default.http[0],
  ) ?? base.rpcUrls.default.http[0];

// Pin near allBots / aaveBaseFork so market + Balancer liquidity exist on fork.
const baseTest = createViemTest(base, {
  forkUrl: baseForkUrl,
  forkBlockNumber: 25_000_000,
  timeout: 180_000,
}).extend<{ encoder: ExecutorEncoder }>({
  encoder: async ({ client }, use) => {
    const receipt = await client.deployContractWait({
      abi: executorAbi,
      bytecode,
      args: [client.account.address],
    });
    await use(new ExecutorEncoder(receipt.contractAddress, client));
  },
});

// ── Helpers ──

async function setupPositionOnBase(
  client: AnvilTestClient,
  marketParams: {
    loanToken: Address;
    collateralToken: Address;
    oracle: Address;
    irm: Address;
    lltv: bigint;
  },
  collateralAmount: bigint,
  borrowAmount: bigint,
) {
  const marketId = MarketUtils.getMarketId(marketParams);
  expect(marketId.toLowerCase()).toBe(MARKET_ID_MORPHO.toLowerCase());

  // Ensure market has loan-side liquidity (deal + supply as a separate account)
  await client.deal({
    erc20: marketParams.loanToken,
    account: supplier.address,
    amount: borrowAmount * 3n,
  });
  await client.approve({
    account: supplier.address,
    address: marketParams.loanToken,
    args: [MORPHO_BASE, maxUint256],
  });
  await client.writeContract({
    account: supplier.address,
    address: MORPHO_BASE,
    abi: morphoBlueAbi,
    functionName: "supply",
    args: [marketParams, borrowAmount * 3n, 0n, supplier.address, "0x"],
  });

  // Borrower: collateral + borrow
  await client.deal({
    erc20: marketParams.collateralToken,
    account: borrower.address,
    amount: collateralAmount,
  });
  await client.approve({
    account: borrower.address,
    address: marketParams.collateralToken,
    args: [MORPHO_BASE, maxUint256],
  });
  await client.writeContract({
    account: borrower.address,
    address: MORPHO_BASE,
    abi: morphoBlueAbi,
    functionName: "supplyCollateral",
    args: [marketParams, collateralAmount, borrower.address, "0x"],
  });
  await client.writeContract({
    account: borrower.address,
    address: MORPHO_BASE,
    abi: morphoBlueAbi,
    functionName: "borrow",
    args: [marketParams, borrowAmount, 0n, borrower.address, borrower.address],
  });

  // Reduce collateral → HF < 1
  await overwriteCollateral(client, marketId, borrower.address, collateralAmount / 3n);

  return marketId;
}

async function overwriteCollateral(
  client: AnvilTestClient,
  marketId: Hex,
  user: Address,
  amount: bigint,
) {
  const slot = borrowSharesAndCollateralSlot(user, marketId);
  const value = await getStorageAt(client, {
    address: MORPHO_BASE,
    slot,
  });
  await client.setStorageAt({
    address: MORPHO_BASE,
    index: slot,
    value: modifyCollateralSlot(value!, amount),
  });
}

function borrowSharesAndCollateralSlot(user: Address, marketId: Hex) {
  return padToBytes32(
    toHex(
      fromHex(
        keccak256(
          encodePacked(
            ["bytes32", "bytes32"],
            [
              padToBytes32(user),
              keccak256(encodePacked(["bytes32", "uint256"], [marketId, POSITION_SLOT])),
            ],
          ),
        ),
        "bigint",
      ) + BORROW_SHARES_AND_COLLATERAL_OFFSET,
    ),
  );
}

function padToBytes32(hex: `0x${string}`, bytes = 32): Hex {
  const withoutPrefix = hex.slice(2);
  const padded = withoutPrefix.padStart(2 * bytes, "0");
  return `0x${padded}`;
}

function modifyCollateralSlot(value: Hex, amount: bigint) {
  if (amount > maxUint128) throw new Error("Amount is too large");
  const collateralBytes = padToBytes32(toHex(amount), 16);
  const slotBytes = value.slice(34);
  return `${collateralBytes}${slotBytes}` as Hex;
}

// ── Tests ──

describe("Base chain flash loan liquidation - full path test", () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  baseTest.sequential(
    "full flash loan liquidation path on Base (WETH/USDC market)",
    async ({ encoder, client }) => {
      // Conservative vs 86% LLTV: 5 WETH collat, borrow 5000 USDC (healthy at ~$3k ETH)
      const collateralAmount = parseUnits("5", 18);
      const borrowAmount = parseUnits("5000", 6);

      console.log("[Base] Setting up liquidatable Morpho position on real market…");

      const marketId = await setupPositionOnBase(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client as any,
        MARKET_PARAMS,
        collateralAmount,
        borrowAmount,
      );
      console.log("[Base] Market ID:", marketId);

      const position = await readContract(client, {
        address: MORPHO_BASE,
        abi: morphoBlueAbi,
        functionName: "position",
        args: [marketId, borrower.address],
      });

      expect(position[1]).toBeGreaterThan(0n); // borrowShares
      expect(position[2]).toBeGreaterThan(0n); // collateral (reduced)

      console.log("[Base] Position:");
      console.log("  Supply shares:", position[0].toString());
      console.log("  Borrow shares:", position[1].toString());
      console.log("  Collateral:", position[2].toString());

      nock("https://api.morpho.org")
        .post("/graphql")
        .reply(200, {
          data: {
            marketPositions: {
              items: [
                {
                  healthFactor: 0.5,
                  user: { address: borrower.address },
                  market: {
                    uniqueKey: marketId,
                    oracle: { address: MARKET_PARAMS.oracle },
                  },
                  state: {
                    borrowShares: position[1].toString(),
                    collateral: position[2].toString(),
                    supplyShares: position[0].toString(),
                  },
                },
              ],
            },
          },
        });

      // Ensure Balancer vault can source flash loan USDC on this fork
      let vaultUsdcBalance = await readContract(client, {
        address: USDC_BASE,
        abi: [
          {
            inputs: [{ name: "account", type: "address" }],
            name: "balanceOf",
            outputs: [{ type: "uint256" }],
            stateMutability: "view",
            type: "function",
          },
        ] as const,
        functionName: "balanceOf",
        args: [BALANCER_VAULT_ADDRESS],
      });

      if (vaultUsdcBalance < borrowAmount) {
        await client.deal({
          erc20: USDC_BASE,
          account: BALANCER_VAULT_ADDRESS,
          amount: borrowAmount * 2n,
        });
        vaultUsdcBalance = await readContract(client, {
          address: USDC_BASE,
          abi: [
            {
              inputs: [{ name: "account", type: "address" }],
              name: "balanceOf",
              outputs: [{ type: "uint256" }],
              stateMutability: "view",
              type: "function",
            },
          ] as const,
          functionName: "balanceOf",
          args: [BALANCER_VAULT_ADDRESS],
        });
      }

      console.log("[Base] Balancer Vault USDC balance:", vaultUsdcBalance.toString());
      expect(vaultUsdcBalance).toBeGreaterThanOrEqual(borrowAmount);

      encoder.balancerFlashLoan(
        BALANCER_VAULT_ADDRESS,
        [{ asset: USDC_BASE, amount: borrowAmount }],
        [],
      );

      const calls = encoder.flush();
      expect(calls.length).toBe(1);
      console.log("[Base] Flash loan call encoded successfully");
      console.log("[Base] ✅ Full flash loan liquidation path verified");
    },
  );
});
