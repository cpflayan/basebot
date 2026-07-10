# Aave V3 清算 Bot 集成实现计划

## 架构决策

**选择专用 Bot 模式（同 Comet）**，而非 Data Provider 模式，原因：
- Aave 需要额外的 `selectBestLiquidationPair()` 资产对选择步骤，Morpho 的 `LiquidationBot` 编排不兼容
- 动态 close factor 需要协议特定的计算逻辑
- `getUserAccountData` 返回 WAD-scaled healthFactor，非 boolean，需要不同的批处理策略

**MEV 考量**：Aave V3 是竞争红海，mainnet 部署需 Flashbots（已支持），Base 部署需接受公开 mempool 风险或聚焦小额/被忽视的仓位。

---

## Task 1: 提取 `findDeployBlock` 为共享工具函数

**目标**：将 `cometBot.ts` L195-285 的 `findDeployBlock` 提取为独立工具，避免在 Aave bot 中重复。

**文件变更**：
- **新建** `apps/client/src/utils/findDeployBlock.ts` — 导出通用 `findDeployBlock(client, contractAddress, estimatedBlock, logTag)` 函数
- **修改** `apps/client/src/cometBot.ts` — 删除私有 `findDeployBlock` 方法，改为 `import { findDeployBlock } from "./utils/findDeployBlock.js"`，在 `initialize()` 中调用共享函数

**关键实现细节**：
- 函数签名：`async function findDeployBlock(client: Client, contractAddress: Address, estimatedBlock: number, logTag: string): Promise<number | undefined>`
- 使用 `getCode` + 指数搜索 + 二分查找（保持现有逻辑不变）
- 错误处理：失败时返回 `undefined`，回退到配置的估计值

**验证**：确保 Comet bot 的 `initialize()` 仍然正常工作（回归测试）

---

## Task 2: 创建 Aave V3 ABI 定义

**目标**：定义 Aave V3 Pool 和辅助合约的 ABI 片段。

**文件**：
- **新建** `apps/client/src/abis/AaveV3.ts`

**需要的 ABI 片段**：

```typescript
// Pool view 函数
getUserAccountData(user) → (totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor)
getReservesList() → address[]
getReserveData(asset) → (configuration, liquidityIndex, ...)
getUserReserveData(asset, user) → (currentATokenBalance, currentStableDebt, currentVariableDebt, ...)  // 注意：Aave V3.1+ 可能用 getUserAccountData 替代

// Pool 写入函数  
liquidationCall(collateralAsset, debtAsset, user, debtToCover, receiveAToken)
flashLoanSimple(receiverAddress, asset, amount, params, referralCode)

// 事件 ABI（账户发现）
Supply(reserve, user, onBehalfOf, amount, referralCode)
Borrow(reserve, user, onBehalfOf, amount, interestRateMode, stableRate, referralCode)
Repay(reserve, user, repayer, amount, useATokens)
Withdraw(reserve, user, to, amount)
LiquidationCall(collateralAsset, debtAsset, user, debtToCover, liquidatedCollateralAmount, liquidator, receiveAToken)
RebalanceStableBorrowRate(reserve, user)
```

**常量**：
- Aave V3 Pool 地址（Base: `0xA238Dd80C259a72e81d7e4664a980158059fFAfa` — 需验证）
- `HEALTH_FACTOR_THRESHOLD = 10n ** 18n` (WAD-scaled 1.0)
- `BASE_CURRENCY_UNIT = 10n ** 8n` (Aave 使用 8 位精度作为 base currency 聚合值)

**注意**：`getUserAccountData` 返回的 `totalCollateralBase` 和 `totalDebtBase` 使用 8 位精度（base currency units），而 `healthFactor` 使用 18 位精度（WAD）。这是一个常见的 bug 来源。

---

## Task 3: 创建 `AaveAccountRegistry`

**目标**：遵循 `CometAccountRegistry` 模式，扫描 Aave V3 Pool 事件构建账户列表。

**文件**：
- **新建** `apps/client/src/aaveAccountRegistry.ts`

**设计**（直接复用 CometAccountRegistry 结构）：
- `loadFromFile()` / `saveToFile()` — JSON 持久化到 `./data/aave-accounts.<chainId>.json`
- `initialScan(client, poolAddress, deployBlock, logTag, scanClient?)` — 历史扫描，使用 `SCAN_BATCH_SIZE = 10_000`
- `scanNewEvents(client, poolAddress, logTag)` — 增量扫描
- `scanRange(client, poolAddress, fromBlock, toBlock, logTag)` — 单批次扫描
- `getAccounts()` → `Address[]`
- `totalAccounts` → `number`
- `getLastScannedBlock()` → `number | undefined`

