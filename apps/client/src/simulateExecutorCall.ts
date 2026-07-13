/**
 * 只讀模擬腳本：用真實 Base RPC，對你「之前部署過」的真實 Executor 合約
 * (0xca2Bb167A5bf92Dc0891088285dA48D9e66C0661) 做 eth_call 級別的模擬呼叫。
 *
 * 涵蓋四條鏈路：Aave / Comet / Moonwell / Morpho。
 *
 * 重點：
 *   - 這是 simulateContract（底層是 eth_call），不是 sendTransaction。
 *     不花 gas、不需要私鑰簽名、不會真的改動鏈上狀態。
 *   - `account` 只是拿來在模擬時假裝「這筆呼叫是 owner 發起的」，藉此通過
 *     合約內的 onlyOwner 檢查 —— eth_call 可以指定任意 from 位址而不需要
 *     擁有那個地址的私鑰，這是完全合法、免費的模擬方式。
 *   - 每個場景都釘在「真實清算 tx 所在區塊的前一個區塊」，也就是清算發生前
 *     那一刻的真實狀態 —— 因為我們已經知道正確答案（真實鏈上那筆交易確實
 *     成功了），現在是要驗證你的 encoder + Executor 組合能不能複現同樣的
 *     成功結果。查歷史區塊需要 RPC 有 archive 權限。
 *
 * Usage:
 *   pnpm tsx apps/client/src/simulateExecutorCall.ts [aave|comet|moonwell|morpho|all]
 *   # 可選場景別名: aave-full | comet-full | moonwell-full
 *   # RPC: FORK_RPC_URL / RPC_URL_BASE / RPC_URL_BASE2 / RPC_URL_8453 / PUBLIC_RPC_URL_BASE
 *   不帶參數預設跑 all（會自動跳過還沒填真實資料的場景，並印出 cast logs 指令）
 */
import "dotenv/config";

import { UniswapV3Venue } from "@morpho-blue-liquidation-bot/liquidity-venues";
import { executorAbi } from "executooor-viem";
import { createPublicClient, getAddress, http, maxUint256, type Hex } from "viem";
import { readContract } from "viem/actions";
import { base } from "viem/chains";

import { BALANCER_VAULT_ADDRESS } from "./abis/BalancerVault.js";
import { cometViewAbi } from "./abis/Comet.js";
import { mTokenAbi } from "./abis/Moonwell.js";
import { LiquidationEncoder } from "./utils/LiquidationEncoder.js";

