# Base Liquidation Bot — Architecture

Multi-protocol, multi-chain liquidation system for three lending protocols:

1. **Morpho Blue** — Isolated lending markets with oracle-based pricing
2. **Compound V3 (Comet)** — Single borrowing market per Comet with absorb + buyCollateral
3. **Moonwell (Compound V2)** — Fork of Compound V2 with liquidateBorrow + redeemUnderlying

Consists of two projects:

1. **`morpho-blue-liquidation-bot`** — Executes profitable liquidations via on-chain executor contracts
2. **`morpho-liquidation-discovery`** — Scans and validates Morpho markets, generates whitelist for the bot

## Architecture

Workspace monorepo with six packages:

- **`apps/config`** — Chain configurations, venue/pricer/data-provider registrations, and all tunable parameters. Single source of truth for what the bot does and how.
- **`apps/client`** — Bot orchestration logic and on-chain execution. Contains no configuration or secrets — everything is injected from config.
- **`apps/data-providers`** — Data provider interface and implementations (MorphoApi, HyperIndex) for fetching market and position data.
- **`apps/hyperindex`** — Envio HyperIndex indexer package. Standalone service that indexes Morpho on-chain events. Used by the HyperIndex data provider.
- **`apps/liquidity-venues`** — Liquidity venue interface and implementations for converting collateral to loan tokens.
- **`apps/pricers`** — Pricer interface and implementations for pricing assets in USD.

### Key abstractions

- **`DataProvider`** (`apps/data-providers/src/dataProvider.ts`) — Interface for fetching market and position data. Multi-chain: a single instance is shared across all chains. Implements optional `init()`, `fetchMarkets`, and `fetchLiquidatablePositions`. Created in `script.ts` before bots launch.
- **`LiquidityVenue`** (`apps/liquidity-venues/src/liquidityVenue.ts`) — Interface for converting collateral to loan token. Venues are tried in order defined by config. Each venue implements `supportsRoute` and `convert`.
- **`Pricer`** (`apps/pricers/src/pricer.ts`) — Interface for pricing assets in USD. Used for profitability checks. Pricers are tried in order defined by config.
- **Factories** (`apps/data-providers/src/factory.ts`, `apps/liquidity-venues/src/factory.ts`, `apps/pricers/src/factory.ts`) — Map config string identifiers to class instances. The config package exports only string names; the implementation packages own the classes. The data provider factory (`createDataProviders`) takes chain IDs and returns a `Map<number, DataProvider>` with a shared instance.
- **`LiquidationBot`** (`apps/client/src/bot.ts`) — Core Morpho Blue orchestrator. Fetches markets, finds liquidatable positions, encodes liquidation calldata, simulates, checks profitability, and executes. Supports both direct and flash-loan-backed liquidation paths, and an event-driven fast path via webhook events.
- **`CometLiquidationBot`** (`apps/client/src/cometBot.ts`) — Compound V3 orchestrator. Runs in parallel with `LiquidationBot`. Uses `Comet.isLiquidatable()` to check accounts, executes via `absorb` + `buyCollateral` with optional flash loan support. Shares liquidity venues, pricers, and execution utilities with the Morpho bot.
- **`MoonwellLiquidationBot`** (`apps/client/src/moonwellBot.ts`) — Moonwell (Compound V2) orchestrator. Runs in parallel with Morpho and Comet bots. Uses `Comptroller.getAccountLiquidity()` to detect shortfall, executes via `liquidateBorrow` + `redeemUnderlying` with optional flash loan support. Key difference from Comet: no absorb step needed — `liquidateBorrow` directly seizes collateral mTokens, which must be redeemed via `redeemUnderlying` before DEX swap.
- **`CometAccountRegistry`** (`apps/client/src/cometAccountRegistry.ts`) — Account discovery module for Compound V3. Scans `SupplyCollateral`/`WithdrawCollateral` events to build a deduplicated account list per Comet. Persists state to JSON for incremental scanning across restarts.
- **`MoonwellAccountRegistry`** (`apps/client/src/moonwellAccountRegistry.ts`) — Account discovery module for Moonwell. Scans `Borrow`/`LiquidateBorrow` events to build a deduplicated account list per mToken. Persists state to JSON for incremental scanning across restarts. Key difference from Comet registry: tracks per-mToken (not per-Comet), focuses on borrowers since only they can be liquidated.
- **`SharedExecution`** (`apps/client/src/utils/sharedExecution.ts`) — Shared execution utilities used by Comet and Moonwell bots. Extracted from `bot.ts` to avoid duplication. Provides: `SharedExecutionDeps` (dependency injection type), `checkProfit` (USD profitability verification), `convertCollateralToLoan` (DEX swap with encoder snapshot/restore), `simulateAndExecFlashLoan` (flash loan simulation + slippage margin + execution), `simulateAndExec` (direct path simulation + execution).
- **`LiquidationEncoder`** (`apps/client/src/utils/LiquidationEncoder.ts`) — Builds batched calldata for the on-chain executor contract. Extends `ExecutorEncoder` with pre-liquidation support.
- **`PositionCache`** (`apps/client/src/positionCache.ts`) — In-memory cache for Morpho positions and market state. Enables the event-driven fast path: events update cache incrementally, fresh oracle prices are fetched on demand, and HF is recalculated to identify at-risk positions without a full API round-trip. Uses `@morpho-org/blue-sdk` `Market` and `AccrualPosition` for accurate HF computation.
- **`WebhookServer`** (`apps/client/src/webhook.ts`) — Fastify HTTP server that receives Alchemy webhook POST payloads, decodes MorphoBlue events from logs, and triggers `handleEvents()` on all registered bots for event-driven liquidation. Supports 6 event types: `Borrow`, `WithdrawCollateral`, `Withdraw`, `SupplyCollateral`, `Repay`, `Liquidate`. Includes a 2-second cooldown to prevent rapid re-triggering.
- **`HealthServer`** (`apps/client/src/health.ts`) — Singleton Fastify server exposing a `/health` endpoint for container orchestration and monitoring. Binds to `127.0.0.1` by default for security.