**事件过滤**（替代 Comet 的 SupplyCollateral/WithdrawCollateral/AbsorbDebt）：
- `Supply` — 添加 `onBehalfOf`（如果与 `user` 不同也添加 `user`）
- `Borrow` — 添加 `onBehalfOf`
- `Repay` — 添加 `user`
- `Withdraw` — 添加 `user`
- `LiquidationCall` — 可选：移除已完全清算的账户（需要检查账户是否仍有余额）

**与 Comet 的关键区别**：
- Aave 只有一个 Pool 地址（不是多个 Comet），所以 registry 的 key 简化为 pool address
- 事件名称和参数结构不同，需要独立的 `aaveEventAbi`

---

## Task 4: 实现 `selectBestLiquidationPair()` — Aave 特有的资产对选择逻辑

**目标**：对于可清算账户，枚举所有 (collateralAsset, debtAsset) 组合，选择利润最高的配对。

**文件**：
- **新建** `apps/client/src/utils/aaveAssetPairSelector.ts`

**函数签名**：
```typescript
interface LiquidationPair {
  collateralAsset: Address;
  debtAsset: Address;
  debtToCover: bigint;
  estimatedProfit: bigint;  // in base currency units
  seizableCollateral: bigint;
}

async function selectBestLiquidationPair(
  client: Client,
  poolAddress: Address,
  user: Address,
  reserves: Address[],
  pricers: Pricer[],
  wNative: Address,
): Promise<LiquidationPair | null>
```

**逻辑**：
1. 对每个 reserve，调用 `Pool.getUserReserveData(asset, user)` 获取：
   - `currentATokenBalance` → 如果 > 0，该资产是 collateral
   - `currentVariableDebt` + `currentStableDebt` → 如果 > 0，该资产是 debt
2. 构建 `collateralAssets[]` 和 `debtAssets[]` 列表
3. 对每个 (collateral, debt) 组合：
   - 计算 `debtToCover` = min(debtBalance, closeFactor * debtBalance)（动态 close factor）
   - 估算可获得的 collateral（含 liquidation bonus）
   - 用 pricer 估算 USD 利润 = seizableCollateralValue - debtToCoverValue - gasEstimate
4. 返回利润最高的组合，如果所有组合都不盈利则返回 `null`

**动态 Close Factor 计算**：
- Aave V3.1+ 使用动态 close factor：当 HF 很低时，close factor 可达 100%
- 需要读取协议当前逻辑，不硬编码 50%
- 建议实现：从 Pool 合约读取 `MAX_LIQUIDATION_CLOSE_FACTOR` 和 `CLOSE_FACTOR_HF_THRESHOLD`，根据 HF 动态计算

---

## Task 5: 扩展 `LiquidationEncoder` 添加 Aave 方法

**目标**：在现有 encoder 中添加 Aave V3 的编码方法。

**文件**：
- **修改** `apps/client/src/utils/LiquidationEncoder.ts`

**新增方法**：
```typescript
// Aave V3 Pool.liquidationCall
public aaveLiquidationCall(
  pool: Address,
  collateralAsset: Address,
  debtAsset: Address,
  user: Address,
  debtToCover: bigint,
  receiveAToken: boolean,
)

// Aave V3 Pool.flashLoanSimple
public aaveFlashLoanSimple(
  pool: Address,
  receiverAddress: Address,
  asset: Address,
  amount: bigint,
  params: Hex,
)
```

---

## Task 6: 创建 `AaveLiquidationBot`

**目标**：Aave V3 协议编排器，遵循 `CometLiquidationBot` 结构。

**文件**：
- **新建** `apps/client/src/aaveBot.ts`

**类结构**（镜像 `CometLiquidationBot`）：

```typescript
export interface AaveLiquidationBotInputs {
  logTag: string;
  client: WalletClient<Transport, Chain, Account>;
  aaveWatchlist: AaveWatchlistConfig;
  executorAddress: Address;
  treasuryAddress: Address;
  liquidityVenues: LiquidityVenue[];
  pricers?: Pricer[];
  wNative: Address;
  chainId: number;
  positionLiquidationCooldownMechanism?: PositionLiquidationCooldownMechanism;
  flashbotAccount?: LocalAccount;
  useFlashLoan?: boolean;
  alwaysRealizeBadDebt?: boolean;
  registryFilePath?: string;
}

export class AaveLiquidationBot {
  // 与 Comet 相同的字段结构
  private registry: AaveAccountRegistry;
  private cachedReserves: Address[] = [];  // Aave 特有：缓存 reserves 列表
  // ...
}
```

