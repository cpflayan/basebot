/**
 * diagnoseFailures.ts
 *
 * 針對第一次真實測試跑出來的 2 個「疑似真的資料落差」問題，抓補充數據：
 *
 *   問題 3：Aave 有 8 個 reserve，在 fork 釘的 block 25,000,000 查不到，
 *           懷疑是「fork 太舊，這些 reserve 是後來才被 Aave 加進去的」。
 *           → 查「現在（最新區塊）」這 8 個 reserve 是否真的在 getReservesList() 裡。
 *             如果現在都在，代表 config 是對的，只是 fork 太舊；
 *             如果現在還是有缺，代表 config 裡這幾個地址真的有問題。
 *
 *   問題 4：Moonwell mUSDC 那筆清算（tx=0xc41cab42...），block 48454415
 *           （事件發生前一個區塊）查到 shortfall=0（健康），但同一個帳戶在
 *           下一個區塊 48454416 就被清算了。懷疑是「價格在事件當下那個區塊
 *           才更新」。
 *           → 查 block 48454415 vs 48454416 兩個區塊，這個帳戶的
 *             getAccountLiquidity() 結果，以及 comptroller 用的價格 oracle
 *             在這兩個區塊有沒有變化。
 *
 * ── 使用方式 ──────────────────────────────────────────────
 *   RPC_URL_8453=你的 Base RPC npx tsx diagnoseFailures.ts
 *
 * 執行完會印出 JSON 並寫到 ./diagnose-results.json，把結果貼回來給我。
 * ─────────────────────────────────────────────────────────
 */

import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { base } from "viem/chains";
import { writeFileSync } from "fs";
import "dotenv/config";

const RPC_URL = process.env.RPC_URL_8453;
if (!RPC_URL) {
  console.error("❌ 請先設定 RPC_URL_8453 環境變數");
  process.exit(1);
}

const client = createPublicClient({ chain: base, transport: http(RPC_URL) });

// 這是一次性診斷腳本，不追求嚴格型別，用 any 包一層避開 viem 多版本共存時
// readContract 泛型有時會對不上的問題。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = (params: any): Promise<any> => client.readContract(params);

// ── 問題 3：Aave reserve 現況 ────────────────────────────────────────────
const AAVE_POOL = getAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
const aavePoolAbi = parseAbi([
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
]);

const MISSING_RESERVES_AT_25M = [
  "0x2416092f143378750bb29b79eD961ab195CcEea5",
  "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee",
  "0xEDfa23602D0EC14714057867A78d01e94176BEA0",
  "0xecAc9C5F704e954931349Da37F60E39f515c11c1",
  "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
  "0x63706e401c06ac8513145b7687A14804d17f814b",
  "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b",
  "0x660975730059246A68521a3e2FBD4740173100f5",
];

async function diagnoseAaveReserves() {
  console.log("── 問題 3：Aave reserve 現況檢查 ──────────────────────────");
  const latestBlock = await client.getBlockNumber();
  console.log(`目前區塊高度: ${latestBlock}`);

  const currentReserves = await read({
    address: AAVE_POOL,
    abi: aavePoolAbi,
    functionName: "getReservesList",
  });
  const currentSet = new Set(currentReserves.map((a) => a.toLowerCase()));

  const results = [];
  for (const reserve of MISSING_RESERVES_AT_25M) {
    const presentNow = currentSet.has(reserve.toLowerCase());
    let lastUpdateTimestamp: string | null = null;
    let aTokenAddress: string | null = null;

    if (presentNow) {
      try {
        const data = await read({
          address: AAVE_POOL,
          abi: aavePoolAbi,
          functionName: "getReserveData",
          args: [getAddress(reserve)],
        });
        lastUpdateTimestamp = data.lastUpdateTimestamp.toString();
        aTokenAddress = data.aTokenAddress;
      } catch (err) {
        console.warn(`  ⚠️ getReserveData(${reserve}) 失敗: ${(err as Error).message}`);
      }
    }

    results.push({
      reserve,
      presentInGetReservesListNow: presentNow,
      lastUpdateTimestamp,
      aTokenAddress,
    });
    console.log(
      `  ${reserve}: 現在${presentNow ? "✅ 有在" : "❌ 還是不在"} getReservesList()` +
        (lastUpdateTimestamp ? ` (lastUpdateTimestamp=${lastUpdateTimestamp})` : ""),
    );
  }

  return { latestBlock: latestBlock.toString(), results };
}

// ── 問題 4：Moonwell mUSDC 異常事件補充數據 ───────────────────────────────
const MOONWELL_COMPTROLLER = getAddress("0xfBb21d0380beE3312B33c4353c8936a0F13EF26C");
const MUSDC = getAddress("0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22");
const BORROWER = getAddress("0xb4DF220A3F96802E382FC97e293E7fe7C5cedE26");
const EVENT_BLOCK = 48_454_416n; // 清算實際發生的區塊
const PRE_EVENT_BLOCK = 48_454_415n; // 清算前一個區塊（第一次測試查的就是這個）