### Flow

All three bots run in parallel within a single process, sharing infrastructure (liquidity venues, pricers, executor contract, treasury).

1. Config defines which chains, data provider, vaults, venues, and pricers to use
2. `script.ts` starts the `HealthServer` (liveness probe on port 3000) and `WebhookServer` (Alchemy event-driven triggering on port 3001)
3. `script.ts` reads all chain configs, groups chains by data provider, creates shared providers (awaiting `init()` for backfill), then launches one bot per chain via `launchBot()`
4. `launchBot()` in `index.ts` creates the Morpho `LiquidationBot`, and conditionally starts `CometLiquidationBot` and `MoonwellLiquidationBot` if their watchlists are enabled

#### Morpho Blue Bot Flow

5. Each Morpho bot initializes its `PositionCache`: fetches covered markets (vault whitelist + discovery-layer approved markets) and caches liquidatable positions + market state from the data provider
6. **Slow path** (block-watcher loop): `watchBlocks` triggers `bot.run()` at configured `blockInterval` — fetches fresh liquidatable positions from the data provider, updates cache, and attempts liquidation
7. **Fast path** (event-driven): Alchemy webhook → `WebhookServer` decodes MorphoBlue events → `handleEvents()` updates cache incrementally, fetches fresh oracle prices, recalculates HF, and triggers liquidation for newly at-risk positions
8. For each liquidatable position: try liquidity venues in order to convert collateral → loan token (with encoder state snapshot/restore on failure)
9. Simulate the full liquidation via `simulateCalls`, check profitability via pricers (profit must exceed gas costs)
10. Execute via `writeContract` or Flashbots bundle (mainnet only)
11. **Flash loan path** (optional): when `useFlashLoan` is enabled, the bot uses a Balancer V2 flash loan (0% fee) to borrow loan tokens, liquidate the position, swap seized collateral via DEX, repay the flash loan, and skim profit to treasury — all within a single executor transaction. A slippage safety margin protects against sandwich attacks between simulation and execution.

### Compound V3 (Comet) Flow

The `CometLiquidationBot` runs in parallel with the Morpho `LiquidationBot`, sharing infrastructure (liquidity venues, pricers, executor, treasury).

### Account Discovery (`CometAccountRegistry`)