**核心方法**：

1. `initialize()`:
   - 加载 registry
   - `findDeployBlock` (共享工具)
   - `initialScan`
   - 缓存 `getReservesList()`

2. `startPolling()`:
   - `watchBlocks` 每 N 个区块触发
   - 与 Comet 相同的防重叠机制

3. `checkAave()` — 核心检查循环（**Aave 特有逻辑**）:
   - 增量事件扫描
   - **批处理 `getUserAccountData`**：`Promise.allSettled` 对所有注册账户
   - 过滤 `healthFactor < HEALTH_FACTOR_THRESHOLD`（WAD-scaled 1e18）
   - 可选：使用 `minHealthFactorBuffer` 跳过 HF 接近 1 的账户（节省 RPC）
   - 对每个可清算账户调用 `selectBestLiquidationPair()`
   - 执行清算

4. `liquidateAave(account, pair)`:
   - Token 黑名单检查
   - Cooldown 检查
   - 路由到 `liquidateWithFlashLoan()` 或 `liquidateDirect()`

5. `liquidateDirect(account, pair)`:
   - ERC20 approve debt asset → Pool
   - `Pool.liquidationCall(collateralAsset, debtAsset, user, debtToCover, false)`
   - DEX swap seized collateral → debt asset（使用 `convertCollateralToLoan`）
   - `erc20Skim` profit to treasury
   - `simulateAndExec` 执行

6. `liquidateWithFlashLoan(account, pair)`:
   - **Aave flash loan 路径**：`Pool.flashLoanSimple` → callback 内执行 `liquidationCall` → DEX swap → repay → skim
   - 注意：Aave flash loan 的 callback 接口不同于 Balancer
   - 需要 executor 合约支持 `flashLoanSimple` 的 callback（`executeOperation`）
   - 使用 `simulateAndExecFlashLoan` 或 Aave 专用的模拟执行路径

**性能优化**：
- `cachedReserves` 避免重复调用 `getReservesList()`
- `minHealthFactorBuffer` 预过滤，减少 `getUserAccountData` 的后续处理
- 批处理 `getUserAccountData` 使用 `Promise.allSettled`（同 Comet 的 `batchCheckLiquidatable` 模式）

---

## Task 7: 添加配置类型和链配置

**文件变更**：

**修改** `apps/config/src/types.ts`：
```typescript
export interface AaveWatchlistConfig {
  enabled: boolean;
  poolAddress: Address;
  poolDeployBlock: number;
  reserves: Address[];
  pollIntervalBlocks?: number;
  minHealthFactorBuffer?: bigint;  // 安全边际，避免浪费 RPC 在健康账户上
}

// 在 Options 接口中添加：
aaveWatchlist?: AaveWatchlistConfig;
```

**修改** `apps/config/src/index.ts`：
- 导出 `AaveWatchlistConfig` 类型

**修改** `apps/config/src/config.ts`：
- 在 Base 链配置中添加 `aaveWatchlist`（初始可设为 `enabled: false` 作为 feature flag）

---

## Task 8: 在 `index.ts` 中接入 Aave Bot

**文件**：
- **修改** `apps/client/src/index.ts`

**变更**（遵循 Comet bot 的接入模式，L139-166）：
```typescript
// ─── Aave V3 Bot (parallel to Morpho + Comet) ───
if (config.aaveWatchlist?.enabled) {
  try {
    const aaveBot = new AaveLiquidationBot({
      logTag: `[${config.chain.name} aave]: `,
      client,
      aaveWatchlist: config.aaveWatchlist,
      executorAddress: config.executorAddress,
      treasuryAddress,
      liquidityVenues,
      pricers,
      wNative: config.wNative,
      chainId: config.chainId,
      positionLiquidationCooldownMechanism,
      flashbotAccount,
      useFlashLoan: config.useFlashLoan,
      alwaysRealizeBadDebt: ALWAYS_REALIZE_BAD_DEBT,
    });
    await aaveBot.initialize();
    aaveBot.startPolling();
    console.log(`${logTag}✅ Aave V3 liquidation bot started`);
  } catch (e) {
    console.error(`${logTag}Failed to start Aave bot:`, e);
  }
}
```

---

## Task 9: 测试

**文件**：
- **新建** `apps/client/test/vitest/aaveBot.test.ts`

**测试覆盖**：
1. `selectBestLiquidationPair()` 单元测试：
   - 多 collateral + 多 debt 组合
   - 单 collateral + 单 debt（退化为 Comet 场景）
   - 所有组合都不盈利 → 返回 null
