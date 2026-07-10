/**
 * Fork script: Create a liquidatable Aave V3 position on Base fork.
 *
 * Steps:
 *   1. anvil_setBalance to fund test address with ETH
 *   2. Wrap ETH → WETH
 *   3. Supply WETH as collateral to Aave V3 Pool
 *   4. Borrow USDC against WETH collateral
 *   5. Verify health factor > 1
 *
 * Usage:
 *   anvil --fork-url $RPC_URL_8453 --fork-block-number 25000000 --port 8545 &
 *   node scripts/fork-setup-aave-position.mjs
 */
import { createWalletClient, createPublicClient, http, parseAbi, getAddress, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const RPC = "http://127.0.0.1:8545";
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Base Aave V3 Pool
const POOL = getAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");

// Base tokens
const WETH = getAddress("0x4200000000000000000000000000000000000006");
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

const TEST_ADDR = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");

const account = privateKeyToAccount(KEY);
const wallet = createWalletClient({ chain: base, transport: http(RPC), account });
const pub = createPublicClient({ chain: base, transport: http(RPC) });

const erc20Abi = parseAbi([
  "function deposit() payable",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

const poolAbi = parseAbi([
  "function supply(address,uint256,address,uint16)",
  "function borrow(address,uint256,uint256,uint16,address)",
  "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)",
]);

async function main() {
  console.log("=== Aave V3 Fork: Setup Liquidatable Position ===\n");
  console.log(`Pool: ${POOL}`);
  console.log(`User: ${TEST_ADDR}\n`);

  // Step 1: Fund test address with ETH
  console.log("Step 1: Fund test address with 10 ETH...");
  await wallet.request({
    method: "anvil_setBalance",
    params: [TEST_ADDR, "0x8AC7230489E80000"], // 10 ETH
  });
  const ethBal = await pub.getBalance({ address: TEST_ADDR });
  console.log(`ETH balance: ${ethBal}`);

  // Step 2: Wrap 5 ETH → WETH
  console.log("\nStep 2: Wrap 5 ETH → WETH...");
  const wrapTx = await wallet.sendTransaction({
    to: WETH,
    value: 5000000000000000000n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "deposit" }),
    account: TEST_ADDR,
  });
  await pub.waitForTransactionReceipt({ hash: wrapTx });
  const wethBal = await pub.readContract({
    address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [TEST_ADDR],
  });
  console.log(`WETH balance: ${wethBal}`);

  // Step 3: Approve WETH to Pool
  console.log("\nStep 3: Approve WETH to Pool...");
  const approveTx = await wallet.writeContract({
    address: WETH, abi: erc20Abi, functionName: "approve",
    args: [POOL, 2n ** 256n - 1n],
    account: TEST_ADDR,
  });
  await pub.waitForTransactionReceipt({ hash: approveTx });
  console.log("Approved");

  // Step 4: Supply 5 WETH as collateral
  console.log("\nStep 4: Supply 5 WETH as collateral...");
  const supplyTx = await wallet.writeContract({
    address: POOL, abi: poolAbi, functionName: "supply",
    args: [WETH, 5000000000000000000n, TEST_ADDR, 0],
    account: TEST_ADDR,
  });
  await pub.waitForTransactionReceipt({ hash: supplyTx });
  console.log("Supplied 5 WETH");

  // Step 5: Check account data before borrow
  console.log("\nStep 5: Account data after supply...");
  const dataBefore = await pub.readContract({
    address: POOL, abi: poolAbi, functionName: "getUserAccountData", args: [TEST_ADDR],
  });
  console.log(`Total Collateral Base: ${dataBefore[0]}`);
  console.log(`Total Debt Base: ${dataBefore[1]}`);
  console.log(`Health Factor: ${dataBefore[5]}`);

  // Step 6: Borrow USDC
  // With 5 WETH at ~$2500 = $12,500 collateral, borrow ~$5,000 USDC to keep HF > 1.5
  console.log("\nStep 6: Borrow 5000 USDC...");
  const borrowTx = await wallet.writeContract({
    address: POOL, abi: poolAbi, functionName: "borrow",
    args: [USDC, 5000000000n, 2n, 0, TEST_ADDR], // variable rate = 2
    account: TEST_ADDR,
  });
  await pub.waitForTransactionReceipt({ hash: borrowTx });
  console.log("Borrowed 5000 USDC");

  // Step 7: Verify account data
  console.log("\nStep 7: Account data after borrow...");
  const dataAfter = await pub.readContract({
    address: POOL, abi: poolAbi, functionName: "getUserAccountData", args: [TEST_ADDR],
  });
  console.log(`Total Collateral Base: ${dataAfter[0]}`);
  console.log(`Total Debt Base: ${dataAfter[1]}`);
  console.log(`Available Borrow Base: ${dataAfter[2]}`);
  console.log(`Current LTV: ${dataAfter[3]}`);
  console.log(`Health Factor: ${dataAfter[5]}`);

  const hf = Number(dataAfter[5]) / 1e18;
  if (hf >= 1.0) {
    console.log(`\n✅ Position setup complete! HF = ${hf.toFixed(4)} (healthy)`);
    console.log(`Run fork-manipulate-aave-oracle.mjs to crash HF below 1.0`);
  } else {
    console.log(`\n⚠️ HF already below 1.0: ${hf.toFixed(4)}`);
  }
}

main().catch(console.error);
