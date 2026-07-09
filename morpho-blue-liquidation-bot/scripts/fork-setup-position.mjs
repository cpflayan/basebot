import { createWalletClient, createPublicClient, http, parseAbi, encodeFunctionData, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const RPC = "http://127.0.0.1:8545";
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const MORPHO = getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
const WETH = getAddress("0x4200000000000000000000000000000000000006");
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const ORACLE = getAddress("0xfea2d58cefcb9fcb597723c6bae66ffe4193afe4");
const IRM = getAddress("0x46415998764C29aB2a25CbeA6254146D50D22687");
const LLTV = 860000000000000000n;
const MARKET_ID = "0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda";

const account = privateKeyToAccount(KEY);
const wallet = createWalletClient({ chain: base, transport: http(RPC), account });
const pub = createPublicClient({ chain: base, transport: http(RPC) });

const morphoAbi = parseAbi([
  "function supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)",
  "function borrow((address,address,address,address,uint256),uint256,uint256,address,address)",
  "function position(bytes32,address) view returns (uint256,uint128,uint128)",
]);
const erc20Abi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function deposit() payable",
]);
const oracleAbi = parseAbi(["function price() view returns (uint256)"]);

// Market: USDC loan, wETH collateral
const mp = [USDC, WETH, ORACLE, IRM, LLTV];

async function main() {
  console.log("=== Step 1: Wrap 2 ETH to wETH ===");
  const txHash1 = await wallet.sendTransaction({ to: WETH, value: 2000000000000000000n, data: encodeFunctionData({ abi: erc20Abi, functionName: "deposit" }) });
  await pub.waitForTransactionReceipt({ hash: txHash1 });
  const wethBal = await pub.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  console.log(`wETH balance: ${wethBal}`);

  console.log("\n=== Step 2: Approve wETH to Morpho ===");
  const txHash2 = await wallet.writeContract({
    address: WETH, abi: erc20Abi, functionName: "approve",
    args: [MORPHO, 2n ** 256n - 1n],
  });
  await pub.waitForTransactionReceipt({ hash: txHash2 });
  console.log("Approved");

  console.log("\n=== Step 3: Supply 1 wETH as collateral ===");
  const txHash3 = await wallet.writeContract({
    address: MORPHO, abi: morphoAbi, functionName: "supplyCollateral",
    args: [mp, 1000000000000000000n, account.address, "0x"],
  });
  await pub.waitForTransactionReceipt({ hash: txHash3 });
  console.log("Supplied 1 wETH as collateral");

  console.log("\n=== Step 4: Check position ===");
  const pos1 = await pub.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [MARKET_ID, account.address] });
  console.log(`Position: supplyShares=${pos1[0]}, borrowShares=${pos1[1]}, collateral=${pos1[2]}`);

  console.log("\n=== Step 5: Borrow 500 USDC ===");
  const txHash5 = await wallet.writeContract({
    address: MORPHO, abi: morphoAbi, functionName: "borrow",
    args: [mp, 500000000n, 0n, account.address, account.address],
  });
  await pub.waitForTransactionReceipt({ hash: txHash5 });
  console.log("Borrowed 500 USDC");

  console.log("\n=== Step 6: Position after borrow ===");
  const pos2 = await pub.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [MARKET_ID, account.address] });
  console.log(`Position: supplyShares=${pos2[0]}, borrowShares=${pos2[1]}, collateral=${pos2[2]}`);

  console.log("\n=== Step 7: Oracle price ===");
  const price = await pub.readContract({ address: ORACLE, abi: oracleAbi, functionName: "price" });
  console.log(`Oracle price: ${price}`);

  console.log("\n=== Step 8: Time travel 1 hour ===");
  await wallet.request({ method: "evm_increaseTime", params: ["0xe10"] });
  await wallet.request({ method: "evm_mine", params: [] });
  console.log("Time traveled 1 hour");

  console.log("\n✅ Position setup complete!");
  console.log(`User: ${account.address}`);
  console.log(`Market: ${MARKET_ID}`);
}

main().catch(console.error);