- On first startup: exponential search + binary search via `eth_getCode` to find exact Comet deploy blocks
- Historical scan: scans `SupplyCollateral`/`WithdrawCollateral` events from deploy block to current, using Base public RPC (10k blocks per batch)
- Persists accounts + `lastScannedBlock` to `./data/comet-accounts.<chainId>.json`
- On restart: loads JSON, only scans new blocks (incremental)
- Fallback: if event-specific log filter fails, uses broad log scan to capture all interaction types

### Polling Loop

- `watchBlocks` triggers periodic checks at configured `pollIntervalBlocks` (default: 5 blocks)
- Each cycle: incremental event scan → batch `isLiquidatable()` checks (via `Promise.allSettled`) → trigger liquidations
- Overlapping runs prevented by `running` flag

### Liquidation Execution

- For each liquidatable account: estimate debt via `userBasic` + `totalsBasic` (borrow balance = |principal| × baseBorrowIndex / 1e15)
- **Flash loan path**: Balancer flash loan → ERC20 approve → `Comet.absorb(executor, [accounts])` → `Comet.buyCollateral(asset, minAmount, baseAmount, executor)` for each collateral with reserves → DEX swap seized non-base collateral → repay flash loan → skim profit
- **Direct path**: when flash loan is disabled — same flow but without Balancer wrapper
- Profit check: via `simulateAndExecFlashLoan` / `simulateAndExec` from `sharedExecution.ts` — treasury balance change must exceed gas cost + slippage margin
- Collateral assets cached at startup via `numCollateralAssets()` + `getCollateralAsset()`, with hardcoded fallback

### Dual-RPC Architecture

- **Historical scanning**: Base public RPC (`https://mainnet.base.org`) — supports 10k block `eth_getLogs`, free, no API key
- **Trading + incremental**: Alchemy RPC (configured via `RPC_URL_8453`) — reliable for writes and small-range queries

## Moonwell (Compound V2) Flow

The `MoonwellLiquidationBot` runs in parallel with Morpho and Comet bots, sharing the same infrastructure.

### Key Differences from Comet (V3)

| Aspect | Comet (V3) | Moonwell (V2) |
|--------|-----------|---------------|
| Liquidation check | `Comet.isLiquidatable(account)` | `Comptroller.getAccountLiquidity(account)` → shortfall > 0 |
| Seize collateral | `absorb()` then `buyCollateral()` | `liquidateBorrow()` directly seizes mToken |
| Collateral form after seize | Underlying tokens | mTokens (must `redeemUnderlying()` to get underlying) |
| Repay amount | Full debt | min(borrowBalance × closeFactor, available) |
| Account discovery events | `SupplyCollateral` / `WithdrawCollateral` | `Borrow` / `LiquidateBorrow` |
| Registry granularity | Per-Comet | Per-mToken |

### Account Discovery (`MoonwellAccountRegistry`)

- Scans `Borrow` events per mToken to discover accounts with debt
- Batch size: 10,000 blocks per `eth_getLogs` call (Base public RPC limit)
- Persists to `./data/moonwell-accounts.<chainId>.json`
- Incremental scanning on restart (only new blocks since last scan)
- Fallback: broad log scan if event-specific filter fails

### Polling Loop

- `watchBlocks` triggers at `pollIntervalBlocks` (default: 5 blocks)
- Each cycle: incremental scan across all mTokens → collect unique accounts → batch `getAccountLiquidity()` checks → trigger liquidations for accounts with shortfall > 0

### Liquidation Execution

- **Target selection**: `findLiquidationTargets()` reads `borrowBalanceStored` + `balanceOf` for all mTokens in parallel — finds the first mToken with debt (borrow target) and the mToken with largest mToken balance (collateral target)
- **Repay amount**: `borrowBalance × closeFactor / 1e18` (closeFactor cached from Comptroller at startup, default 50%)
- **Comptroller params**: `closeFactorMantissa` and `liquidationIncentiveMantissa` cached at startup with hardcoded fallback (50% / 10%)
- **Flash loan path**: Balancer flash loan → approve borrow mToken → `liquidateBorrow(borrowMToken, collateralMToken, account, repayAmount)` → `redeemUnderlying(collateralMToken, 0n)` to convert seized mToken to underlying → DEX swap collateral underlying → borrow underlying (if different tokens) → skim profit → auto-repay Balancer
- **Direct path**: same flow without Balancer wrapper
- Profit check: via shared `simulateAndExecFlashLoan` / `simulateAndExec`

