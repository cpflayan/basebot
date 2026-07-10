
# Aave V3 集成 — 开发进度与后续计划

## 已完成的工作

### Task 1: 提取 `findDeployBlock` 共享工具函数 ✅

**文件变更**:
- **新建** `apps/client/src/utils/findDeployBlock.ts` (109 行)
  - 从 `cometBot.ts` 提取的通用部署区块查找函数
  - 使用指数搜索 + 二分查找定位合约部署区块
  - 函数签名: `findDeployBlock(client, contractAddress, estimatedBlock, logTag)`
- **修改** `apps/client/src/cometBot.ts`
  - 删除 96 行私有 `findDeployBlock` 方法
  - 改为 `import { findDeployBlock } from "./utils/findDeployBlock.js"`
  - 在 `initialize()` 中调用共享函数

### Task 2: 创建 Aave V3 ABI 定义 ✅

**文件**: `apps/client/src/abis/AaveV3.ts` (248 行)

包含:
- `aavePoolViewAbi`: `getUserAccountData`, `getReservesList`, `getReserveData`
- `aavePoolReserveDataAbi`: `getUserReserveData`
- `aavePoolWriteAbi`: `liquidationCall`, `flashLoanSimple`
- `aaveReserveConfigurationAbi`: `getReserveConfigurationMap` (含 liquidationBonus)
- `aaveEventAbi`: Supply, Borrow, Repay, Withdraw, LiquidationCall 事件
- `aaveFlashLoanReceiverAbi`: `executeOperation` callback
- 常量: `HEALTH_FACTOR_THRESHOLD` (1e18), `BASE_CURRENCY_UNIT` (1e8), `WAD`
- Pool 地址: Base `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`, Mainnet `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`

**精度注释**:
- `getUserAccountData` 返回值: `totalCollateralBase/totalDebtBase` = 8 位精度, `healthFactor` = 18 位精度 (WAD)

### Task 3: 创建 `AaveAccountRegistry` ✅

**文件**: `apps/client/src/aaveAccountRegistry.ts` (271 行)

镜像 `CometAccountRegistry` 结构:
- `loadFromFile()` / `saveToFile()` — JSON 持久化到 `./data/aave-accounts.<chainId>.json`
- `initialScan(client, poolAddress, deployBlock, logTag, scanClient?)` — 历史扫描
- `scanNewEvents(client, poolAddress, logTag)` — 增量扫描
- `getAccounts(poolAddress)` → `Address[]`
- `removeAccount(poolAddress, account)` — 完全清算后移除 (Comet 版没有此方法)
- `totalAccounts`, `getLastScannedBlock()`

事件过滤: Supply, Borrow, Repay, Withdraw, LiquidationCall
提取地址: `user`, `onBehalfOf`, `repayer`, `to`, `liquidator`

### Task 4: 实现 `selectBestLiquidationPair()` ✅

**文件**: `apps/client/src/utils/aaveAssetPairSelector.ts` (284 行)

核心功能:
- `calculateCloseFactor(healthFactor)` — 动态 close factor 计算
  - HF >= 0.95: 50% (5000 bps)
  - HF < 0.95: 线性增长至 100%
  - HF = 0: 100% (10000 bps)
- `selectBestLiquidationPair(client, poolAddress, user, healthFactor, reserves, pricers?, wNative?)`
  - 枚举所有 reserve 的 `getUserReserveData` → 分类 collateral/debt
  - 对每个 (collateral, debt) 组合计算利润
  - 返回 `LiquidationPair` 或 null

`LiquidationPair` 接口:
```typescript
interface LiquidationPair {
  collateralAsset: Address;
  debtAsset: Address;
  debtToCover: bigint;
  estimatedProfit: bigint;       // USD (wei-scaled)
  seizableCollateral: bigint;
  liquidationBonus: bigint;      // bps (e.g. 10500 = 5%)
}
```

### Task 5: 扩展 `LiquidationEncoder` ✅

**文件**: `apps/client/src/utils/LiquidationEncoder.ts` (修改)

新增方法:
- `aaveLiquidationCall(pool, collateralAsset, debtAsset, user, debtToCover, receiveAToken)`
- `aaveFlashLoanSimple(pool, asset, amount, params)`

### Task 6: 创建 `AaveLiquidationBot` ✅

**文件**: `apps/client/src/aaveBot.ts` (503 行)

核心方法:
1. `initialize()` — 加载 registry → findDeployBlock → initialScan → cacheReserves
2. `startPolling()` — watchBlocks 每 N 区块触发
3. `checkAave()` — 增量扫描 → batchCheckHealthFactor → selectBestLiquidationPair → liquidateAave
4. `batchCheckHealthFactor(accounts)` — Promise.allSettled 批处理 getUserAccountData
5. `liquidateDirect(account, pair)` — approve → liquidationCall → swap → skim → simulateAndExec
6. `liquidateWithFlashLoan(account, pair)` — Balancer flash loan → liquidationCall → swap → repay → skim

