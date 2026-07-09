# Morpho Blue Liquidation Bot

Multi-chain liquidation bot for the Morpho Blue lending protocol. Monitors positions across all chains where Morpho is deployed and executes profitable liquidations via on-chain executor contracts.

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
- **`LiquidationBot`** (`apps/client/src/bot.ts`) — Core orchestrator. Fetches markets, finds liquidatable positions, encodes liquidation calldata, simulates, checks profitability, and executes. Supports both direct and flash-loan-backed liquidation paths, and an event-driven fast path via webhook events.
- **`LiquidationEncoder`** (`apps/client/src/utils/LiquidationEncoder.ts`) — Builds batched calldata for the on-chain executor contract. Extends `ExecutorEncoder` with pre-liquidation support.
- **`PositionCache`** (`apps/client/src/positionCache.ts`) — In-memory cache for positions and market state. Enables the event-driven fast path: events update cache incrementally, fresh oracle prices are fetched on demand, and HF is recalculated to identify at-risk positions without a full API round-trip.
- **`WebhookServer`** (`apps/client/src/webhook.ts`) — Fastify HTTP server that receives Alchemy webhook POST payloads, decodes MorphoBlue events from logs, and triggers `handleEvents()` on all registered bots for event-driven liquidation.
- **`HealthServer`** (`apps/client/src/health.ts`) — Singleton Fastify server exposing a `/health` endpoint for container orchestration and monitoring.

### Flow

1. Config defines which chains, data provider, vaults, venues, and pricers to use
2. `script.ts` starts the `HealthServer` (liveness probe) and `WebhookServer` (Alchemy event-driven triggering)
3. `script.ts` reads all chain configs, groups chains by data provider, creates shared providers (awaiting `init()` for backfill), then launches one bot per chain
4. Each bot initializes its `PositionCache`: fetches covered markets (vault whitelist + discovery-layer approved markets) and caches liquidatable positions + market state from the data provider
5. **Slow path** (block-watcher loop): `watchBlocks` triggers `bot.run()` at configured `blockInterval` — fetches fresh liquidatable positions from the data provider, updates cache, and attempts liquidation
6. **Fast path** (event-driven): Alchemy webhook → `WebhookServer` decodes MorphoBlue events → `handleEvents()` updates cache incrementally, fetches fresh oracle prices, recalculates HF, and triggers liquidation for newly at-risk positions
7. For each liquidatable position: try liquidity venues in order to convert collateral → loan token (with encoder state snapshot/restore on failure)
8. Simulate the full liquidation via `simulateCalls`, check profitability via pricers (profit must exceed gas costs)
9. Execute via `writeContract` or Flashbots bundle (mainnet only)
10. **Flash loan path** (optional): when `useFlashLoan` is enabled, the bot uses a Balancer V2 flash loan (0% fee) to borrow loan tokens, liquidate the position, swap seized collateral via DEX, repay the flash loan, and skim profit to treasury — all within a single executor transaction. A slippage safety margin protects against sandwich attacks between simulation and execution.

## Non-Negotiables

- **Never commit secrets or private keys.** Secrets (RPC URLs, private keys, API keys) must come from environment variables. Never hardcode them anywhere.
- **All configuration lives in the config package.** The client, liquidity-venues, pricers, and data-providers packages must not define or hardcode any configuration within their own packages. All configuration (parameters, addresses, venue/pricer ordering, chain settings) lives in `apps/config`. These packages may access config values by importing directly from `@morpho-blue-liquidation-bot/config` — this is the intended pattern, not a violation. If you need a new parameter, add it to the config types in `apps/config`. These packages may also read secrets (e.g. RPC URLs, API keys) directly from environment variables.
- **Never push directly to `main`.** Always use feature branches and PRs.
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