2. 动态 close factor 计算：
   - HF 在不同区间的 close factor 值
   - 边界条件（HF = 0, HF = 0.95, HF = 0.99）
3. `getUserAccountData` WAD-scaling 正确性：
   - healthFactor 是 18 位精度
   - totalCollateralBase/totalDebtBase 是 8 位精度
4. `AaveAccountRegistry` 事件扫描和持久化
5. 直接清算路径和闪贷路径的模拟测试

---

## Task 10: 更新 ARCHITECTURE.md

**文件**：
- **修改** `ARCHITECTURE.md`

**添加**：
- Aave V3 Flow 章节（同 Compound V3 Flow 章节的结构）
- 更新 Key abstractions 列表
- 更新架构图中的组件关系

---

## 依赖关系

```
Task 1 (findDeployBlock 提取) — 无依赖，最先做
Task 2 (Aave ABI) — 无依赖，可与 Task 1 并行
Task 3 (AaveAccountRegistry) — 依赖 Task 2
Task 4 (selectBestLiquidationPair) — 依赖 Task 2，可与 Task 3 并行
Task 5 (LiquidationEncoder 扩展) — 依赖 Task 2
Task 6 (AaveLiquidationBot) — 依赖 Task 1, 3, 4, 5
Task 7 (配置) — 无依赖，可早期做
Task 8 (index.ts 接入) — 依赖 Task 6, 7
Task 9 (测试) — 依赖 Task 4, 6
Task 10 (文档) — 最后做
```

## 建议构建顺序

1. **Task 1** + **Task 2** + **Task 7**（并行，无依赖）
2. **Task 3** + **Task 4** + **Task 5**（并行，依赖 Task 2）
3. **Task 6**（核心 bot，依赖上述所有）
4. **Task 8**（接入）
5. **Task 9**（测试）
6. **Task 10**（文档）

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| Aave `getUserAccountData` 的 8 位 vs 18 位精度混淆 | 在 Task 9 中添加专门的单位测试；代码中添加常量注释 |
| 动态 close factor 逻辑与协议实际行为不一致 | 实现前验证 Aave V3 最新源码中的 close factor 公式；不硬编码 |
| Aave flash loan callback 接口 (`executeOperation`) 与 Balancer 不同，executor 合约可能不支持 | 先验证 executor 合约是否支持 Aave flash loan callback；如不支持，先用 Balancer flash loan 路径 |
| Aave V3 竞争激烈，高价值清算被 MEV bot 抢先 | 遵循用户计划中的建议：先作为工程验证，不作为近期收入预期 |
| `findDeployBlock` 提取后 Comet bot 回归 | Task 1 完成后立即验证 Comet bot 初始化仍正常 |
| Aave Pool 事件量大，registry 扫描耗时 | 使用 Base 公开 RPC 的 10k 批次限制，与 Comet 相同策略 |

---
<<<<<<< Updated upstream
<<<<<<< Updated upstream
<<<<<<< Updated upstream
ㄇ
## 被拒绝的替代方案

1. **Data Provider 模式**：Aave 的资产对选择步骤和动态 close factor 使其不适合复用 `LiquidationBot` 的编排流程。Morpho 的 `LiquidationBot` 假设一个 collateral → 一个 debt token 的模型，Aave 的多资产模型不兼容。

2. **复用 CometAccountRegistry 类（泛型化）**：虽然结构相似，但 Aave 事件签名和参数完全不同（Supply/Borrow vs SupplyCollateral/WithdrawCollateral），泛型化会增加复杂度且收益有限。选择独立类 + 相同模式。

3. **将 `selectBestLiquidationPair` 放在 bot 类内部**：分离为独立工具函数便于单元测试，且未来可能被其他协议复用。

4. **Aave flash loan 替代 Balancer flash loan**：Aave 自身提供 `flashLoanSimple`（0.05-0.09% fee），但 executor 合约需要支持 `executeOperation` callback。建议先用 Balancer（0% fee，executor 已支持），后续再评估 Aave native flash loan。

---

## 关键文件清单

1. `apps/client/src/cometBot.ts` — 参考模板，`findDeployBlock` 从此提取
2. `apps/client/src/cometAccountRegistry.ts` — 参考模板，AaveAccountRegistry 照此结构
3. `apps/client/src/utils/sharedExecution.ts` — 共享执行管道，Aave bot 复用
4. `apps/client/src/utils/LiquidationEncoder.ts` — 需扩展 Aave 编码方法
5. `apps/config/src/types.ts` — 需添加 `AaveWatchlistConfig` 类型