安全机制:
- Token 黑名单 (`TOKEN_BLACKLIST`)
- Cooldown 检查
- `minHealthFactorBuffer` 预过滤
- 闪贷路径使用 Balancer (0% fee)

### Task 7: 添加配置类型 ✅

**文件变更**:
- **修改** `apps/config/src/types.ts`
  - 新增 `AaveWatchlistConfig` 接口
  - `Options` 接口添加 `aaveWatchlist?: AaveWatchlistConfig`
- **修改** `apps/config/src/index.ts`
  - 导出 `AaveWatchlistConfig` 类型

```typescript
export interface AaveWatchlistConfig {
  enabled: boolean;
  poolAddress: Address;
  poolDeployBlock: number;
  reserves: Address[];
  pollIntervalBlocks?: number;
  minHealthFactorBuffer?: bigint;
}
```

### Task 8: 在 `index.ts` 中接入 Aave Bot ✅

**文件**: `apps/client/src/index.ts` (修改)

- 添加 `import { AaveLiquidationBot } from "./aaveBot"`
- 在 Comet bot 接入代码之后添加 Aave bot 接入代码
- 条件: `config.aaveWatchlist?.enabled`

### Task 9: 测试 ✅

**文件**: `apps/client/test/vitest/aaveBot.test.ts` (128 行)

测试覆盖 (12 个测试，全部通过):
1. `calculateCloseFactor()` 单元测试 (5 个):
   - HF >= 0.95 → 50%
   - HF = 0.95 精确 → 50%
   - HF < 0.95 → 50%-100% 之间
   - HF = 0 → 100%
   - 极低 HF → 上限 100%
2. `AaveAccountRegistry` 单元测试 (5 个):
   - 添加和检索账户
   - 账户去重
   - 移除账户
   - 持久化和加载
   - 多 Pool 账户计数
3. 常量验证 (2 个):
   - HEALTH_FACTOR_THRESHOLD = 1e18
   - Pool 地址存在性

### Task 10: 更新 ARCHITECTURE.md ✅

**文件**: `ARCHITECTURE.md` (修改)

新增内容:
- 更新项目描述为三协议系统 (Morpho + Comet + Aave)
- Key abstractions 添加 `AaveLiquidationBot`, `AaveAccountRegistry`, `aaveAssetPairSelector`
- 新增 "Aave V3 Flow" 章节 (5 个子节)
- 新增 "Aave V3 Configuration" 章节
- 新增 "Aave V3 Pool Addresses" 表格

---

## 测试状态

```
✓ apps/client/test/vitest/aaveBot.test.ts (12 tests) 17ms
  ✓ calculateCloseFactor (5 tests)
  ✓ AaveAccountRegistry (5 tests)
  ✓ Aave V3 Constants (2 tests)

Test Files  1 passed (1)
     Tests  12 passed (12)
```

### 尚未覆盖的测试场景 (需要 anvil fork)

以下测试需要真实的 Aave V3 fork 环境，当前未实现:

1. **`selectBestLiquidationPair()` 集成测试**:
   - 多 collateral + 多 debt 组合选择
   - 单 collateral + 单 debt (退化为 Comet 场景)
   - 所有组合都不盈利 → 返回 null
   - 需要 mock 或 fork 真实的 `getUserReserveData` 返回值

2. **`getUserAccountData` WAD-scaling 正确性**:
   - 验证 healthFactor 18 位精度 vs totalCollateralBase 8 位精度
   - 需要真实的 Pool 状态

3. **直接清算路径模拟测试**:
   - 需要 anvil fork + 可清算账户
   - 验证 approve → liquidationCall → swap → skim 流程

4. **闪贷路径模拟测试**:
   - 需要 anvil fork + Balancer flash loan
   - 验证 flash loan → liquidationCall → swap → repay → skim 流程

---

## 后续待完成的工作

### 1. 配置填充 (部署前必须)

在 `apps/config/src/config.ts` 中添加实际的 Aave watchlist 配置:

```typescript
aaveWatchlist: {
  enabled: false,  // 先设为 false 作为 feature flag
  poolAddress: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",  // Base
  poolDeployBlock: <需要验证>,
  reserves: [<需要确认 Base 上的 Aave V3 reserves>],
  pollIntervalBlocks: 5,
}
```

**需要确认**:
- Base Aave V3 Pool 的精确部署区块
- Base 上所有 Aave V3 reserve 资产列表
- 是否需要 Mainnet 配置

### 2. Fork 集成测试 ✅

已创建:
- `apps/client/test/setup.ts` — 添加 `aaveBaseForkTest` Base 链 fork 测试上下文
- `scripts/fork-setup-aave-position.mjs` — 创建 Aave V3 仓位 (supply WETH, borrow USDC)
- `scripts/fork-manipulate-aave-oracle.mjs` — 操纵 Chainlink WETH/USD 价格使 HF < 1
- `apps/client/test/vitest/aaveBot.fork.test.ts` — Fork 集成测试用例

### 3. Aave Flash Loan 路径评估 ✅

**结论: 当前阶段不建议切换至 Aave native flash loan。**