### Token Blacklist

All three bots independently maintain a `TOKEN_BLACKLIST` (currently USR at `0x35e5db674d8e93a03d814fa0ada70731efe8a4b9`). Markets involving blacklisted tokens are skipped entirely.

## Compound V3 Configuration

Comet markets are configured in `apps/config/src/config.ts` under `options.cometWatchlist`:

```typescript
cometWatchlist: {
  enabled: boolean;
  comets: {
    address: Address;      // Comet contract address
    baseAsset: Address;    // Base token (e.g., USDC, WETH)
    deployBlock: number;   // Verified deployment block
  }[];
  pollIntervalBlocks?: number;  // Polling frequency (default: 5)
}
```

### Base Chain Comets (Verified)

| Comet | Address | Base Asset | Deploy Block |
|-------|---------|------------|--------------|
| USDC | `0xb125E6687d4313864e53df431d5425969c15Eb2F` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 11,699,480 |
| WETH | `0x46e6b214b524310239732D51387075E0e70970bf` | `0x4200000000000000000000000000000000000006` | 2,495,303 |
| USDbC | `0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf` | `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA` | 2,197,588 |
| AERO | `0x784efeB622244d2348d4F2522f8860B96fbEcE89` | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` | 20,852,405 |

Deploy blocks are verified via binary search on startup. If the configured value is incorrect, the bot automatically finds the exact block using exponential search + `eth_getCode`.

## Moonwell Configuration

Moonwell markets are configured in `apps/config/src/config.ts` under `options.moonwellWatchlist`:

```typescript
moonwellWatchlist: {
  enabled: boolean;
  comptroller: Address;     // Moonwell Comptroller address
  mTokens: {
    address: Address;       // mToken (cToken) contract address
    underlying: Address;    // Underlying token address
    deployBlock: number;    // Block number where the mToken was deployed
  }[];
  pollIntervalBlocks?: number;  // Polling frequency (default: 5)
}
```

### Base Chain Moonwell mTokens (Dynamic — Verified On-Chain)

Moonwell Core is a **shared pool** (Compound V2 style) — all assets share one Comptroller, any asset can be collateral to borrow any other asset. Not paired markets.

All markets have `protocolSeizeShareMantissa = 3%` — 3% of seized collateral goes to protocol reserves.

**The complete market list is NOT hardcoded here.** CF and RF values change via governance. Use the scan script to get ground truth:

```bash
RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key> node scripts/moonwell-markets-scan.mjs
```

This script calls `Comptroller.getAllMarkets()` and reads per-market: `underlying()`, `symbol()`, `decimals()`, `reserveFactorMantissa()`, `protocolSeizeShareMantissa()`, `Comptroller.markets()` for CF, and binary-searches `eth_getCode` for deploy blocks. It also classifies each market's oracle type via OEV probe (see below). Output includes config-ready snippets for `config.ts`.

The bot also discovers markets dynamically at startup — `moonwellBot.ts` calls `discoverUnderlyings()` to cache all `mToken.underlying()` addresses, and reads `Comptroller.getCloseFactor()` / `liquidationIncentiveMantissa()` once at init. Per-market CF is read via `Comptroller.markets(mToken)` during health factor calculation.

Comptroller: `0xfBb21d0380beE3312B33c4353c8936a0F13EF26C`

**ABI note**: Moonwell V2 `Comptroller.markets(address)` returns `(bool isListed, uint256 collateralFactorMantissa)` — only 2 fields, NOT the standard Compound V2 3-field `(bool, uint256, bool)` format. Using the wrong ABI causes `buffer overrun` decoding errors.

**OEV classification** (probe via `maxRoundDelay()` on ChainlinkOracle.getFeed() result):
- 🟢 **OEV-wrapped** (15 markets): Most markets use OEV wrappers — liquidation profits are partially captured by the wrapper's `liquidatorFeeBps`, reducing bot profitability
- ⚪ **Traditional** (6 markets): mcbETH, mwstETH, mrETH, mweETH, mwrsETH, mLBTC — plain or composite Chainlink feeds, no OEV wrapper. These are the **best targets** for liquidation bots since no wrapper fee deduction
- ⚠️ **Probe caveat**: The `maxRoundDelay()` probe assumes all OEV wrappers expose this function. If Moonwell changes the wrapper interface, the probe will silently misclassify everything as "traditional". Always manually verify a few known markets (e.g. cbETH=traditional, USDC=OEV) after running the script

**Profitability guidance**: Markets with 99-100% reserve factors (check via scan script) send nearly all liquidation rewards to protocol reserves — focus on markets with lower RF for better profitability. Non-USD assets (wstETH, rETH, weETH, wrsETH, cbBTC, tBTC, cbETH, LBTC, VIRTUAL, MORPHO, cbXRP, MAMO, VVV) use exchange-rate composite oracles and are most likely to create liquidation opportunities.

## Discovery Layer

The `morpho-liquidation-discovery` project is a separate service that scans Base chain for approved Morpho markets and maintains a whitelist. The bot reads this whitelist at startup to know which markets are safe to liquidate.

### Purpose

- **Market Discovery**: Scans Morpho Blue for active markets with sufficient liquidity
- **Safety Checks**: Validates markets against security criteria (proxy verification, token blacklist)
- **Whitelist Generation**: Outputs `data/discovered-markets.8453.json` consumed by the bot

### Key Components

- **`src/discovery/run.ts`** — Main discovery script that scans markets
- **`src/safety/checks.ts`** — Security validation (proxy detection, token blacklist)
- **`src/shared/whitelist-store.ts`** — Reads/writes the whitelist JSON
- **`scripts/scan-liquidations.ts`** — CLI tool for manual scanning

### Integration

The bot loads the whitelist via `WHITELIST_DATA_DIR` environment variable:

```bash
WHITELIST_DATA_DIR=/path/to/morpho-liquidation-discovery/data
```

At startup, `apps/config/src/config.ts` reads `discovered-markets.8453.json` and filters markets to only those approved by the discovery layer.

## Non-Negotiables

- **Never commit secrets or private keys.** Secrets (RPC URLs, private keys, API keys) must come from environment variables. Never hardcode them anywhere.
- **All configuration lives in the config package.** The client, liquidity-venues, pricers, and data-providers packages must not define or hardcode any configuration within their own packages. All configuration (parameters, addresses, venue/pricer ordering, chain settings) lives in `apps/config`. These packages may access config values by importing directly from `@morpho-blue-liquidation-bot/config` — this is the intended pattern, not a violation. If you need a new parameter, add it to the config types in `apps/config`. These packages may also read secrets (e.g. RPC URLs, API keys) directly from environment variables.
- **Use feature branches for major changes.** Create feature branches (e.g., `add-Compound-V3`) for significant features, then merge to `main`. For small fixes, direct pushes to `main` are acceptable.
- **Always run tests after code changes.** Run the relevant test suite before considering work complete.
- **Preserve venue/pricer ordering semantics.** The order of `liquidityVenues` and `pricers` arrays in config is significant — venues are tried sequentially and the first successful conversion wins. Pricers are tried in order and the first price found is used. **Pricers are mandatory** — if no pricers are configured, the bot refuses to execute any trade (cannot verify profitability). Set `ALWAYS_REALIZE_BAD_DEBT=true` only if you explicitly want to bypass profit checks for bad-debt positions.

## Code Standards

### TypeScript & viem

- Strict TypeScript. Use viem types (`Address`, `Hex`, `Chain`, `Transport`) throughout.
- Use `bigint` for all on-chain values. Never use `number` for token amounts, prices, or gas.
- Use `viem/actions` for chain interactions (`readContract`, `writeContract`, `simulateCalls`).
- Use `parseUnits`/`formatUnits` for decimal conversions — never manual `10 ** n`.

### BigInt precision

- Always be explicit about decimal precision when converting between units.
- Rounding direction matters: round in favor of the protocol (down for collateral, up for debt).
- `WAD = 10^18` is used as the fixed-point base. Use `wMulDown` from `utils/maths.ts`.

### Error handling

- Wrap on-chain calls in try/catch. A failing venue or pricer should not crash the bot.
- Log errors with the chain `logTag` prefix for multi-chain debugging.
- Use `throw new Error("context", { cause: err })` to preserve stack traces.

### Testing

- **Liquidity venue tests**: `pnpm test:liquidity-venues` — test each venue's `supportsRoute` and `convert`
- **Pricer tests**: `pnpm test:pricers` — test each pricer's `price` method
- **Client Tests**: `pnpm test:client` — test bot orchestration (health, webhook, execution, cache)
- Tests use vitest with 45s timeout (some tests hit live RPCs)
- When adding a new venue or pricer, always add corresponding tests

## How to Add a New Data Provider

1. **Config** (`apps/config`):
   - Add the data provider name to the `DataProviderName` union type in `apps/config/src/types.ts`
   - Set the data provider name in the relevant chain configs in `apps/config/src/config.ts` via `options.dataProvider`

2. **Data Providers** (`apps/data-providers`):
   - Create `apps/data-providers/src/<providerName>/index.ts` implementing the `DataProvider` interface
   - Register it in the factory switch in `apps/data-providers/src/factory.ts`
   - Export it from `apps/data-providers/src/index.ts`

3. **Tests**:
   - Add tests for the new data provider
   - Run `pnpm test:client` to validate integration

## How to Add a New Liquidity Venue

1. **Config** (`apps/config`):
   - Add the venue name to the `LiquidityVenueName` union type in `apps/config/src/types.ts`
   - Create `apps/config/src/liquidityVenues/<venueName>.ts` for any venue-specific config constants
   - Export it from `apps/config/src/liquidityVenues/index.ts`
   - Add the venue name to the `liquidityVenues` array in the relevant chain configs in `apps/config/src/config.ts`

2. **Liquidity Venues** (`apps/liquidity-venues`):
   - Create `apps/liquidity-venues/src/<venueName>/index.ts` implementing the `LiquidityVenue` interface
   - If needed, create a `types.ts` in the same directory for venue-specific types
   - Register it in the factory switch in `apps/liquidity-venues/src/factory.ts`
   - Export it from `apps/liquidity-venues/src/index.ts`

3. **Tests**:
   - Add `apps/liquidity-venues/test/vitest/<venueName>.test.ts`
   - Run `pnpm test:liquidity-venues` to validate

## How to Add a New Pricer

1. **Config** (`apps/config`):
   - Add the pricer name to the `PricerName` union type in `apps/config/src/types.ts`
   - Create `apps/config/src/pricers/<pricerName>.ts` for any pricer-specific config
   - Export it from `apps/config/src/pricers/index.ts`
   - Add the pricer name to the `pricers` array in the relevant chain configs

2. **Pricers** (`apps/pricers`):
   - Create `apps/pricers/src/<pricerName>/index.ts` implementing the `Pricer` interface
   - Register it in the factory switch in `apps/pricers/src/factory.ts`
   - Export it from `apps/pricers/src/index.ts`

3. **Tests**:
   - Add `apps/pricers/test/vitest/<pricerName>.test.ts`
   - Run `pnpm test:pricers` to validate

## How to Add a New Chain

1. If the chain is not in `viem/chains`, create a custom chain definition in `apps/config/src/chains/<chainName>.ts` and export from `apps/config/src/chains/index.ts`
2. Add a new entry to `chainConfigs` in `apps/config/src/config.ts` with:
   - `chain` — the viem Chain object
   - `wNative` — wrapped native token address
   - `options` — vault whitelist, liquidity venues (ordered), pricers (ordered), buffer, flashbots toggle, block interval
   - `watchBlocksRetryDelayMs` — delay in ms before restarting the block watcher after an RPC error (default: 5000)
3. Set up environment variables: `RPC_URL_<chainId>`, `EXECUTOR_ADDRESS_<chainId>`, `LIQUIDATION_PRIVATE_KEY_<chainId>`
4. Deploy the executor contract on the new chain via `pnpm deploy:executor`

## Development Commands

- `pnpm build` — Build all packages (config, data-providers, liquidity-venues, pricers)
- `pnpm build:config` — Build the config package only
- `pnpm test:liquidity-venues` — Run liquidity venue tests
- `pnpm test:pricers` — Run pricer tests
- `pnpm test:client` — Run client/bot tests
- `pnpm test:hyperindex` — Run HyperIndex indexer tests
- `pnpm liquidate` — Run the bot (requires `.env`)
- `pnpm skim` — Rescue stuck tokens from executor contract (requires `--chainId`, `--token`, optional `--recipient`)
- `pnpm deploy:executor` — Deploy executor contract
- `pnpm lint` — Lint all packages
