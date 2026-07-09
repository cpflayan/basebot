/**
 * 掃描 Morpho Blue on Base 的清算機會
 * 過濾壞賬，只顯示有利可圖的清算目標
 *
 * 用法: npx tsx scripts/scan-liquidations.ts
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var MORPHO_API = "https://api.morpho.org/graphql";
var BASE_CHAIN_ID = 8453;
var WHITELIST_PATH = process.env.WHITELIST_DATA_DIR
    ? "".concat(process.env.WHITELIST_DATA_DIR, "/discovered-markets.").concat(BASE_CHAIN_ID, ".json")
    : "./data/discovered-markets.8453.json";
// 過濾門檻
var MIN_COLLATERAL_USD = 100; // 抵押品至少 $100 才值得看（排除壞賬和粉塵倉位）
var MIN_BORROW_USD = 50; // 借款至少 $50
var MAX_TOP_MARKETS = 50; // 掃描借款最大的 N 個市場
// ─── GraphQL Queries ───
var MARKETS_QUERY = "\n  query Markets($first: Int, $skip: Int, $where: MarketFilters) {\n    markets(first: $first, skip: $skip, orderBy: BorrowAssetsUsd, orderDirection: Desc, where: $where) {\n      items {\n        marketId\n        lltv\n        loanAsset { address symbol decimals }\n        collateralAsset { address symbol decimals }\n        oracle { address }\n        state {\n          borrowAssets\n          borrowAssetsUsd\n          supplyAssets\n          supplyAssetsUsd\n          collateralAssets\n          collateralAssetsUsd\n          utilization\n        }\n      }\n      pageInfo { count countTotal }\n    }\n  }\n";
var POSITIONS_QUERY = "\n  query Positions($first: Int, $skip: Int, $where: MarketPositionFilters) {\n    marketPositions(first: $first, skip: $skip, orderBy: BorrowShares, orderDirection: Desc, where: $where) {\n      items {\n        user { address }\n        market { marketId }\n        state {\n          borrowShares\n          borrowAssets\n          borrowAssetsUsd\n          collateral\n          collateralUsd\n          supplyShares\n          supplyAssets\n          supplyAssetsUsd\n        }\n      }\n      pageInfo { count countTotal }\n    }\n  }\n";
// ─── API Helper ───
function gql(query_1) {
    return __awaiter(this, arguments, void 0, function (query, variables) {
        var res, text, json;
        if (variables === void 0) { variables = {}; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, fetch(MORPHO_API, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ query: query, variables: variables }),
                    })];
                case 1:
                    res = _a.sent();
                    if (!!res.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, res.text()];
                case 2:
                    text = _a.sent();
                    throw new Error("API error ".concat(res.status, ": ").concat(text.slice(0, 300)));
                case 3: return [4 /*yield*/, res.json()];
                case 4:
                    json = (_a.sent());
                    if (json.errors) {
                        console.error("GraphQL errors:", JSON.stringify(json.errors, null, 2).slice(0, 500));
                    }
                    return [2 /*return*/, json.data];
            }
        });
    });
}
// ─── Health Factor 計算 ───
// Morpho Blue: liquidatable when borrowValue > collateralValue * lltv
// HF = (collateralValue * lltv) / borrowValue
// HF < 1 = liquidatable
function calcHealthFactor(borrowUsd, collateralUsd, lltv) {
    if (borrowUsd <= 0)
        return Infinity;
    if (collateralUsd <= 0)
        return 0;
    return (collateralUsd * lltv) / borrowUsd;
}
// ─── 清算利潤估算（修正版）───
// Morpho Blue 清算機制：
//   清算人償還 X 的債務，獲得價值 X × (1 + incentive) 的抵押品
//   但最多只能沒收倉位的全部抵押品
//
// 因此：
//   maxRepay = min(borrowUsd, collateralUsd / (1 + incentive))
//   grossProfit = maxRepay × incentive
//
// 當 collateralUsd < borrowUsd（HF<1）時：
//   如果 collateralUsd 很小 → maxRepay 很小 → 利潤很小（大部分債務無法回收 = 壞賬）
//   如果 collateralUsd 接近 borrowUsd → 利潤 = 差額部分的 incentive
var LIQUIDATION_INCENTIVE = 0.05; // 假設 5% 清算獎勵（實際由市場 curator 設定）
var SLIPPAGE_BPS = 30; // 假設 DEX 兌換滑點 0.3%（30 bps）
var GAS_COST_USD = 0.10; // Base 鏈 Gas 約 $0.01-0.10
function estimateLiquidationProfit(borrowUsd, collateralUsd, lltv) {
    // 核心公式：最多能偿还多少债务（受限于可没收的抵押品）
    var maxRepayUsd = Math.min(borrowUsd, collateralUsd / (1 + LIQUIDATION_INCENTIVE));
    var seizedCollateralUsd = maxRepayUsd * (1 + LIQUIDATION_INCENTIVE);
    var grossProfitUsd = seizedCollateralUsd - maxRepayUsd; // = maxRepayUsd × incentive
    // 净利润：扣除滑点和 Gas
    var slippageCost = seizedCollateralUsd * (SLIPPAGE_BPS / 10000);
    var netProfitUsd = grossProfitUsd - slippageCost - GAS_COST_USD;
    // 坏账判定：抵押品不足以覆盖全部债务
    var isBadDebt = collateralUsd < borrowUsd;
    var unrecoverableDebtUsd = isBadDebt ? borrowUsd - collateralUsd : 0;
    var profitable = netProfitUsd > 0 && collateralUsd > 0;
    return { profitable: profitable, maxRepayUsd: maxRepayUsd, seizedCollateralUsd: seizedCollateralUsd, grossProfitUsd: grossProfitUsd, netProfitUsd: netProfitUsd, isBadDebt: isBadDebt, unrecoverableDebtUsd: unrecoverableDebtUsd };
}
// ─── 分頁抓取倉位 ───
function fetchAllPositions(marketIds) {
    return __awaiter(this, void 0, void 0, function () {
        var allPositions, batchSize, _i, marketIds_1, marketId, skip, hasMore, data, positions, total, e_1;
        var _a, _b, _c, _d, _e;
        return __generator(this, function (_f) {
            switch (_f.label) {
                case 0:
                    allPositions = [];
                    batchSize = 100;
                    _i = 0, marketIds_1 = marketIds;
                    _f.label = 1;
                case 1:
                    if (!(_i < marketIds_1.length)) return [3 /*break*/, 8];
                    marketId = marketIds_1[_i];
                    skip = 0;
                    hasMore = true;
                    _f.label = 2;
                case 2:
                    if (!hasMore) return [3 /*break*/, 7];
                    _f.label = 3;
                case 3:
                    _f.trys.push([3, 5, , 6]);
                    return [4 /*yield*/, gql(POSITIONS_QUERY, {
                            first: batchSize,
                            skip: skip,
                            where: {
                                marketUniqueKey_in: [marketId],
                                borrowShares_gte: "1",
                            },
                        })];
                case 4:
                    data = _f.sent();
                    positions = (_b = (_a = data === null || data === void 0 ? void 0 : data.marketPositions) === null || _a === void 0 ? void 0 : _a.items) !== null && _b !== void 0 ? _b : [];
                    allPositions.push.apply(allPositions, positions);
                    total = (_e = (_d = (_c = data === null || data === void 0 ? void 0 : data.marketPositions) === null || _c === void 0 ? void 0 : _c.pageInfo) === null || _d === void 0 ? void 0 : _d.count) !== null && _e !== void 0 ? _e : 0;
                    skip += batchSize;
                    hasMore = skip < total;
                    return [3 /*break*/, 6];
                case 5:
                    e_1 = _f.sent();
                    console.error("  \u6293\u53D6 market ".concat(marketId.slice(0, 10), "... skip=").concat(skip, " \u5931\u6557:"), e_1.message);
                    hasMore = false;
                    return [3 /*break*/, 6];
                case 6: return [3 /*break*/, 2];
                case 7:
                    _i++;
                    return [3 /*break*/, 1];
                case 8: return [2 /*return*/, allPositions];
            }
        });
    });
}
// ─── 格式化 ───
function fmt$(n) {
    if (n >= 1000000)
        return "$".concat((n / 1000000).toFixed(2), "M");
    if (n >= 1000)
        return "$".concat((n / 1000).toFixed(1), "K");
    return "$".concat(n.toFixed(2));
}
// ─── 載入白名單 ───
function loadWhitelist() {
    return __awaiter(this, void 0, void 0, function () {
        var fs, raw, approved, e_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, Promise.resolve().then(function () { return require("fs"); })];
                case 1:
                    fs = _a.sent();
                    if (!fs.existsSync(WHITELIST_PATH)) {
                        console.warn("\u26A0\uFE0F  \u767D\u540D\u55AE\u6587\u4EF6\u4E0D\u5B58\u5728: ".concat(WHITELIST_PATH));
                        console.warn("   \u5C07\u6383\u63CF\u6240\u6709\u5E02\u5834\uFF08\u7121\u767D\u540D\u55AE\u904E\u6FFE\uFF09\n");
                        return [2 /*return*/, new Set()];
                    }
                    raw = JSON.parse(fs.readFileSync(WHITELIST_PATH, "utf-8"));
                    if (!Array.isArray(raw)) {
                        console.warn("\u26A0\uFE0F  \u767D\u540D\u55AE\u683C\u5F0F\u7570\u5E38\uFF0C\u5C07\u6383\u63CF\u6240\u6709\u5E02\u5834\n");
                        return [2 /*return*/, new Set()];
                    }
                    approved = raw
                        .filter(function (m) { return m.approved === true && m.marketId; })
                        .map(function (m) { return m.marketId.toLowerCase(); });
                    console.log("\u2705 \u5DF2\u8F09\u5165\u767D\u540D\u55AE: ".concat(approved.length, " \u500B\u5E02\u5834 (from ").concat(WHITELIST_PATH, ")\n"));
                    return [2 /*return*/, new Set(approved)];
                case 2:
                    e_2 = _a.sent();
                    console.warn("\u26A0\uFE0F  \u8B80\u53D6\u767D\u540D\u55AE\u5931\u6557: ".concat(e_2.message, "\uFF0C\u5C07\u6383\u63CF\u6240\u6709\u5E02\u5834\n"));
                    return [2 /*return*/, new Set()];
                case 3: return [2 /*return*/];
            }
        });
    });
}
// ─── Main ───
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var whitelist, useWhitelist, allMarkets, totalMarkets, marketIds_2, batchSize, i, batch, data, markets, foundIds_1, missingIds, skip, batchSize, data, markets, activeMarkets, totalBorrowUsd, topMarkets, marketIds, allPositions, marketMap, _i, allMarkets_1, m, badDebt, profitableLiquidations, unprofitableUnderwater, atRisk, safe, skipped, _a, allPositions_1, pos, market, borrowUsd, collateralUsd, lltv, hf, profit, target, totalBadDebt, _b, _c, t, totalProfitBorrow, totalProfitEstimate, totalUnrecovable, _d, _e, t, distanceToLiq, totalAtRiskBorrow, totalUnprofitable;
        var _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y;
        return __generator(this, function (_z) {
            switch (_z.label) {
                case 0:
                    console.log("=== Morpho Blue 清算掃描器 (Base chain) ===");
                    console.log("\u904E\u6FFE\u689D\u4EF6: \u62B5\u62BC\u54C1 >= $".concat(MIN_COLLATERAL_USD, ", \u501F\u6B3E >= $").concat(MIN_BORROW_USD, "\n"));
                    return [4 /*yield*/, loadWhitelist()];
                case 1:
                    whitelist = _z.sent();
                    useWhitelist = whitelist.size > 0;
                    allMarkets = [];
                    totalMarkets = 0;
                    if (!useWhitelist) return [3 /*break*/, 6];
                    // 優化：直接查詢白名單市場（避免抓取全部 3,442 個）
                    console.log("\uD83D\uDCE1 \u6B63\u5728\u67E5\u8A62 ".concat(whitelist.size, " \u500B\u767D\u540D\u55AE\u5E02\u5834..."));
                    marketIds_2 = Array.from(whitelist);
                    batchSize = 100;
                    i = 0;
                    _z.label = 2;
                case 2:
                    if (!(i < marketIds_2.length)) return [3 /*break*/, 5];
                    batch = marketIds_2.slice(i, i + batchSize);
                    return [4 /*yield*/, gql(MARKETS_QUERY, {
                            first: batchSize,
                            skip: 0,
                            where: { marketUniqueKey_in: batch, chainId_in: [BASE_CHAIN_ID] },
                        })];
                case 3:
                    data = _z.sent();
                    markets = (_g = (_f = data === null || data === void 0 ? void 0 : data.markets) === null || _f === void 0 ? void 0 : _f.items) !== null && _g !== void 0 ? _g : [];
                    allMarkets.push.apply(allMarkets, markets);
                    if (i + batchSize < marketIds_2.length) {
                        console.log("  \u5DF2\u67E5\u8A62 ".concat(Math.min(i + batchSize, marketIds_2.length), "/").concat(marketIds_2.length, " \u500B\u767D\u540D\u55AE\u5E02\u5834"));
                    }
                    _z.label = 4;
                case 4:
                    i += batchSize;
                    return [3 /*break*/, 2];
                case 5:
                    console.log("  \u5B8C\u6210: \u627E\u5230 ".concat(allMarkets.length, "/").concat(whitelist.size, " \u500B\u767D\u540D\u55AE\u5E02\u5834"));
                    foundIds_1 = new Set(allMarkets.map(function (m) { return m.marketId.toLowerCase(); }));
                    missingIds = marketIds_2.filter(function (id) { return !foundIds_1.has(id); });
                    if (missingIds.length > 0) {
                        console.log("  \u26A0\uFE0F  ".concat(missingIds.length, " \u500B\u767D\u540D\u55AE\u5E02\u5834\u4E0D\u5728 API \u4E2D\uFF08\u53EF\u80FD\u672A\u7D22\u5F15\u6216\u5DF2\u4E0B\u67B6\uFF09"));
                    }
                    console.log("");
                    return [3 /*break*/, 10];
                case 6:
                    // 無白名單時抓取全部市場
                    console.log("📡 正在抓取 Base 鏈上所有 Morpho Blue 市場...");
                    skip = 0;
                    batchSize = 100;
                    _z.label = 7;
                case 7:
                    if (!true) return [3 /*break*/, 9];
                    return [4 /*yield*/, gql(MARKETS_QUERY, {
                            first: batchSize,
                            skip: skip,
                            where: { chainId_in: [BASE_CHAIN_ID] },
                        })];
                case 8:
                    data = _z.sent();
                    markets = (_j = (_h = data === null || data === void 0 ? void 0 : data.markets) === null || _h === void 0 ? void 0 : _h.items) !== null && _j !== void 0 ? _j : [];
                    allMarkets.push.apply(allMarkets, markets);
                    totalMarkets = (_m = (_l = (_k = data === null || data === void 0 ? void 0 : data.markets) === null || _k === void 0 ? void 0 : _k.pageInfo) === null || _l === void 0 ? void 0 : _l.countTotal) !== null && _m !== void 0 ? _m : 0;
                    if (allMarkets.length % 500 === 0)
                        console.log("  \u5DF2\u6293\u53D6 ".concat(allMarkets.length, "/").concat(totalMarkets, " \u500B\u5E02\u5834"));
                    if (allMarkets.length >= totalMarkets || markets.length < batchSize)
                        return [3 /*break*/, 9];
                    skip += batchSize;
                    return [3 /*break*/, 7];
                case 9:
                    console.log("  \u5B8C\u6210: ".concat(allMarkets.length, " \u500B\u5E02\u5834\n"));
                    _z.label = 10;
                case 10:
                    activeMarkets = allMarkets.filter(function (m) { var _a, _b; return Number((_b = (_a = m.state) === null || _a === void 0 ? void 0 : _a.borrowAssetsUsd) !== null && _b !== void 0 ? _b : 0) > 100; });
                    activeMarkets.sort(function (a, b) { var _a, _b, _c, _d; return Number((_b = (_a = b.state) === null || _a === void 0 ? void 0 : _a.borrowAssetsUsd) !== null && _b !== void 0 ? _b : 0) - Number((_d = (_c = a.state) === null || _c === void 0 ? void 0 : _c.borrowAssetsUsd) !== null && _d !== void 0 ? _d : 0); });
                    totalBorrowUsd = activeMarkets.reduce(function (s, m) { var _a, _b; return s + Number((_b = (_a = m.state) === null || _a === void 0 ? void 0 : _a.borrowAssetsUsd) !== null && _b !== void 0 ? _b : 0); }, 0);
                    console.log("\uD83D\uDCCA \u6D3B\u8E8D\u5E02\u5834: ".concat(activeMarkets.length, " \u500B, \u7E3D\u501F\u6B3E: ").concat(fmt$(totalBorrowUsd)));
                    topMarkets = activeMarkets.slice(0, MAX_TOP_MARKETS);
                    console.log("\uD83D\uDD0D \u6383\u63CF Top ".concat(topMarkets.length, " \u767D\u540D\u55AE\u5E02\u5834\u7684\u5009\u4F4D...\n"));
                    marketIds = topMarkets.map(function (m) { return m.marketId; });
                    return [4 /*yield*/, fetchAllPositions(marketIds)];
                case 11:
                    allPositions = _z.sent();
                    console.log("\n\uD83D\uDCCA \u5171\u6293\u53D6 ".concat(allPositions.length, " \u500B\u6709\u501F\u6B3E\u7684\u5009\u4F4D\n"));
                    marketMap = new Map();
                    for (_i = 0, allMarkets_1 = allMarkets; _i < allMarkets_1.length; _i++) {
                        m = allMarkets_1[_i];
                        marketMap.set(m.marketId, m);
                    }
                    badDebt = [];
                    profitableLiquidations = [];
                    unprofitableUnderwater = [];
                    atRisk = [];
                    safe = [];
                    skipped = 0;
                    for (_a = 0, allPositions_1 = allPositions; _a < allPositions_1.length; _a++) {
                        pos = allPositions_1[_a];
                        market = marketMap.get((_o = pos.market) === null || _o === void 0 ? void 0 : _o.marketId);
                        if (!market)
                            continue;
                        borrowUsd = Number((_q = (_p = pos.state) === null || _p === void 0 ? void 0 : _p.borrowAssetsUsd) !== null && _q !== void 0 ? _q : 0);
                        collateralUsd = Number((_s = (_r = pos.state) === null || _r === void 0 ? void 0 : _r.collateralUsd) !== null && _s !== void 0 ? _s : 0);
                        lltv = Number(market.lltv) / 1e18;
                        // 跳過粉塵倉位
                        if (borrowUsd < MIN_BORROW_USD && collateralUsd < MIN_COLLATERAL_USD) {
                            skipped++;
                            continue;
                        }
                        hf = calcHealthFactor(borrowUsd, collateralUsd, lltv);
                        profit = estimateLiquidationProfit(borrowUsd, collateralUsd, lltv);
                        target = {
                            marketId: (_t = pos.market) === null || _t === void 0 ? void 0 : _t.marketId,
                            user: (_u = pos.user) === null || _u === void 0 ? void 0 : _u.address,
                            borrowUsd: borrowUsd,
                            collateralUsd: collateralUsd,
                            lltv: lltv,
                            hf: hf,
                            loanSymbol: (_w = (_v = market.loanAsset) === null || _v === void 0 ? void 0 : _v.symbol) !== null && _w !== void 0 ? _w : "?",
                            collateralSymbol: (_y = (_x = market.collateralAsset) === null || _x === void 0 ? void 0 : _x.symbol) !== null && _y !== void 0 ? _y : "?",
                            profit: profit,
                        };
                        if (hf < 1 && collateralUsd < MIN_COLLATERAL_USD) {
                            badDebt.push(target);
                        }
                        else if (hf < 1 && profit.profitable) {
                            profitableLiquidations.push(target);
                        }
                        else if (hf < 1) {
                            unprofitableUnderwater.push(target);
                        }
                        else if (hf < 1.05) {
                            atRisk.push(target);
                        }
                        else {
                            safe.push(target);
                        }
                    }
                    // ─── 輸出結果 ───
                    // 壞賬統計
                    console.log("═".repeat(80));
                    console.log("\u26AB \u58DE\u8CEC (HF<1, \u62B5\u62BC\u54C1<$".concat(MIN_COLLATERAL_USD, "): ").concat(badDebt.length, " \u500B \u2014 \u4E0D\u53EF\u6E05\u7B97\uFF0C\u8DF3\u904E"));
                    console.log("═".repeat(80));
                    totalBadDebt = badDebt.reduce(function (s, t) { return s + t.borrowUsd; }, 0);
                    console.log("  \u58DE\u8CEC\u7E3D\u501F\u6B3E: ".concat(fmt$(totalBadDebt), "\uFF08\u9019\u4E9B\u662F\u5354\u8B70\u640D\u5931\uFF0C\u4E0D\u662F\u4F60\u7684\u5229\u6F64\uFF09\n"));
                    // 真正可清算
                    console.log("═".repeat(80));
                    console.log("\uD83D\uDD34 \u53EF\u6E05\u7B97\u4E14\u6709\u5229\u53EF\u5716 (HF<1, \u6DE8\u5229\u6F64>0): ".concat(profitableLiquidations.length, " \u500B"));
                    console.log("═".repeat(80));
                    profitableLiquidations.sort(function (a, b) { return b.profit.netProfitUsd - a.profit.netProfitUsd; });
                    for (_b = 0, _c = profitableLiquidations.slice(0, 30); _b < _c.length; _b++) {
                        t = _c[_b];
                        console.log("  HF=".concat(t.hf.toFixed(4), " | \u501F\u6B3E=").concat(fmt$(t.borrowUsd), " | \u62B5\u62BC=").concat(fmt$(t.collateralUsd), " | ") +
                            "\u53EF\u56DE\u6536=".concat(fmt$(t.profit.maxRepayUsd), " | \u6DE8\u5229\u6F64=").concat(fmt$(t.profit.netProfitUsd), " | ") +
                            "".concat(t.loanSymbol, "/").concat(t.collateralSymbol, " (LLTV=").concat((t.lltv * 100).toFixed(1), "%) | ").concat(t.user.slice(0, 12), "..."));
                    }
                    if (profitableLiquidations.length > 30)
                        console.log("  ... \u9084\u6709 ".concat(profitableLiquidations.length - 30, " \u500B"));
                    totalProfitBorrow = profitableLiquidations.reduce(function (s, t) { return s + t.borrowUsd; }, 0);
                    totalProfitEstimate = profitableLiquidations.reduce(function (s, t) { return s + t.profit.netProfitUsd; }, 0);
                    console.log("\n  \uD83D\uDCB0 \u53EF\u6E05\u7B97\u7E3D\u501F\u6B3E: ".concat(fmt$(totalProfitBorrow)));
                    console.log("  \uD83D\uDCB5 \u9810\u4F30\u6DE8\u5229\u6F64 (\u6263\u6ED1\u9EDE+Gas): ".concat(fmt$(totalProfitEstimate), "\n"));
                    // 水下但无利润（坏账但抵押品 > $100）
                    if (unprofitableUnderwater.length > 0) {
                        console.log("═".repeat(80));
                        console.log("\u26A0\uFE0F  \u6C34\u4E0B\u4F46\u7121\u5229\u6F64 (HF<1, \u6DE8\u5229\u6F64<=0): ".concat(unprofitableUnderwater.length, " \u500B \u2014 \u6E05\u7B97\u6703\u8667\u9322\uFF0C\u8DF3\u904E"));
                        console.log("═".repeat(80));
                        totalUnrecovable = unprofitableUnderwater.reduce(function (s, t) { return s + t.profit.unrecoverableDebtUsd; }, 0);
                        console.log("  \u7121\u6CD5\u56DE\u6536\u50B5\u52D9: ".concat(fmt$(totalUnrecovable), "\n"));
                    }
                    // 高風險（接近清算）
                    console.log("═".repeat(80));
                    console.log("\uD83D\uDFE1 \u9AD8\u98A8\u96AA (HF 1~1.05): ".concat(atRisk.length, " \u500B \u2014 \u5C0F\u5E45\u6CE2\u52D5\u5373\u89F8\u767C\u6E05\u7B97"));
                    console.log("═".repeat(80));
                    atRisk.sort(function (a, b) { return a.hf - b.hf; });
                    for (_d = 0, _e = atRisk.slice(0, 30); _d < _e.length; _d++) {
                        t = _e[_d];
                        distanceToLiq = ((t.hf - 1) * 100).toFixed(2);
                        console.log("  HF=".concat(t.hf.toFixed(4), " (\u8DDD\u6E05\u7B97 ").concat(distanceToLiq, "%) | \u501F\u6B3E=").concat(fmt$(t.borrowUsd), " | \u62B5\u62BC=").concat(fmt$(t.collateralUsd), " | ") +
                            "".concat(t.loanSymbol, "/").concat(t.collateralSymbol, " | ").concat(t.user.slice(0, 12), "..."));
                    }
                    if (atRisk.length > 30)
                        console.log("  ... \u9084\u6709 ".concat(atRisk.length - 30, " \u500B"));
                    totalAtRiskBorrow = atRisk.reduce(function (s, t) { return s + t.borrowUsd; }, 0);
                    console.log("\n  \uD83D\uDCB0 \u9AD8\u98A8\u96AA\u7E3D\u501F\u6B3E: ".concat(fmt$(totalAtRiskBorrow), "\n"));
                    // 總結
                    console.log("═".repeat(80));
                    console.log("📈 總結");
                    console.log("═".repeat(80));
                    if (useWhitelist) {
                        console.log("  \u767D\u540D\u55AE\u5E02\u5834: ".concat(allMarkets.length));
                    }
                    else {
                        console.log("  Base \u93C8 Morpho Blue \u5E02\u5834: ".concat(allMarkets.length));
                    }
                    console.log("  \u6D3B\u8E8D\u5E02\u5834 (\u501F\u6B3E>$100): ".concat(activeMarkets.length));
                    console.log("  \u6383\u63CF\u7684\u5009\u4F4D: ".concat(allPositions.length, " (\u8DF3\u904E\u7C89\u5875 ").concat(skipped, ")"));
                    console.log("  \u26AB \u58DE\u8CEC (\u4E0D\u53EF\u6E05\u7B97): ".concat(badDebt.length, " \u500B, ").concat(fmt$(totalBadDebt)));
                    console.log("  \uD83D\uDD34 \u53EF\u6E05\u7B97 (\u6DE8\u5229\u6F64>0): ".concat(profitableLiquidations.length, " \u500B, \u501F\u6B3E ").concat(fmt$(totalProfitBorrow), ", \u6DE8\u5229\u6F64 ").concat(fmt$(totalProfitEstimate)));
                    if (unprofitableUnderwater.length > 0) {
                        totalUnprofitable = unprofitableUnderwater.reduce(function (s, t) { return s + t.borrowUsd; }, 0);
                        console.log("  \u26A0\uFE0F  \u6C34\u4E0B\u7121\u5229\u6F64: ".concat(unprofitableUnderwater.length, " \u500B, \u501F\u6B3E ").concat(fmt$(totalUnprofitable)));
                    }
                    console.log("  \uD83D\uDFE1 \u9AD8\u98A8\u96AA (HF 1~1.05): ".concat(atRisk.length, " \u500B, \u501F\u6B3E ").concat(fmt$(totalAtRiskBorrow)));
                    console.log("  \uD83D\uDFE2 \u5B89\u5168: ".concat(safe.length, " \u500B"));
                    return [2 /*return*/];
            }
        });
    });
}
main().catch(function (e) {
    console.error("掃描失敗:", e);
    process.exit(1);
});