function firstNonEmpty(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) {
    if (v && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

// ─── 你之前部署、已經在 Basescan 上驗證過原始碼的真實 Executor ─────────────
const EXECUTOR_ADDRESS = getAddress("0xca2Bb167A5bf92Dc0891088285dA48D9e66C0661");

// ─── 部署這個 Executor 的 owner（從 Basescan 反編譯 bytecode 裡確認過的地址）───
const OWNER_ADDRESS = getAddress("0x949F284Ade3d40EEb2C48F993bA19a7F4561F1b7");

interface Scenario {
  name: string;
  ready: boolean; // false = 還是佔位符，還沒填真實資料
  findCommand: string; // 找真實資料要跑的 cast logs 指令
  build: (client: any) => Promise<{
    calls: Hex[];
    blockNumber: bigint;
    label: string;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Aave — 已用真實資料驗證過（block 38469381 的真實 LiquidationCall）
// ═══════════════════════════════════════════════════════════════════════════
const aaveScenario: Scenario = {
  name: "aave",
  ready: true,
  findCommand:
    'cast logs --address 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5 "LiquidationCall(address,address,address,uint256,uint256,address,bool)" --from-block <BLOCK-300000> --to-block latest --rpc-url $RPC_URL_8453',
  build: async (client) => {
    const POOL_AAVE = getAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
    const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    const WETH = getAddress("0x4200000000000000000000000000000000000006");
    const LIQ_USER = getAddress("0x7093bd08ce24cbda45ebbccd0fb3b15ef617448f");
    const debtToCover = 350436203n; // 350.436203 USDC，跟真實那筆清算完全一致

    const le = new LiquidationEncoder(EXECUTOR_ADDRESS, client);
    le.aaveLiquidationCall(POOL_AAVE, WETH, USDC, LIQ_USER, debtToCover, false);
    return {
      calls: le.flush(),
      blockNumber: 38469380n, // 真實清算 tx 所在區塊(38469381) - 1
      label: "Aave liquidationCall（block 38469381 真實事件 -1）",
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 2. Comet — 待填：用下面 findCommand 抓一筆真實 AbsorbDebt 事件
//    事件結構：AbsorbDebt(indexed absorber, indexed borrower, baseAbsorbed, collateralAbsorbed)
//    borrower 在 topics[2]（absorber 在 topics[1]，通常是別人的清算機器人地址，不用管）
// ═══════════════════════════════════════════════════════════════════════════
const cometScenario: Scenario = {
  name: "comet",
  ready: true,
  findCommand:
    'cast logs --address 0xb125E6687d4313864e53df431d5425969c15Eb2F "AbsorbDebt(address,address,uint256,uint256)" --from-block <BLOCK-300000> --to-block latest --rpc-url $RPC_URL_8453',
  build: async (client) => {
    const COMET = getAddress("0xb125E6687d4313864e53df431d5425969c15Eb2F"); // Comet USDC 市場
    const WETH = getAddress("0x4200000000000000000000000000000000000006");

    // 真實事件：block 48460673, tx 0x769463f35fefb7ffa4ab475e6def920418f56a0174aef9ae1a9a0975e4329877
    // absorber=0x8407699e359ae158bd7ec0668600cc19a79f17c3（別人的清算機器人，不用管）
    // baseAbsorbed=0.518891 USDC, collateralAbsorbed≈0.0519 WETH
    const LIQ_USER = getAddress("0x65f18ff427a516eb9ffcf3a140741d9e24484d28");
    const baseAmount = 1n * 10n ** 6n; // 1 USDC 上限，比真實 baseAbsorbed (0.52) 略寬鬆

    const le = new LiquidationEncoder(EXECUTOR_ADDRESS, client);
    le.cometAbsorb(COMET, [LIQ_USER]);
    le.cometBuyCollateral(COMET, WETH, 0n, baseAmount);
    return {
      calls: le.flush(),
      blockNumber: 48460672n, // 真實 AbsorbDebt tx 所在區塊(48460673) - 1
      label: "Comet absorb + buyCollateral（block 48460673 真實事件 -1）",
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 2b. Comet 完整鏈路 —— flashloan 借 USDC → absorb（免費）→ buyCollateral
//     （花 USDC 買折扣 WETH）→ UniswapV3 換回 USDC → 自動還款
//
//     用 quoteCollateral() 這個 view function 在同一個快照區塊精確算出
//     baseAmount 這筆 USDC 買下去實際會拿到多少 WETH，不用猜，這樣換匯的
//     srcAmount 才會準確對得上，不會因為金額猜錯導致「多換/少換」而混淆
//     判讀結果。
// ═══════════════════════════════════════════════════════════════════════════
const cometFullFlashLoanScenario: Scenario = {
  name: "comet-full",
  ready: true,
  findCommand: "（沿用 comet 場景同一筆真實事件，不需要另外找）",
  build: async (client) => {
    const COMET = getAddress("0xb125E6687d4313864e53df431d5425969c15Eb2F");
    const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    const WETH = getAddress("0x4200000000000000000000000000000000000006");
    const LIQ_USER = getAddress("0x65f18ff427a516eb9ffcf3a140741d9e24484d28");
    const baseAmount = 1n * 10n ** 6n; // 1 USDC，跟 comet 場景一致
    const SNAPSHOT_BLOCK = 48460672n;

    // 在同一個快照區塊問 Comet：花 baseAmount 這麼多 USDC，實際能買到多少 WETH
    const wethOut = await readContract(client, {
      address: COMET,
      abi: cometViewAbi,
      functionName: "quoteCollateral",
      args: [WETH, baseAmount],
      blockNumber: SNAPSHOT_BLOCK,
    });

    const inner = new LiquidationEncoder(EXECUTOR_ADDRESS, client);
    inner.cometAbsorb(COMET, [LIQ_USER]);
    inner.cometBuyCollateral(COMET, WETH, 0n, baseAmount);

    const uniswapV3 = new UniswapV3Venue();
    const hasRoute = await uniswapV3.supportsRoute(inner, WETH, USDC);
    if (!hasRoute) {
      throw new Error("Base 上找不到 WETH/USDC 的 Uniswap V3 池子，換匯這步沒辦法組出來");
    }
    await uniswapV3.convert(inner, { src: WETH, dst: USDC, srcAmount: wethOut });
    const callbackCalls = inner.flush();

    const outer = new LiquidationEncoder(EXECUTOR_ADDRESS, client);
    outer.balancerFlashLoan(
      BALANCER_VAULT_ADDRESS,
      [{ asset: USDC, amount: baseAmount }],
      callbackCalls,
    );

    return {
      calls: outer.flush(),
      blockNumber: SNAPSHOT_BLOCK,
      label: `Comet 完整鏈路：flashloan 借款 → absorb → buyCollateral(換得 ${wethOut} wei WETH) → UniswapV3 換回 USDC → 自動還款`,
    };
  },
};

const moonwellScenario: Scenario = {
  name: "moonwell",
  ready: true,
  findCommand:
    'cast logs --address 0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22 "LiquidateBorrow(address,address,uint256,address,uint256)" --from-block <BLOCK-300000> --to-block latest --rpc-url $RPC_URL_8453',
  build: async (client) => {
    const mUSDC = getAddress("0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22");
    const mWETH = getAddress("0x628ff693426583D9a7FB391E54366292F509D457");

    // 真實事件：block 48436780, tx 0x41f4ea9fae4b3f8632ce230a1856b2ff74e98633d0ae67ff526f58ff228e0f7b
    // liquidator=0xdadf95c322ab90d38a839778f61a584d0a246ea5（別人的清算機器人，不用管）
    // mTokenCollateral 剛好就是 mWETH，跟下面 encoder 呼叫對得上
    const LIQ_USER = getAddress("0xb64f1ebafbb3e64f975b54c963a249cb2f77b40b");
    const repayAmount = 8110242n; // 8.110242 USDC，跟真實那筆清算完全一致

    const le = new LiquidationEncoder(EXECUTOR_ADDRESS, client);
    le.moonwellLiquidateBorrow(mUSDC, mWETH, LIQ_USER, repayAmount);
    le.moonwellRedeem(mWETH, maxUint256);
    return {
      calls: le.flush(),
      blockNumber: 48436779n, // 真實 LiquidateBorrow tx 所在區塊(48436780) - 1
      label: "Moonwell liquidateBorrow + redeem（block 48436780 真實事件 -1）",
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 4. Morpho Blue liquidate — 真實 Liquidate 事件（WETH/USDC 市場）
//    tx 0xef26a7b5077aecffe595b4802075c61e6e73e39b3434b433caee9800a96b4949
//    block 48145750
//    marketId 0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda
//    repaidAssets / repaidShares / seizedAssets 從 event data 照抄
// ═══════════════════════════════════════════════════════════════════════════
const MORPHO_BLUE = getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
const MORPHO_WETH_USDC_MARKET = {
  loanToken: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), // USDC
  collateralToken: getAddress("0x4200000000000000000000000000000000000006"), // WETH
  oracle: getAddress("0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4"),
  irm: getAddress("0x46415998764C29aB2a25CbeA6254146D50D22687"),
  lltv: 860000000000000000n,
} as const;

const morphoScenario: Scenario = {
  name: "morpho",
  ready: true,
  findCommand:
    'cast logs --address 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb "Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)" --from-block <BLOCK-500000> --to-block latest --rpc-url $RPC_URL_BASE',
  build: async (client) => {
    // 真實 Liquidate：block 48145750, borrower 在 topics[3]
    const LIQ_USER = getAddress("0x5579c0eea13b3b7ac65df67e7107aba339d46d3b");
    // event data: repaidAssets, repaidShares, seizedAssets, badDebtAssets, badDebtShares
    const seizedAssets = 1831275589280431n; // 0x68228a3d462af wei WETH
    // repaidShares=0 → Morpho 依 seizedAssets 推算應還 shares（與 bot 路徑一致）

    const le = new LiquidationEncoder(EXECUTOR_ADDRESS, client);
    le.morphoBlueLiquidate(MORPHO_BLUE, { ...MORPHO_WETH_USDC_MARKET }, LIQ_USER, seizedAssets, 0n);
    return {
      calls: le.flush(),
      blockNumber: 48145749n, // 真實 tx block - 1
      label: "Morpho Blue liquidate（block 48145750 真實 WETH/USDC 事件 -1）",
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 4b. Morpho 完整鏈路：Balancer flash USDC → liquidate → UniswapV3 WETH→USDC → 還款
// ═══════════════════════════════════════════════════════════════════════════
const morphoFullFlashLoanScenario: Scenario = {
  name: "morpho-full",
  ready: true,
  findCommand: "（沿用 morpho 場景同一筆真實事件）",
  build: async (client) => {
    const USDC = MORPHO_WETH_USDC_MARKET.loanToken;
    const WETH = MORPHO_WETH_USDC_MARKET.collateralToken;
    const LIQ_USER = getAddress("0x5579c0eea13b3b7ac65df67e7107aba339d46d3b");
    const seizedAssets = 1831275589280431n;
    // flash 略多於 repaidAssets (3043214)，留一點餘量
    const flashUsdc = 3043214n + 1000n;

    const inner = new LiquidationEncoder(EXECUTOR_ADDRESS, client);
    // approve Morpho to pull USDC for debt repayment
    inner.erc20Approve(USDC, MORPHO_BLUE, maxUint256);
    inner.morphoBlueLiquidate(
      MORPHO_BLUE,
      { ...MORPHO_WETH_USDC_MARKET },
      LIQ_USER,
      seizedAssets,
      0n,
    );

    const uniswapV3 = new UniswapV3Venue();
    const hasRoute = await uniswapV3.supportsRoute(inner, WETH, USDC);
    if (!hasRoute) {
      throw new Error("Base 上找不到 WETH/USDC 的 Uniswap V3 池子，換匯這步沒辦法組出來");
    }
    await uniswapV3.convert(inner, { src: WETH, dst: USDC, srcAmount: seizedAssets });
    const callbackCalls = inner.flush();

    const outer = new LiquidationEncoder(EXECUTOR_ADDRESS, client);
    outer.balancerFlashLoan(
      BALANCER_VAULT_ADDRESS,
      [{ asset: USDC, amount: flashUsdc }],
      callbackCalls,
    );

    return {
      calls: outer.flush(),
      blockNumber: 48145749n,
      label: `Morpho 完整鏈路：flashloan USDC → liquidate(seized=${seizedAssets}) → UniswapV3 WETH→USDC → 自動還款`,
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 5. Aave 完整鏈路 —— 真實 Balancer flashloan 借款 → 清算 → 用生產代碼裡
//    同一個 UniswapV3Venue 把抓到的 WETH 換回 USDC → 自動還款
//
//    這跟前面 aaveScenario 的差異：前面只測了「清算呼叫本身」，執行前假設
//    Executor 手上已經有 USDC。這裡是完整鏈路，Executor 一開始什麼都沒有，
//    USDC 是透過真實 Balancer flashloan 借來的，清算完拿到的 WETH 也是透過
//    生產代碼裡真正在用的 UniswapV3Venue（不是我另外寫的假換匯邏輯）換回
//    USDC 拿去還款 —— 跟主網實際跑的邏輯完全一致，只是包在 eth_call 裡跑。
//
//    沿用跟 aaveScenario 同一筆真實歷史事件（block 38469381 - 1），
//    liquidatedCollateralAmount（真實從那筆事件解出來的 seized WETH 數量）
//    直接拿來當這次要換匯的 srcAmount，最貼近真實情境。
// ═══════════════════════════════════════════════════════════════════════════
const aaveFullFlashLoanScenario: Scenario = {
  name: "aave-full",
  ready: true,
  findCommand: "（沿用 aave 場景同一筆真實事件，不需要另外找）",
  build: async (client) => {
    const POOL_AAVE = getAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
    const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    const WETH = getAddress("0x4200000000000000000000000000000000000006");
    const LIQ_USER = getAddress("0x7093bd08ce24cbda45ebbccd0fb3b15ef617448f");
    const debtToCover = 350436203n; // 350.436203 USDC，跟真實那筆清算完全一致
    const seizedWethAmount = 139372859609576929n; // 0.13937... WETH，從真實事件 liquidatedCollateralAmount 解出來

    // ─ 第一段 encoder：清算 + 換匯，這些會被打包成 flashloan 的 callback ─
    const inner = new LiquidationEncoder(EXECUTOR_ADDRESS, client);
    inner.aaveLiquidationCall(POOL_AAVE, WETH, USDC, LIQ_USER, debtToCover, false);

    const uniswapV3 = new UniswapV3Venue();
    const hasRoute = await uniswapV3.supportsRoute(inner, WETH, USDC);
    if (!hasRoute) {
      throw new Error("Base 上找不到 WETH/USDC 的 Uniswap V3 池子，換匯這步沒辦法組出來");
    }
    await uniswapV3.convert(inner, { src: WETH, dst: USDC, srcAmount: seizedWethAmount });
    const callbackCalls = inner.flush();

    // ─ 第二段 encoder：真的包一層 Balancer flashloan（fee=0），把上面那組
    //   callback 塞進去，還款的 transfer 是 balancerFlashLoan() 自動加在
    //   callbackCalls 最後面的，不用自己另外組 ─
    const outer = new LiquidationEncoder(EXECUTOR_ADDRESS, client);
    outer.balancerFlashLoan(
      BALANCER_VAULT_ADDRESS,
      [{ asset: USDC, amount: debtToCover }],
      callbackCalls,
    );

    return {
      calls: outer.flush(),
      blockNumber: 38469380n,
      label: "Aave 完整鏈路：flashloan 借款 → 清算 → UniswapV3 換匯 → 自動還款",
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 3b. Moonwell 完整鏈路 —— flashloan 借 USDC → liquidateBorrow（花 USDC 換
//     mWETH）→ redeem 全部 mWETH（拿到底層 WETH）→ UniswapV3 換回 USDC →
//     自動還款
//
//     用 exchangeRateStored() 在同一個快照區塊精確算出 redeem 全部 mWETH
//     之後實際能拿到多少底層 WETH，換算方式跟 Compound V2 系列一致：
//     underlyingAmount = mTokenAmount * exchangeRate / 1e18
// ═══════════════════════════════════════════════════════════════════════════
const moonwellFullFlashLoanScenario: Scenario = {
  name: "moonwell-full",
  ready: true,
  findCommand: "（沿用 moonwell 場景同一筆真實事件，不需要另外找）",
  build: async (client) => {
    const mUSDC = getAddress("0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22");
    const mWETH = getAddress("0x628ff693426583D9a7FB391E54366292F509D457");
    const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    const WETH = getAddress("0x4200000000000000000000000000000000000006");
    const LIQ_USER = getAddress("0xb64f1ebafbb3e64f975b54c963a249cb2f77b40b");
    const repayAmount = 8110242n; // 8.110242 USDC，跟真實那筆清算完全一致
    const SNAPSHOT_BLOCK = 48436779n;

    // 這筆清算會讓 Executor 拿到多少 mWETH，是 Moonwell 依照當下 liquidation
    // incentive 算出來的，事件本身已經告訴我們真實數字（seizeTokens）
    const seizeTokens = 24197892n; // 從真實事件 data 解出來的 mWETH 數量（8 decimals）

    // 在同一個快照區塊問 mWETH：這些 mWETH 換成底層 WETH 實際是多少
    const exchangeRate = await readContract(client, {
      address: mWETH,
      abi: mTokenAbi,
      functionName: "exchangeRateStored",
      blockNumber: SNAPSHOT_BLOCK,
    });
    const wethOut = (seizeTokens * exchangeRate) / 10n ** 18n;

    const inner = new LiquidationEncoder(EXECUTOR_ADDRESS, client);
    inner.moonwellLiquidateBorrow(mUSDC, mWETH, LIQ_USER, repayAmount);
    inner.moonwellRedeem(mWETH, maxUint256);

    const uniswapV3 = new UniswapV3Venue();
    const hasRoute = await uniswapV3.supportsRoute(inner, WETH, USDC);
    if (!hasRoute) {
      throw new Error("Base 上找不到 WETH/USDC 的 Uniswap V3 池子，換匯這步沒辦法組出來");
    }
    await uniswapV3.convert(inner, { src: WETH, dst: USDC, srcAmount: wethOut });
    const callbackCalls = inner.flush();

    const outer = new LiquidationEncoder(EXECUTOR_ADDRESS, client);
    outer.balancerFlashLoan(
      BALANCER_VAULT_ADDRESS,
      [{ asset: USDC, amount: repayAmount }],
      callbackCalls,
    );

    return {
      calls: outer.flush(),
      blockNumber: SNAPSHOT_BLOCK,
      label: `Moonwell 完整鏈路：flashloan 借款 → liquidateBorrow → redeem(換得約 ${wethOut} wei WETH) → UniswapV3 換回 USDC → 自動還款`,
    };
  },
};

const SCENARIOS: Scenario[] = [
  aaveScenario,
  aaveFullFlashLoanScenario,
  cometScenario,
  cometFullFlashLoanScenario,
  moonwellScenario,
  moonwellFullFlashLoanScenario,
  morphoScenario,
  morphoFullFlashLoanScenario,
];

async function runScenario(client: any, scenario: Scenario) {
  console.log(`\n${"─".repeat(70)}`);
  console.log(`▶ ${scenario.name.toUpperCase()}`);
  console.log("─".repeat(70));

  if (!scenario.ready) {
    console.log("⏭  還沒填入真實資料，跳過模擬。用這行指令抓真實事件：\n");
    console.log(`   ${scenario.findCommand}\n`);
    console.log("   抓到之後把 borrower 地址 / 金額 / block 填進腳本裡對應的 TODO，重跑即可。");
    return;
  }

  const { calls, blockNumber, label } = await scenario.build(client);
  console.log(label);
  console.log(`組出 ${calls.length} 筆 call，準備在 block ${blockNumber} 送 eth_call 模擬...`);

  try {
    await client.simulateContract({
      address: EXECUTOR_ADDRESS,
      abi: executorAbi,
      functionName: "exec_606BaXt",
      args: [calls],
      account: OWNER_ADDRESS,
      blockNumber,
    });
    console.log("✅ 模擬成功 —— 這個真實部署的 Executor 合約接受了這筆 calldata。");
  } catch (e: any) {
    console.error("❌ 模擬失敗（revert）：");
    console.error(`   ${e.shortMessage ?? e.message}`);
  }
}

async function main() {
  // Prefer working Base RPCs (RPC_URL_8453 may be an inactive Alchemy app in the shell)
  const rpcUrl =
    firstNonEmpty(
      process.env.FORK_RPC_URL,
      process.env.RPC_URL_BASE,
      process.env.RPC_URL_BASE2,
      process.env.RPC_URL_8453,
      process.env.PUBLIC_RPC_URL_BASE,
      "https://mainnet.base.org",
    ) ?? "https://mainnet.base.org";

  // Historical block simulation needs archive-capable RPC
  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl, { timeout: 60_000 }),
  });

  const targets = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const target = targets.length > 0 ? targets.join(",") : "all";

  console.log("=== Executor 真實模擬呼叫 (eth_call，不花 gas) ===");
  console.log(`Executor:  ${EXECUTOR_ADDRESS}`);
  console.log(`Owner:     ${OWNER_ADDRESS}`);
  console.log(
    `RPC:       ${rpcUrl.replace(/\/v2\/[^/]+/, "/v2/***").replace(/api\/[^/]+\//, "api/***/")}`,
  );

  const targetSet = new Set(targets);
  const toRun = target === "all" ? SCENARIOS : SCENARIOS.filter((s) => targetSet.has(s.name));
  if (toRun.length === 0) {
    console.error(
      `找不到場景 "${target}"，可用: aave | aave-full | comet | comet-full | moonwell | moonwell-full | morpho | all`,
    );
    process.exitCode = 1;
    return;
  }

  for (const scenario of toRun) {
    await runScenario(client, scenario);
  }
}

main().catch((e: unknown) => {
  console.error("腳本執行失敗:", e);
  process.exit(1);
});