# Aave V3 清算 Bot 集成实现计划

## 架构决策

**选择专用 Bot 模式（同 Comet）**，而非 Data Provider 模式，原因：
- Aave 需要额外的 `selectBestLiquidationPair()` 资产对选择步骤，Morpho 的 `LiquidationBot` 编排不兼容
- 动态 close factor 需要协议特定的计算逻辑
- `getUserAccountData` 返回 WAD-scaled healthFactor，非 boolean，需要不同的批处理策略

**MEV 考量**：Aave V3 是竞争红海，mainnet 部署需 Flashbots（已支持），Base 部署需接受公开 mempool 风险或聚焦小额/被忽视的仓位。

---

## Task 1: 提取 `findDeployBlock` 为共享工具函数

**目标**：将 `cometBot.ts` L195-285 的 `findDeployBlock` 提取为独立工具，避免在 Aave bot 中重复。

**文件变更**：
- **新建** `apps/client/src/utils/findDeployBlock.ts` — 导出通用 `findDeployBlock(client, contractAddress, estimatedBlock, logTag)` 函数
- **修改** `apps/client/src/cometBot.ts` — 删除私有 `findDeployBlock` 方法，改为 `import { findDeployBlock } from "./utils/findDeployBlock.js"`，在 `initialize()` 中调用共享函数

**关键实现细节**：
- 函数签名：`async function findDeployBlock(client: Client, contractAddress: Address, estimatedBlock: number, logTag: string): Promise<number | undefined>`
- 使用 `getCode` + 指数搜索 + 二分查找（保持现有逻辑不变）
- 错误处理：失败时返回 `undefined`，回退到配置的估计值

**验证**：确保 Comet bot 的 `initialize()` 仍然正常工作（回归测试）

---

## Task 2: 创建 Aave V3 ABI 定义

**目标**：定义 Aave V3 Pool 和辅助合约的 ABI 片段。

**文件**：
- **新建** `apps/client/src/abis/AaveV3.ts`

**需要的 ABI 片段**：

```typescript
// Pool view 函数
getUserAccountData(user) → (totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor)
getReservesList() → address[]
getReserveData(asset) → (configuration, liquidityIndex, ...)
getUserReserveData(asset, user) → (currentATokenBalance, currentStableDebt, currentVariableDebt, ...)  // 注意：Aave V3.1+ 可能用 getUserAccountData 替代

// Pool 写入函数  
liquidationCall(collateralAsset, debtAsset, user, debtToCover, receiveAToken)
flashLoanSimple(receiverAddress, asset, amount, params, referralCode)

// 事件 ABI（账户发现）
Supply(reserve, user, onBehalfOf, amount, referralCode)
Borrow(reserve, user, onBehalfOf, amount, interestRateMode, stableRate, referralCode)
Repay(reserve, user, repayer, amount, useATokens)
Withdraw(reserve, user, to, amount)
LiquidationCall(collateralAsset, debtAsset, user, debtToCover, liquidatedCollateralAmount, liquidator, receiveAToken)
RebalanceStableBorrowRate(reserve, user)
```

**常量**：
- Aave V3 Pool 地址（Base: `0xA238Dd80C259a72e81d7e4664a980158059fFAfa` — 需验证）
- `HEALTH_FACTOR_THRESHOLD = 10n ** 18n` (WAD-scaled 1.0)
- `BASE_CURRENCY_UNIT = 10n ** 8n` (Aave 使用 8 位精度作为 base currency 聚合值)

**注意**：`getUserAccountData` 返回的 `totalCollateralBase` 和 `totalDebtBase` 使用 8 位精度（base currency units），而 `healthFactor` 使用 18 位精度（WAD）。这是一个常见的 bug 来源。

---

## Task 3: 创建 `AaveAccountRegistry`

**目标**：遵循 `CometAccountRegistry` 模式，扫描 Aave V3 Pool 事件构建账户列表。

**文件**：
- **新建** `apps/client/src/aaveAccountRegistry.ts`

**设计**（直接复用 CometAccountRegistry 结构）：
- `loadFromFile()` / `saveToFile()` — JSON 持久化到 `./data/aave-accounts.<chainId>.json`
- `initialScan(client, poolAddress, deployBlock, logTag, scanClient?)` — 历史扫描，使用 `SCAN_BATCH_SIZE = 10_000`
- `scanNewEvents(client, poolAddress, logTag)` — 增量扫描
- `scanRange(client, poolAddress, fromBlock, toBlock, logTag)` — 单批次扫描
- `getAccounts()` → `Address[]`
- `totalAccounts` → `number`
- `getLastScannedBlock()` → `number | undefined`

