import { createPublicClient, http, erc20Abi, encodeFunctionData } from "viem";
// ⚠️ 地址來源：Morpho 官方文件 (https://docs.morpho.org/get-started/resources/addresses/)
// 與 morpho-org/morpho-blue-oracles、pyth-network/pyth-morpho-wrapper 官方 repo README，
// 撰寫當下核對過，但地址可能隨官方新版部署變動，正式上線前務必自己重新核對一次。
const CHAINLINK_ORACLE_FACTORY = {
    1: "0x3A7bB36Ee3f3eE32A60e9f2b33c1e5f2E83ad766", // Ethereum
    8453: "0x2DC205F24BCb6B311E5cdf0745B0741648Aebd3d", // Base
};
const PYTH_ORACLE_FACTORY = {
    1: "0x1ed187354d6bfb983932d9983917b199a7253ab9", // Ethereum
    8453: "0x0A250c472cb43fb4F476cc6f47da9CA85E071Bbb", // Base
    42161: "0x3e2D5966bF67Ed2F66edfbc325f6bCf3d64EaA0A", // Arbitrum
};
const CHAINLINK_FACTORY_ABI = [
    {
        type: "function",
        name: "isMorphoChainlinkOracleV2",
        stateMutability: "view",
        inputs: [{ name: "target", type: "address" }],
        outputs: [{ type: "bool" }],
    },
];
// Pyth oracle factory 地址來源：pyth-network/pyth-morpho-wrapper 官方 repo README
// isMorphoPythOracle(address) 函式名稱已透過 bytecode selector 反推驗證：
//   selector 0xc1cb624b = keccak256("isMorphoPythOracle(address)")[0:4] ✓
//   與 basescan 上該合約的實際交易 method ID 完全吻合（密碼學碰撞機率可忽略）
const PYTH_FACTORY_ABI = [
    {
        type: "function",
        name: "isMorphoPythOracle",
        stateMutability: "view",
        inputs: [{ name: "target", type: "address" }],
        outputs: [{ type: "bool" }],
    },
];
const MIN_LLTV = 1n;
const MAX_LLTV = 990000000000000000n; // 99%
// EIP-1967 implementation slot — 如果此 slot 非零，说明合约是可升级代理
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
// 已知安全的代理代币（EIP-1967），跳过 proxy 扣分
// 地址來源：鏈上 getStorageAt(EIP1967_IMPL_SLOT) 掃描結果 + 各專案官方文檔
// 正式上線前務必用 scripts/check-proxy.ts 重新驗證
//
// SECURITY (M1): 此白名單為靜態硬編碼，新代理代幣不會自動加入。
// 建議定期（至少每月一次）執行 scripts/check-proxy.ts 掃描新市場中的代理代幣，
// 並更新此白名單。可整合至 CI/CD pipeline 自動提醒。
const SAFE_PROXY_ADDRESSES = {
    8453: new Set([
        "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC (Bridged USDC, Base)
        "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", // wstETH (Base)
        "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", // weETH (Base)
        "0x2416092f143378750bb29b79eD961ab195CcEea5", // ezETH (Base)
        "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc", // USDS (Sky/Bridge, Base)
        "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", // cbETH (Base)
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC (Native, Circle official on Base)
    ].map((a) => a.toLowerCase())),
    1: new Set([].map((a) => a.toLowerCase())),
    42161: new Set([].map((a) => a.toLowerCase())),
};
const PROXY_WHITELIST_LAST_REVIEWED = "2026-07-08"; // SECURITY (M1): 手動更新此日期以追蹤白名單審查時間
// SECURITY (NL1): 啟動時檢查白名單審查日期是否過期（超過 90 天）
(function checkProxyWhitelistFreshness() {
    const reviewed = new Date(PROXY_WHITELIST_LAST_REVIEWED);
    const now = new Date();
    const daysSince = Math.floor((now.getTime() - reviewed.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince > 90) {
        console.warn(`[safety] ⚠️ 代理白名單已 ${daysSince} 天未審查（上次: ${PROXY_WHITELIST_LAST_REVIEWED}）。` +
            `請執行 scripts/check-proxy.ts 重新掃描並更新 SAFE_PROXY_ADDRESSES`);
    }
})();
async function verifyOracle(chainSetup, oracle) {
    const client = createPublicClient({ chain: chainSetup.chain, transport: http(chainSetup.rpcUrl) });
    const chainlinkFactory = CHAINLINK_ORACLE_FACTORY[chainSetup.chainId];
    if (chainlinkFactory) {
        try {
            const isChainlinkOracle = await client.readContract({
                address: chainlinkFactory,
                abi: CHAINLINK_FACTORY_ABI,
                functionName: "isMorphoChainlinkOracleV2",
                args: [oracle],
            });
            if (isChainlinkOracle) {
                // SECURITY (H1): 額外檢查 oracle 報價新鮮度
                // 嘗試讀取 latestRoundData 檢查 updatedAt 是否過期
                const freshnessNote = await checkOracleFreshness(client, oracle, "Chainlink");
                return { verified: true, note: `oracle 由官方 MorphoChainlinkOracleV2Factory 部署${freshnessNote}` };
            }
        }
        catch (e) {
            console.warn(`[safety] 查詢 Chainlink factory 失敗:`, e);
        }
    }
    const pythFactory = PYTH_ORACLE_FACTORY[chainSetup.chainId];
    if (pythFactory) {
        try {
            const isPythOracle = await client.readContract({
                address: pythFactory,
                abi: PYTH_FACTORY_ABI,
                functionName: "isMorphoPythOracle",
                args: [oracle],
            });
            if (isPythOracle) {
                // SECURITY (H1): Pyth oracle 新鮮度檢查
                const freshnessNote = await checkOracleFreshness(client, oracle, "Pyth");
                return { verified: true, note: `oracle 由官方 MorphoPythOracleFactory 部署${freshnessNote}` };
            }
        }
        catch (e) {
            console.warn(`[safety] 查詢 Pyth factory 失敗:`, e);
        }
    }
    return {
        verified: false,
        note: "oracle 未被任何已知官方 factory 認證為合法部署，需人工審核（也可能是自訂 oracle，風險較高）",
    };
}
// SECURITY (H1): Oracle 報價新鮮度檢查
// 嘗試讀取 oracle 的 latestRoundData，檢查 updatedAt 是否在合理範圍內
const MAX_ORACLE_STALENESS_SECONDS = 86_400; // 24 小時
const LATEST_ROUND_DATA_ABI = [
    {
        type: "function",
        name: "latestRoundData",
        stateMutability: "view",
        inputs: [],
        outputs: [
            { name: "roundId", type: "uint80" },
            { name: "answer", type: "int256" },
            { name: "startedAt", type: "uint256" },
            { name: "updatedAt", type: "uint256" },
            { name: "answeredInRound", type: "uint80" },
        ],
    },
];
// SECURITY (NM9): Pyth oracle 使用 getPriceNoOlderThan 接口
// 返回 (price, conf, expo, publishTime)
const PYTH_GET_PRICE_ABI = [
    {
        type: "function",
        name: "getPriceNoOlderThan",
        stateMutability: "view",
        inputs: [{ name: "id", type: "bytes32" }, { name: "age", type: "uint256" }],
        outputs: [
            { name: "price", type: "tuple", components: [
                    { name: "price", type: "int64" },
                    { name: "conf", type: "uint64" },
                    { name: "expo", type: "int32" },
                    { name: "publishTime", type: "uint256" },
                ] },
        ],
    },
];
async function checkOracleFreshness(client, oracleAddress, oracleType) {
    if (oracleType === "Pyth") {
        return checkPythFreshness(client, oracleAddress);
    }
    return checkChainlinkFreshness(client, oracleAddress);
}
async function checkChainlinkFreshness(client, oracleAddress) {
    try {
        const roundData = await client.readContract({
            address: oracleAddress,
            abi: LATEST_ROUND_DATA_ABI,
            functionName: "latestRoundData",
        });
        const updatedAt = Number(roundData[3]);
        const now = Math.floor(Date.now() / 1000);
        const ageSeconds = now - updatedAt;
        if (ageSeconds > MAX_ORACLE_STALENESS_SECONDS) {
            const ageHours = (ageSeconds / 3600).toFixed(1);
            return ` ⚠️ 報價可能過期（${ageHours}h 前更新，超過 ${MAX_ORACLE_STALENESS_SECONDS / 3600}h 閾值）`;
        }
        const answer = roundData[1];
        if (answer <= 0n) {
            return ` ⚠️ 報價異常（answer=${answer.toString()}，應為正值）`;
        }
        return ` （報價新鮮度 OK，${Math.floor(ageSeconds / 60)} 分鐘前更新）`;
    }
    catch {
        return "";
    }
}
async function checkPythFreshness(client, oracleAddress) {
    // SECURITY (NM9): Pyth oracle wrapper 可能不暴露 latestRoundData，
    // 優先嘗試 Pyth 原生 getPriceNoOlderThan，失敗時回退到 latestRoundData
    try {
        // 先嘗試 Pyth 原生接口：讀取 priceId 然後調用 getPriceNoOlderThan
        // Morpho Pyth oracle 通常暴露 priceId() 返回 bytes32
        const priceIdAbi = [{
                type: "function",
                name: "priceId",
                stateMutability: "view",
                inputs: [],
                outputs: [{ name: "", type: "bytes32" }],
            }];
        let pythPriceId;
        try {
            pythPriceId = await client.readContract({
                address: oracleAddress,
                abi: priceIdAbi,
                functionName: "priceId",
            });
        }
        catch {
            // 沒有 priceId()，回退到 Chainlink 兼容接口
            return checkChainlinkFreshness(client, oracleAddress);
        }
        // 用 getPriceNoOlderThan 獲取最新價格（允許 MAX_ORACLE_STALENESS_SECONDS 內的數據）
        const result = await client.readContract({
            address: oracleAddress,
            abi: PYTH_GET_PRICE_ABI,
            functionName: "getPriceNoOlderThan",
            args: [pythPriceId, BigInt(MAX_ORACLE_STALENESS_SECONDS)],
        });
        const publishTime = Number(result.publishTime);
        const now = Math.floor(Date.now() / 1000);
        const ageSeconds = now - publishTime;
        if (ageSeconds > MAX_ORACLE_STALENESS_SECONDS) {
            const ageHours = (ageSeconds / 3600).toFixed(1);
            return ` ⚠️ Pyth 報價可能過期（${ageHours}h 前更新，超過 ${MAX_ORACLE_STALENESS_SECONDS / 3600}h 閾值）`;
        }
        const price = result.price;
        if (price <= 0n) {
            return ` ⚠️ Pyth 報價異常（price=${price.toString()}，應為正值）`;
        }
        return ` （Pyth 報價新鮮度 OK，${Math.floor(ageSeconds / 60)} 分鐘前更新）`;
    }
    catch {
        // 最終回退：嘗試 Chainlink 兼容接口
        return checkChainlinkFreshness(client, oracleAddress);
    }
}
/**
 * 检测代币合约是否为可升级代理（EIP-1967）
 * 可升级代理意味着 owner 可以随时替换逻辑，存在后门风险
 */
async function detectProxy(client, tokenAddress, label) {
    try {
        const implBytes = await client.getStorageAt({
            address: tokenAddress,
            slot: EIP1967_IMPL_SLOT,
        });
        // slot 全为零表示非代理
        if (implBytes && implBytes !== "0x" + "0".repeat(64)) {
            return {
                isProxy: true,
                note: `${label} (${tokenAddress}) 是可升级代理合约 (EIP-1967)，存在逻辑被替换的风险`,
            };
        }
    }
    catch {
        // 某些合约不支持 getStorageAt，忽略
    }
    return { isProxy: false, note: `${label} 非可升级代理 ✓` };
}
/**
 * ERC20 transfer 烟雾测试 — 用 eth_call 模拟一笔 0 金额的自转账
 * 如果 revert 或返回非 true，说明代币 transfer 行为异常
 */
async function smokeTestTransfer(client, tokenAddress, label) {
    try {
        // SECURITY (NM1): 移除不正確的 state override slot 計算。
        // 改用簡單方法：查詢 decimals 後，以 0 金額 transfer 測試（不依賴餘額）。
        // 大多數標準 ERC20 允許 0 金額轉賬而不需要 sender 有餘額。
        const testSender = "0x000000000000000000000000000000000000dEaD";
        const data = encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [testSender, 0n],
        });
        const result = await client.call({
            account: testSender,
            to: tokenAddress,
            data,
        });
        // 標準 ERC20 transfer 返回 bool；如果返回值存在且為 false 則異常
        if (result.data && result.data !== "0x" && result.data !== "0x" + "0".repeat(63) + "1") {
            return { ok: false, note: `${label} (${tokenAddress}) transfer 煙霧測試失敗：返回值非 true` };
        }
        return { ok: true, note: `${label} transfer 煙霧測試通過 ✓` };
    }
    catch {
        // revert 也視為異常（標準 ERC20 不應 revert 0 金額轉賬）
        return { ok: false, note: `${label} (${tokenAddress}) transfer 煙霧測試失敗：調用 revert` };
    }
}
// SECURITY (M2): 鏈上流動性檢查 — 直接查詢 + 多跳路由檢測
// 不依賴任何外部 API，完全鏈上驗證
// 策略：先查直接池，沒有則查兩個 token 是否分別與中間代幣（WETH/USDC）有池（支持多跳路由）
async function checkDexLiquidity(chainSetup, sellToken, buyToken) {
    // 跳過零地址（異常市場）
    const ZERO = "0x0000000000000000000000000000000000000000";
    if (sellToken === ZERO || buyToken === ZERO) {
        return { liquid: false, note: `交易對包含零地址，跳過流動性檢查`, estimatedUsd: 0, softFail: false };
    }
    // 相同代币无需检查
    if (sellToken.toLowerCase() === buyToken.toLowerCase()) {
        return { liquid: true, note: `同一代幣，無需流動性檢查`, estimatedUsd: 10000, softFail: false };
    }
    // Base 鏈常用中間代幣（多跳路由樞紐）
    const INTERMEDIARIES = [
        "0x4200000000000000000000000000000000000006", // WETH
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
        "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
    ].map(a => a.toLowerCase());
    // 如果 sellToken 或 buyToken 本身就是中間代幣，不需要再查中間跳
    const sellIsIntermediary = INTERMEDIARIES.includes(sellToken.toLowerCase());
    const buyIsIntermediary = INTERMEDIARIES.includes(buyToken.toLowerCase());
    const directResults = [];
    // 1. 直接池檢查（Uniswap V3 + Aerodrome）
    if (chainSetup.chainId === 8453) {
        const uniResult = await checkUniswapV3Liquidity(chainSetup, sellToken, buyToken);
        if (uniResult)
            directResults.push(uniResult);
        const aeroResult = await checkAerodromeLiquidity(chainSetup, sellToken, buyToken);
        if (aeroResult)
            directResults.push(aeroResult);
    }
    // 直接池有流動性 → 直接通過
    const directHit = directResults.find((r) => r.liquid);
    if (directHit) {
        return { ...directHit, softFail: false };
    }
    // 2. 多跳路由檢查：兩個 token 是否分別與中間代幣有池
    if (chainSetup.chainId === 8453 && !sellIsIntermediary && !buyIsIntermediary) {
        console.log(`[safety] 無直接池，檢查多跳路由...`);
        let sellHasRoute = false;
        let buyHasRoute = false;
        for (const intermediary of INTERMEDIARIES) {
            // 跳过与自身相同的中间代币
            if (sellToken.toLowerCase() === intermediary) {
                sellHasRoute = true;
                continue;
            }
            if (buyToken.toLowerCase() === intermediary) {
                buyHasRoute = true;
                continue;
            }
            if (!sellHasRoute) {
                const r = await checkUniswapV3Liquidity(chainSetup, sellToken, intermediary);
                if (r?.liquid)
                    sellHasRoute = true;
            }
            if (!sellHasRoute) {
                const r = await checkAerodromeLiquidity(chainSetup, sellToken, intermediary);
                if (r?.liquid)
                    sellHasRoute = true;
            }
            if (!buyHasRoute) {
                const r = await checkUniswapV3Liquidity(chainSetup, buyToken, intermediary);
                if (r?.liquid)
                    buyHasRoute = true;
            }
            if (!buyHasRoute) {
                const r = await checkAerodromeLiquidity(chainSetup, buyToken, intermediary);
                if (r?.liquid)
                    buyHasRoute = true;
            }
            // 两个都找到了，不需要继续检查其他中间代币
            if (sellHasRoute && buyHasRoute)
                break;
        }
        if (sellHasRoute && buyHasRoute) {
            return {
                liquid: true,
                note: `無直接池，但兩端均有中間代幣路由（sellToken→中間代幣→buyToken）✓`,
                estimatedUsd: 5000, // 多跳流动性保守估计
                softFail: false,
            };
        }
        const sellStatus = sellHasRoute ? "有" : "無";
        const buyStatus = buyHasRoute ? "有" : "無";
        return {
            liquid: false,
            note: `鏈上無直接池且多跳路由不完整（sellToken ${sellStatus}路由，buyToken ${buyStatus}路由）`,
            estimatedUsd: 0,
            softFail: false,
        };
    }
    // 其中一个是中间代币，但直接池没找到 → 可能是 Aerodrome stable pool 或流动性极低
    if (sellIsIntermediary || buyIsIntermediary) {
        // 已经在直接池检查中失败了，直接返回
    }
    const notes = directResults.map((r) => r.note).join("；");
    return { liquid: false, note: `鏈上流動性不足：${notes}`, estimatedUsd: 0, softFail: false };
}
// Uniswap V3 流動性直接查詢（不依賴聚合器 API）
async function checkUniswapV3Liquidity(chainSetup, tokenA, tokenB) {
    const UNISWAP_V3_FACTORY = {
        8453: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", // Base
    };
    const factory = UNISWAP_V3_FACTORY[chainSetup.chainId];
    if (!factory)
        return null;
    const FEE_TIERS = [500, 3000, 10000]; // 0.05%, 0.3%, 1%
    const FACTORY_ABI = [{
            name: "getPool",
            type: "function",
            stateMutability: "view",
            inputs: [
                { name: "tokenA", type: "address" },
                { name: "tokenB", type: "address" },
                { name: "fee", type: "uint24" },
            ],
            outputs: [{ name: "pool", type: "address" }],
        }];
    const POOL_ABI = [{
            name: "liquidity",
            type: "function",
            stateMutability: "view",
            inputs: [],
            outputs: [{ name: "", type: "uint128" }],
        }];
    try {
        console.log(`[safety] Uniswap V3 查詢: ${tokenA.slice(0, 10)}/${tokenB.slice(0, 10)}`);
        const client = createPublicClient({ chain: chainSetup.chain, transport: http(chainSetup.rpcUrl) });
        let totalLiquidity = 0n;
        let poolCount = 0;
        for (const fee of FEE_TIERS) {
            try {
                const pool = await client.readContract({
                    address: factory,
                    abi: FACTORY_ABI,
                    functionName: "getPool",
                    args: [tokenA, tokenB, fee],
                });
                if (pool !== "0x0000000000000000000000000000000000000000") {
                    const liquidity = await client.readContract({
                        address: pool,
                        abi: POOL_ABI,
                        functionName: "liquidity",
                    });
                    console.log(`[safety]   fee=${fee}: ✅ pool=${pool.slice(0, 10)}..., liquidity=${liquidity.toString().slice(0, 15)}...`);
                    totalLiquidity += liquidity;
                    poolCount++;
                }
            }
            catch {
                // 忽略單個 fee tier 查詢失敗
            }
        }
        console.log(`[safety] Uniswap V3 結果: ${poolCount} 個池, 總流動性=${totalLiquidity.toString().slice(0, 20)}...`);
        if (poolCount === 0) {
            return { liquid: false, note: "Uniswap V3 無此交易對池", estimatedUsd: 0 };
        }
        // 粗略估算：liquidity > 1e18 視為有足夠深度（實際需要更精確計算）
        // 這裡用寬鬆標準：只要池存在且有流動性就認為合格
        const hasLiquidity = totalLiquidity > 10n ** 18n;
        if (hasLiquidity) {
            // 粗略 USD 估算（假設池流動性約等於 $10,000+ 深度）
            const estimatedUsd = 10000; // 保守估計
            return {
                liquid: true,
                note: `Uniswap V3 確認有 ${poolCount} 個池，總流動性 ${totalLiquidity.toString().slice(0, 20)}...`,
                estimatedUsd,
            };
        }
        return {
            liquid: false,
            note: `Uniswap V3 池存在但流動性不足（${totalLiquidity.toString()}）`,
            estimatedUsd: 0,
        };
    }
    catch (e) {
        console.warn(`[safety] Uniswap V3 流動性查詢失敗:`, e.message);
        return null;
    }
}
// Aerodrome 流動性查詢（Base 鏈最大 DEX，Velodrome V2 fork）
async function checkAerodromeLiquidity(chainSetup, tokenA, tokenB) {
    // Aerodrome Factory on Base
    const AERODROME_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
    const FACTORY_ABI = [{
            name: "getPool",
            type: "function",
            stateMutability: "view",
            inputs: [
                { name: "tokenA", type: "address" },
                { name: "tokenB", type: "address" },
                { name: "stable", type: "bool" },
            ],
            outputs: [{ name: "pool", type: "address" }],
        }];
    const POOL_ABI = [{
            name: "getReserves",
            type: "function",
            stateMutability: "view",
            inputs: [],
            outputs: [
                { name: "reserve0", type: "uint112" },
                { name: "reserve1", type: "uint112" },
                { name: "blockTimestampLast", type: "uint32" },
            ],
        }];
    try {
        console.log(`[safety] Aerodrome 查詢: ${tokenA.slice(0, 10)}/${tokenB.slice(0, 10)}`);
        const client = createPublicClient({ chain: chainSetup.chain, transport: http(chainSetup.rpcUrl) });
        // 檢查 volatile 和 stable 兩種池
        let totalLiquidity = 0n;
        let poolCount = 0;
        for (const stable of [false, true]) {
            try {
                const pool = await client.readContract({
                    address: AERODROME_FACTORY,
                    abi: FACTORY_ABI,
                    functionName: "getPool",
                    args: [tokenA, tokenB, stable],
                });
                if (pool !== "0x0000000000000000000000000000000000000000") {
                    const reserves = await client.readContract({
                        address: pool,
                        abi: POOL_ABI,
                        functionName: "getReserves",
                    });
                    const reserve0 = reserves[0];
                    const reserve1 = reserves[1];
                    const liquidity = reserve0 + reserve1;
                    console.log(`[safety]   ${stable ? "stable" : "volatile"}: ✅ pool=${pool.slice(0, 10)}..., reserves=${liquidity.toString().slice(0, 15)}...`);
                    totalLiquidity += liquidity;
                    poolCount++;
                }
            }
            catch {
                // 忽略單個池類型查詢失敗
            }
        }
        console.log(`[safety] Aerodrome 結果: ${poolCount} 個池, 總儲備=${totalLiquidity.toString().slice(0, 20)}...`);
        if (poolCount === 0) {
            return { liquid: false, note: "Aerodrome 無此交易對池", estimatedUsd: 0 };
        }
        // 粗略估算：儲備 > 1e18 視為有足夠深度
        const hasLiquidity = totalLiquidity > 10n ** 18n;
        if (hasLiquidity) {
            const estimatedUsd = 10000; // 保守估計
            return {
                liquid: true,
                note: `Aerodrome 確認有 ${poolCount} 個池，總儲備 ${totalLiquidity.toString().slice(0, 20)}...`,
                estimatedUsd,
            };
        }
        return {
            liquid: false,
            note: `Aerodrome 池存在但儲備不足（${totalLiquidity.toString()}）`,
            estimatedUsd: 0,
        };
    }
    catch (e) {
        console.warn(`[safety] Aerodrome 流動性查詢失敗:`, e.message);
        return null;
    }
}
export async function runSafetyChecks(input) {
    const notes = [];
    const hardFailReasons = [];
    let score = 100;
    // ── 1. LLTV 范围检查 ──
    if (input.lltv < MIN_LLTV || input.lltv > MAX_LLTV) {
        notes.push(`LLTV 異常: ${input.lltv.toString()}`);
        score -= 100;
        hardFailReasons.push("LLTV 超出安全範圍");
    }
    // ── 2. Oracle 认证（未认证扣分但不直接拒绝，让其他检查综合判断）──
    const oracleResult = await verifyOracle(input.chainSetup, input.oracle);
    notes.push(oracleResult.note);
    if (!oracleResult.verified) {
        score -= 30; // 扣分但不加入 hardFailReasons（自定义 oracle 不一定不安全）
    }
    const client = createPublicClient({ chain: input.chainSetup.chain, transport: http(input.chainSetup.rpcUrl) });
    // ── 3. ERC20 基础检查 + 代理检测 + transfer 烟雾测试 ──
    for (const [label, token] of [
        ["loanToken", input.loanToken],
        ["collateralToken", input.collateralToken],
    ]) {
        // 3a. decimals 可读
        try {
            await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
        }
        catch {
            notes.push(`${label} (${token}) 無法讀取 decimals，可能非標準 ERC20`);
            score -= 100;
            hardFailReasons.push(`${label} 非標準 ERC20（decimals 不可讀）`);
        }
        // 3b. 代理检测（已知安全代理跳過）
        const proxyResult = await detectProxy(client, token, label);
        const isSafeProxy = SAFE_PROXY_ADDRESSES[input.chainSetup.chainId]?.has(token.toLowerCase());
        if (proxyResult.isProxy && !isSafeProxy) {
            notes.push(proxyResult.note);
            score -= 45; // 扣分足以單獨攔截（100-45=55 < 60），但不加入 hardFail
        }
        else if (proxyResult.isProxy && isSafeProxy) {
            notes.push(`${label} 是已知安全代理合約（已白名單豁免）✓`);
        }
        else {
            notes.push(proxyResult.note);
        }
        // 3c. transfer 烟雾测试
        const transferResult = await smokeTestTransfer(client, token, label);
        notes.push(transferResult.note);
        if (!transferResult.ok) {
            score -= 50;
            hardFailReasons.push(`${label} transfer 煙霧測試失敗`);
        }
    }
    // ── 4. DEX 流動性深度檢查（鏈上 Uniswap V3 + Aerodrome）──
    const liquidityResult = await checkDexLiquidity(input.chainSetup, input.collateralToken, input.loanToken);
    notes.push(liquidityResult.note);
    if (!liquidityResult.liquid) {
        if (liquidityResult.softFail) {
            // NC1: 軟失敗 — 僅扣分，不加入 hardFailReasons
            score -= 20; // 較低的扣分（原 40），因為可能是 API 問題而非真的沒流動性
            notes.push("ℹ️ 鏈上流動性來源不可用，僅軟扣分");
        }
        else {
            score -= 40;
            hardFailReasons.push("DEX 流動性深度不足或無報價");
        }
    }
    // ── 最终判定 ──
    // 硬性条件：有任何 hardFail 原因则直接拒绝
    const hardFail = hardFailReasons.length > 0;
    const approved = !hardFail && score >= 60;
    return { approved, score: Math.max(score, 0), notes, hardFail, hardFailReasons };
}