const comptrollerAbi = parseAbi([
  "function getAccountLiquidity(address account) view returns (uint256 errorCode, uint256 liquidity, uint256 shortfall)",
  "function oracle() view returns (address)",
]);
const mTokenAbi = parseAbi([
  "function exchangeRateStored() view returns (uint256)",
  "function accrualBlockTimestamp() view returns (uint256)",
  "function borrowBalanceStored(address account) view returns (uint256)",
]);
const priceOracleAbi = parseAbi(["function getUnderlyingPrice(address mToken) view returns (uint256)"]);

async function diagnoseMoonwellAnomaly() {
  console.log("\n── 問題 4：Moonwell mUSDC 異常事件補充數據 ───────────────");

  const [liqPre, liqAt, exRatePre, exRateAt, accrualPre, accrualAt, borrowPre, borrowAt] = await Promise.all([
    read({
      address: MOONWELL_COMPTROLLER,
      abi: comptrollerAbi,
      functionName: "getAccountLiquidity",
      args: [BORROWER],
      blockNumber: PRE_EVENT_BLOCK,
    }),
    read({
      address: MOONWELL_COMPTROLLER,
      abi: comptrollerAbi,
      functionName: "getAccountLiquidity",
      args: [BORROWER],
      blockNumber: EVENT_BLOCK,
    }),
    read({
      address: MUSDC,
      abi: mTokenAbi,
      functionName: "exchangeRateStored",
      blockNumber: PRE_EVENT_BLOCK,
    }),
    read({
      address: MUSDC,
      abi: mTokenAbi,
      functionName: "exchangeRateStored",
      blockNumber: EVENT_BLOCK,
    }),
    read({
      address: MUSDC,
      abi: mTokenAbi,
      functionName: "accrualBlockTimestamp",
      blockNumber: PRE_EVENT_BLOCK,
    }),
    read({
      address: MUSDC,
      abi: mTokenAbi,
      functionName: "accrualBlockTimestamp",
      blockNumber: EVENT_BLOCK,
    }),
    read({
      address: MUSDC,
      abi: mTokenAbi,
      functionName: "borrowBalanceStored",
      args: [BORROWER],
      blockNumber: PRE_EVENT_BLOCK,
    }),
    read({
      address: MUSDC,
      abi: mTokenAbi,
      functionName: "borrowBalanceStored",
      args: [BORROWER],
      blockNumber: EVENT_BLOCK,
    }),
  ]);

  let oraclePricePre: string | null = null;
  let oraclePriceAt: string | null = null;
  try {
    const oracleAddr = await read({
      address: MOONWELL_COMPTROLLER,
      abi: comptrollerAbi,
      functionName: "oracle",
      blockNumber: PRE_EVENT_BLOCK,
    });
    [oraclePricePre, oraclePriceAt] = await Promise.all([
      read({
        address: oracleAddr,
        abi: priceOracleAbi,
        functionName: "getUnderlyingPrice",
        args: [MUSDC],
        blockNumber: PRE_EVENT_BLOCK,
      }).then((v) => v.toString()),
      read({
        address: oracleAddr,
        abi: priceOracleAbi,
        functionName: "getUnderlyingPrice",
        args: [MUSDC],
        blockNumber: EVENT_BLOCK,
      }).then((v) => v.toString()),
    ]);
  } catch (err) {
    console.warn(`  ⚠️ 查價格 oracle 失敗（可能是這個 comptroller 沒有 oracle() 這個 view function）: ${(err as Error).message}`);
  }

  const result = {
    borrower: BORROWER,
    mToken: MUSDC,
    preEventBlock: {
      block: PRE_EVENT_BLOCK.toString(),
      liquidity: liqPre[1].toString(),
      shortfall: liqPre[2].toString(),
      exchangeRateStored: exRatePre.toString(),
      accrualBlockTimestamp: accrualPre.toString(),
      borrowBalanceStored: borrowPre.toString(),
      oracleUnderlyingPrice: oraclePricePre,
    },
    eventBlock: {
      block: EVENT_BLOCK.toString(),
      liquidity: liqAt[1].toString(),
      shortfall: liqAt[2].toString(),
      exchangeRateStored: exRateAt.toString(),
      accrualBlockTimestamp: accrualAt.toString(),
      borrowBalanceStored: borrowAt.toString(),
      oracleUnderlyingPrice: oraclePriceAt,
    },
  };

  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const aave = await diagnoseAaveReserves();
  const moonwell = await diagnoseMoonwellAnomaly();

  const output = { aave, moonwell };
  writeFileSync("./diagnose-results.json", JSON.stringify(output, null, 2));
  console.log("\n📄 已寫入 ./diagnose-results.json —— 把這個檔案內容貼回來給我");
}

main().catch((err) => {
  console.error("腳本執行失敗:", err);
  process.exit(1);
});