**事件过滤**（替代 Comet 的 SupplyCollateral/WithdrawCollateral/AbsorbDebt）：
- `Supply` — 添加 `onBehalfOf`（如果与 `user` 不同也添加 `user`）
- `Borrow` — 添加 `onBehalfOf`
- `Repay` — 添加 `user`
- `Withdraw` — 添加 `user`
- `LiquidationCall` — 可选：移除已完全清算的账户（需要检查账户是否仍有余额）

**与 Comet 的关键区别**：
- Aave 只有一个 Pool 地址（不是多个 Comet），所以 registry 的 key 简化为 pool address
- 事件名称和参数结构不同，需要独立的 `aaveEventAbi`

---

## Task 4: 实现 `selectBestLiquidationPair()` — Aave 特有的资产对选择逻辑

**目标**：对于可清算账户，枚举所有 (collateralAsset, debtAsset) 组合，选择利润最高的配对。

**文件**：
- **新建** `apps/client/src/utils/aaveAssetPairSelector.ts`

**函数签名**：
```typescript
interface LiquidationPair {
  collateralAsset: Address;
  debtAsset: Address;
  debtToCover: bigint;
  estimatedProfit: bigint;  // in base currency units
  seizableCollateral: bigint;
}

async function selectBestLiquidationPair(
  client: Client,
  poolAddress: Address,
  user: Address,
  reserves: Address[],
  pricers: Pricer[],
  wNative: Address,
): Promise<LiquidationPair | null>
```

**逻辑**：
1. 对每个 reserve，调用 `Pool.getUserReserveData(asset, user)` 获取：
   - `currentATokenBalance` → 如果 > 0，该资产是 collateral
   - `currentVariableDebt` + `currentStableDebt` → 如果 > 0，该资产是 debt
2. 构建 `collateralAssets[]` 和 `debtAssets[]` 列表
3. 对每个 (collateral, debt) 组合：
   - 计算 `debtToCover` = min(debtBalance, closeFactor * debtBalance)（动态 close factor）
   - 估算可获得的 collateral（含 liquidation bonus）
   - 用 pricer 估算 USD 利润 = seizableCollateralValue - debtToCoverValue - gasEstimate
4. 返回利润最高的组合，如果所有组合都不盈利则返回 `null`

**动态 Close Factor 计算**：
- Aave V3.1+ 使用动态 close factor：当 HF 很低时，close factor 可达 100%
- 需要读取协议当前逻辑，不硬编码 50%
- 建议实现：从 Pool 合约读取 `MAX_LIQUIDATION_CLOSE_FACTOR` 和 `CLOSE_FACTOR_HF_THRESHOLD`，根据 HF 动态计算

---

## Task 5: 扩展 `LiquidationEncoder` 添加 Aave 方法

**目标**：在现有 encoder 中添加 Aave V3 的编码方法。

**文件**：
- **修改** `apps/client/src/utils/LiquidationEncoder.ts`

**新增方法**：
```typescript
// Aave V3 Pool.liquidationCall
public aaveLiquidationCall(
  pool: Address,
  collateralAsset: Address,
  debtAsset: Address,
  user: Address,
  debtToCover: bigint,
  receiveAToken: boolean,
)

// Aave V3 Pool.flashLoanSimple
public aaveFlashLoanSimple(
  pool: Address,
  receiverAddress: Address,
  asset: Address,
  amount: bigint,
  params: Hex,
)
```

---

## Task 6: 创建 `AaveLiquidationBot`

**目标**：Aave V3 协议编排器，遵循 `CometLiquidationBot` 结构。

**文件**：
- **新建** `apps/client/src/aaveBot.ts`

**类结构**（镜像 `CometLiquidationBot`）：

```typescript
export interface AaveLiquidationBotInputs {
  logTag: string;
  client: WalletClient<Transport, Chain, Account>;
  aaveWatchlist: AaveWatchlistConfig;
  executorAddress: Address;
  treasuryAddress: Address;
  liquidityVenues: LiquidityVenue[];
  pricers?: Pricer[];
  wNative: Address;
  chainId: number;
  positionLiquidationCooldownMechanism?: PositionLiquidationCooldownMechanism;
  flashbotAccount?: LocalAccount;
  useFlashLoan?: boolean;
  alwaysRealizeBadDebt?: boolean;
  registryFilePath?: string;
}

export class AaveLiquidationBot {
  // 与 Comet 相同的字段结构
  private registry: AaveAccountRegistry;
  private cachedReserves: Address[] = [];  // Aave 特有：缓存 reserves 列表
  // ...
}
```