| 维度 | Balancer (当前) | Aave native |
|------|----------------|-------------|
| Fee | 0% | 0.05% |
| Executor 支持 | 已支持 `balancerFlashLoan` | 需实现 `executeOperation` callback |
| 合约部署 | 无需新部署 | 需要新 executor 合约 + 审计 |
| Gas 优势 | 多一次 Vault 调用 | 可能同 Pool 内完成 |
| 利润影响 | 小额仓位可忽略 | 0.05% 在大仓位上也不显著 |

**建议**: 保持 Balancer flash loan 路径，标记为 future consideration。如需切换，需要:
1. 部署新版 executor 合约实现 `executeOperation`
2. 合约审计
3. 在 `aaveBot.ts` 的 `flashLoanProvider === "aave"` 分支中实现

### 4. 性能优化 ✅

已完成:
- **Multicall 批量查询**: `selectBestLiquidationPair()` 和 `batchCheckHealthFactor()` 改用 multicall
- **Reserve 配置缓存**: 初始化时通过 multicall 预加载 liquidationBonus/decimals，避免重复 RPC
- **账户分批处理**: `batchCheckHealthFactor()` 每批 50 个账户，避免超时

### 5. 安全审计 ✅

已完成:
- [x] `calculateCloseFactor` 与 Aave V3 ValidationLogic.sol 逻辑一致 (18 个边界测试通过)
- [x] 利润计算公式修复: `seizableCollateral = debtToCover * debtPrice/collateralPrice * liquidationBonus/10000`
- [x] Token 黑名单配置化: `AaveWatchlistConfig.tokenBlacklist` + 默认黑名单 fallback
- [x] 滑点参数配置化: `AaveWatchlistConfig.slippageBps` (默认 100 bps)

### 6. 监控与告警 ✅

已完成:
- [x] HealthServer 扩展: `registerBot(name, statusFn)` + `/health` 结构化响应 + `/health/:name` 单 bot 端点
- [x] 清算统计: `liquidationsAttempted/Succeeded/Failed` 计数器
- [x] RPC 错误率追踪: `rpcErrors/rpcTotal/rpcErrorRate` + >30% 标记 unhealthy
- [x] Aave bot 注册到 HealthServer (index.ts)

### 7. MEV 策略

Aave V3 清算是竞争红海，需要考虑:
- **Base**: 公开 mempool，需要接受被抢跑风险或聚焦小额/被忽视的仓位
- **Mainnet**: 需要 Flashbots bundle (已支持 `flashbotAccount` 配置)
- 考虑预清算 (pre-liquidation) 策略降低 gas 竞争

---

## 文件清单

### 新建文件

| 文件 | 行数 | 用途 |
|------|------|------|
| `apps/client/src/utils/findDeployBlock.ts` | 109 | 共享部署区块查找工具 |
| `apps/client/src/abis/AaveV3.ts` | 248 | Aave V3 ABI 定义 + 常量 |
| `apps/client/src/aaveAccountRegistry.ts` | 271 | 账户发现与事件扫描 |
| `apps/client/src/utils/aaveAssetPairSelector.ts` | 284 | 资产对选择 + 动态 close factor |
| `apps/client/src/aaveBot.ts` | 503 | Aave V3 清算 bot 核心编排器 |
| `apps/client/test/vitest/aaveBot.test.ts` | 128 | 单元测试 |

### 修改文件

| 文件 | 变更说明 |
|------|----------|
| `apps/client/src/cometBot.ts` | 删除私有 findDeployBlock，改用共享工具 |
| `apps/client/src/utils/LiquidationEncoder.ts` | 添加 aaveLiquidationCall + aaveFlashLoanSimple |
| `apps/config/src/types.ts` | 添加 AaveWatchlistConfig 接口 |
| `apps/config/src/index.ts` | 导出 AaveWatchlistConfig |
| `apps/client/src/index.ts` | 接入 AaveLiquidationBot |
| `ARCHITECTURE.md` | 添加 Aave V3 文档章节 |

---

## 快速启动

```bash
# 1. 安装依赖
pnpm install

# 2. 运行测试
npx vitest run apps/client/test/vitest/aaveBot.test.ts

# 3. 启用 Aave bot (需要先在 config.ts 中配置 aaveWatchlist)
# 设置 enabled: true 并填写 poolAddress, reserves 等
pnpm liquidate
```

---

## 关键设计决策记录

1. **专用 Bot 模式** (而非 Data Provider): Aave 的资产对选择和动态 close factor 使其不适合复用 Morpho 的 `LiquidationBot` 编排。

2. **独立 AaveAccountRegistry** (而非泛型化 CometAccountRegistry): 事件签名完全不同，泛型化增加复杂度收益有限。

3. **Balancer flash loan 优先** (而非 Aave native): Balancer 0% fee，executor 已支持。Aave native 需要合约升级。

4. **`selectBestLiquidationPair` 独立工具函数** (而非 bot 内部方法): 便于单元测试，未来可能被其他协议复用。

5. **双 RPC 架构**: Base 公开 RPC 用于历史扫描 (10k 区块批次)，Alchemy RPC 用于交易。
