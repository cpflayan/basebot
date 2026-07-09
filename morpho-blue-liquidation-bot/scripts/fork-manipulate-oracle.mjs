import { createWalletClient, createPublicClient, http, parseAbi, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const RPC = "http://127.0.0.1:8545";
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ORACLE = getAddress("0xfea2d58cefcb9fcb597723c6bae66ffe4193afe4");
const MARKET_ID = "0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda";
const MORPHO = getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
const TEST_ADDR = getAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");

const account = privateKeyToAccount(KEY);
const wallet = createWalletClient({ chain: base, transport: http(RPC), account });
const pub = createPublicClient({ chain: base, transport: http(RPC) });

async function main() {
  // Runtime bytecode: SLOAD(slot0) -> MSTORE(0, val) -> RETURN(0, 32)
  // Opcodes: PUSH1 0, SLOAD, PUSH1 0, MSTORE, PUSH1 32, PUSH1 0, RETURN
  const runtime = "0x60005460005260206000f3";

  console.log("=== 6.4 替换 Oracle 合约 ===");
  await wallet.request({ method: "anvil_setCode", params: [ORACLE, runtime] });
  console.log("Oracle code replaced with minimal SLOAD contract");

  // Set price in storage slot 0 — make it 1000x lower to crash HF
  const newPrice = 1734059412971713800n; // ~1.734e18 (original was ~1.734e27)
  const priceHex = "0x" + newPrice.toString(16).padStart(64, "0");

  console.log("=== 6.5 设置新价格 ===");
  await wallet.request({
    method: "anvil_setStorageAt",
    params: [ORACLE, "0x" + "0".repeat(64), priceHex],
  });
  console.log(`Oracle price set to ${newPrice}`);

  // Verify
  const oracleAbi = parseAbi(["function price() view returns (uint256)"]);
  const price = await pub.readContract({ address: ORACLE, abi: oracleAbi, functionName: "price" });
  console.log(`Verified oracle price: ${price}`);

  // Check position
  const morphoAbi = parseAbi(["function position(bytes32,address) view returns (uint256,uint128,uint128)"]);
  const pos = await pub.readContract({
    address: MORPHO, abi: morphoAbi, functionName: "position",
    args: [MARKET_ID, TEST_ADDR],
  });
  console.log(`Position: supplyShares=${pos[0]}, borrowShares=${pos[1]}, collateral=${pos[2]}`);

  console.log("\n✅ Oracle manipulated! HF should now be << 1");
}

main().catch(console.error);