**核心方法**：

1. `initialize()`:
   - 加载 registry
   - `findDeployBlock` (共享工具)
   - `initialScan`
   - 缓存 `getReservesList()`

2. `startPolling()`:
   - `watchBlocks` 每 N 个区块触发
   - 与 Comet 相同的防重叠机制

3. `checkAave()` — 核心检查循环（**Aave 特有逻辑**）:
   - 增量事件扫描
   - **批处理 `getUserAccountData`**：`Promise.allSettled` 对所有注册账户
   - 过滤 `healthFactor < HEALTH_FACTOR_THRESHOLD`（WAD-scaled 1e18）
   - 可选：使用 `minHealthFactorBuffer` 跳过 HF 接近 1 的账户（节省 RPC）
   - 对每个可清算账户调用 `selectBestLiquidationPair()`
   - 执行清算

4. `liquidateAave(account, pair)`:
   - Token 黑名单检查
   - Cooldown 检查
   - 路由到 `liquidateWithFlashLoan()` 或 `liquidateDirect()`

5. `liquidateDirect(account, pair)`:
   - ERC20 approve debt asset → Pool
   - `Pool.liquidationCall(collateralAsset, debtAsset, user, debtToCover, false)`
   - DEX swap seized collateral → debt asset（使用 `convertCollateralToLoan`）
   - `erc20Skim` profit to treasury
   - `simulateAndExec` 执行

6. `liquidateWithFlashLoan(account, pair)`:
   - **Aave flash loan 路径**：`Pool.flashLoanSimple` → callback 内执行 `liquidationCall` → DEX swap → repay → skim
   - 注意：Aave flash loan 的 callback 接口不同于 Balancer
   - 需要 executor 合约支持 `flashLoanSimple` 的 callback（`executeOperation`）
   - 使用 `simulateAndExecFlashLoan` 或 Aave 专用的模拟执行路径

**性能优化**：
- `cachedReserves` 避免重复调用 `getReservesList()`
- `minHealthFactorBuffer` 预过滤，减少 `getUserAccountData` 的后续处理
- 批处理 `getUserAccountData` 使用 `Promise.allSettled`（同 Comet 的 `batchCheckLiquidatable` 模式）

---

## Task 7: 添加配置类型和链配置

**文件变更**：

**修改** `apps/config/src/types.ts`：
```typescript
export interface AaveWatchlistConfig {
  enabled: boolean;
  poolAddress: Address;
  poolDeployBlock: number;
  reserves: Address[];
  pollIntervalBlocks?: number;
  minHealthFactorBuffer?: bigint;  // 安全边际，避免浪费 RPC 在健康账户上
}

// 在 Options 接口中添加：
aaveWatchlist?: AaveWatchlistConfig;
```

**修改** `apps/config/src/index.ts`：
- 导出 `AaveWatchlistConfig` 类型

**修改** `apps/config/src/config.ts`：
- 在 Base 链配置中添加 `aaveWatchlist`（初始可设为 `enabled: false` 作为 feature flag）

---

## Task 8: 在 `index.ts` 中接入 Aave Bot

**文件**：
- **修改** `apps/client/src/index.ts`

**变更**（遵循 Comet bot 的接入模式，L139-166）：
```typescript
// ─── Aave V3 Bot (parallel to Morpho + Comet) ───
if (config.aaveWatchlist?.enabled) {
  try {
    const aaveBot = new AaveLiquidationBot({
      logTag: `[${config.chain.name} aave]: `,
      client,
      aaveWatchlist: config.aaveWatchlist,
      executorAddress: config.executorAddress,
      treasuryAddress,
      liquidityVenues,
      pricers,
      wNative: config.wNative,
      chainId: config.chainId,
      positionLiquidationCooldownMechanism,
      flashbotAccount,
      useFlashLoan: config.useFlashLoan,
      alwaysRealizeBadDebt: ALWAYS_REALIZE_BAD_DEBT,
    });
    await aaveBot.initialize();
    aaveBot.startPolling();
    console.log(`${logTag}✅ Aave V3 liquidation bot started`);
  } catch (e) {
    console.error(`${logTag}Failed to start Aave bot:`, e);
  }
}
```

---

## Task 9: 测试

**文件**：
- **新建** `apps/client/test/vitest/aaveBot.test.ts`

**测试覆盖**：
1. `selectBestLiquidationPair()` 单元测试：
   - 多 collateral + 多 debt 组合
   - 单 collateral + 单 debt（退化为 Comet 场景）
   - 所有组合都不盈利 → 返回 null
