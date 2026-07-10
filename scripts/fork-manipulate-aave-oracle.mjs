/**
 * Fork script: Manipulate Aave V3 oracle to create liquidatable conditions.
 *
 * Replaces the AaveOracle contract on Base with custom bytecode that returns
 * configurable prices from storage slots.
 *
 * Custom bytecode (73 bytes) implements getAssetPrice(address):
 *   - If (arg & ADDR_MASK) == WETH → return storage[2] (WETH price)
 *   - Else → return storage[1] (default price)
 *
 * Uses AND mask to extract 20-byte address from 32-byte calldata word.
 *
 * Usage:
 *   # After running fork-setup-aave-position.mjs:
 *   node scripts/fork-manipulate-aave-oracle.mjs
 */
import { createWalletClient, createPublicClient, http, parseAbi, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const RPC = "http://127.0.0.1:8545";
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// AaveOracle on Base (via AddressesProvider.getPriceOracle)
const AAVE_ORACLE = getAddress("0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156");

// Aave V3 Pool (for verification)
const POOL = getAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
const WETH = getAddress("0x4200000000000000000000000000000000000006");
const TEST_ADDR = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");

const account = privateKeyToAccount(KEY);
const wallet = createWalletClient({ chain: base, transport: http(RPC), account });
const pub = createPublicClient({ chain: base, transport: http(RPC) });

// Custom bytecode: getAssetPrice(address) → uint256
// if (calldata_arg & MASK) == WETH → return storage[2]; else → return storage[1]
const CUSTOM_BYTECODE =
  "0x" +
  "600254" +                                                     // [0] PUSH1 2 SLOAD → WETH price
  "600435" +                                                     // [3] PUSH1 4 CALLDATALOAD → arg word
  "73ffffffffffffffffffffffffffffffffffffffff" +                 // [6] PUSH20 ADDR_MASK
  "16" +                                                         // [27] AND → masked addr
  "734200000000000000000000000000000000000006" +                 // [28] PUSH20 WETH
  "14" +                                                         // [49] EQ → 1 if WETH
  "604057" +                                                     // [50] PUSH1 0x40 JUMPI → byte 64
  "60015460005260206000f3" +                                     // [53] default: SLOAD(1) MSTORE RETURN
  "5b60005260206000f3";                                          // [64] WETH: JUMPDEST MSTORE RETURN

const oracleAbi = parseAbi([
  "function getAssetPrice(address) view returns (uint256)",
]);

const poolAbi = parseAbi([
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
]);

async function main() {
  console.log("=== Aave V3 Fork: Manipulate Oracle ===\n");
  console.log(`AaveOracle: ${AAVE_ORACLE}`);

  // Step 1: Read current price
  console.log("\nStep 1: Read current WETH price...");
  try {
    const currentPrice = await pub.readContract({
      address: AAVE_ORACLE,
      abi: oracleAbi,
      functionName: "getAssetPrice",
      args: [WETH],
    });
    console.log(`Current WETH price: ${currentPrice}`);
  } catch (e) {
    console.log(`Could not read current price: ${e.message}`);
  }

  // Step 2: Replace AaveOracle with custom bytecode
  console.log("\nStep 2: Replace AaveOracle code...");
  await wallet.request({
    method: "anvil_setCode",
    params: [AAVE_ORACLE, CUSTOM_BYTECODE],
  });
  console.log("AaveOracle replaced with custom SLOAD contract");

  // Step 3: Set prices
  // slot 1 = default price ($3000 in 8 decimals)
  const defaultPrice = 300000000000n;
  const defaultHex = "0x" + defaultPrice.toString(16).padStart(64, "0");
  await wallet.request({
    method: "anvil_setStorageAt",
    params: [AAVE_ORACLE, "0x" + "0".repeat(63) + "1", defaultHex],
  });

  // slot 2 = WETH crash price ($1 in 8 decimals) — makes HF << 1
  const crashPrice = 100000000n;
  const crashHex = "0x" + crashPrice.toString(16).padStart(64, "0");
  await wallet.request({
    method: "anvil_setStorageAt",
    params: [AAVE_ORACLE, "0x" + "0".repeat(63) + "2", crashHex],
  });
  console.log(`Default price set to ${defaultPrice} ($3000)`);
  console.log(`WETH price set to ${crashPrice} ($1)`);

  // Step 4: Verify oracle returns new prices
  console.log("\nStep 4: Verify oracle...");
  const wethPrice = await pub.readContract({
    address: AAVE_ORACLE,
    abi: oracleAbi,
    functionName: "getAssetPrice",
    args: [WETH],
  });
  console.log(`WETH price: ${wethPrice} (expected: ${crashPrice})`);

  // Step 5: Check health factor
  console.log("\nStep 5: Check user health factor...");
  const accountData = await pub.readContract({
    address: POOL,
    abi: poolAbi,
    functionName: "getUserAccountData",
    args: [TEST_ADDR],
  });
  const hf = Number(accountData[5]) / 1e18;
  console.log(`Total Collateral Base: ${accountData[0]}`);
  console.log(`Total Debt Base: ${accountData[1]}`);
  console.log(`Health Factor: ${hf.toFixed(4)}`);

  if (hf < 1.0) {
    console.log(`\n✅ Oracle manipulated! HF = ${hf.toFixed(4)} < 1.0 — account is liquidatable`);
  } else {
    console.log(`\n⚠️ HF still >= 1.0. The user may not have a position.`);
    console.log("Run fork-setup-aave-position.mjs first to create a position.");
  }
}

main().catch(console.error);