2. 动态 close factor 计算：
   - HF 在不同区间的 close factor 值
   - 边界条件（HF = 0, HF = 0.95, HF = 0.99）
3. `getUserAccountData` WAD-scaling 正确性：
   - healthFactor 是 18 位精度
   - totalCollateralBase/totalDebtBase 是 8 位精度
4. `AaveAccountRegistry` 事件扫描和持久化
5. 直接清算路径和闪贷路径的模拟测试

---

## Task 10: 更新 ARCHITECTURE.md

**文件**：
- **修改** `ARCHITECTURE.md`

**添加**：
- Aave V3 Flow 章节（同 Compound V3 Flow 章节的结构）
- 更新 Key abstractions 列表
- 更新架构图中的组件关系

---

## 依赖关系

```
Task 1 (findDeployBlock 提取) — 无依赖，最先做
Task 2 (Aave ABI) — 无依赖，可与 Task 1 并行
Task 3 (AaveAccountRegistry) — 依赖 Task 2
Task 4 (selectBestLiquidationPair) — 依赖 Task 2，可与 Task 3 并行
Task 5 (LiquidationEncoder 扩展) — 依赖 Task 2
Task 6 (AaveLiquidationBot) — 依赖 Task 1, 3, 4, 5
Task 7 (配置) — 无依赖，可早期做
Task 8 (index.ts 接入) — 依赖 Task 6, 7
Task 9 (测试) — 依赖 Task 4, 6
Task 10 (文档) — 最后做
```

## 建议构建顺序

1. **Task 1** + **Task 2** + **Task 7**（并行，无依赖）
2. **Task 3** + **Task 4** + **Task 5**（并行，依赖 Task 2）
3. **Task 6**（核心 bot，依赖上述所有）
4. **Task 8**（接入）
5. **Task 9**（测试）
6. **Task 10**（文档）

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| Aave `getUserAccountData` 的 8 位 vs 18 位精度混淆 | 在 Task 9 中添加专门的单位测试；代码中添加常量注释 |
| 动态 close factor 逻辑与协议实际行为不一致 | 实现前验证 Aave V3 最新源码中的 close factor 公式；不硬编码 |
| Aave flash loan callback 接口 (`executeOperation`) 与 Balancer 不同，executor 合约可能不支持 | 先验证 executor 合约是否支持 Aave flash loan callback；如不支持，先用 Balancer flash loan 路径 |
| Aave V3 竞争激烈，高价值清算被 MEV bot 抢先 | 遵循用户计划中的建议：先作为工程验证，不作为近期收入预期 |
| `findDeployBlock` 提取后 Comet bot 回归 | Task 1 完成后立即验证 Comet bot 初始化仍正常 |
| Aave Pool 事件量大，registry 扫描耗时 | 使用 Base 公开 RPC 的 10k 批次限制，与 Comet 相同策略 |

---
=======
>>>>>>> Stashed changes
=======
>>>>>>> Stashed changes
=======
>>>>>>> Stashed changes

## 被拒绝的替代方案

1. **Data Provider 模式**：Aave 的资产对选择步骤和动态 close factor 使其不适合复用 `LiquidationBot` 的编排流程。Morpho 的 `LiquidationBot` 假设一个 collateral → 一个 debt token 的模型，Aave 的多资产模型不兼容。

2. **复用 CometAccountRegistry 类（泛型化）**：虽然结构相似，但 Aave 事件签名和参数完全不同（Supply/Borrow vs SupplyCollateral/WithdrawCollateral），泛型化会增加复杂度且收益有限。选择独立类 + 相同模式。

3. **将 `selectBestLiquidationPair` 放在 bot 类内部**：分离为独立工具函数便于单元测试，且未来可能被其他协议复用。

4. **Aave flash loan 替代 Balancer flash loan**：Aave 自身提供 `flashLoanSimple`（0.05-0.09% fee），但 executor 合约需要支持 `executeOperation` callback。建议先用 Balancer（0% fee，executor 已支持），后续再评估 Aave native flash loan。

---

## 关键文件清单

1. `apps/client/src/cometBot.ts` — 参考模板，`findDeployBlock` 从此提取
2. `apps/client/src/cometAccountRegistry.ts` — 参考模板，AaveAccountRegistry 照此结构
3. `apps/client/src/utils/sharedExecution.ts` — 共享执行管道，Aave bot 复用
4. `apps/client/src/utils/LiquidationEncoder.ts` — 需扩展 Aave 编码方法
5. `apps/config/src/types.ts` — 需添加 `AaveWatchlistConfig` 类型
