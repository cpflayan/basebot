# Multi-Protocol Liquidation Bot

A simple, fast, and easily deployable liquidation bot for **Morpho Blue**, **Compound V3 (Comet)**, **Moonwell (Compound V2)**, and **Aave V3**. This bot is based on **RPC calls**, designed to be **easy to configure**, **customizable**, and **ready to deploy** on EVM chains (primary target: Base).

## Features

- **Four protocols** in one process:
  - **Morpho Blue** — isolated markets, API/cache + webhook fast path
  - **Compound V3 (Comet)** — absorb + buyCollateral
  - **Moonwell** — liquidateBorrow + redeemUnderlying
  - **Aave V3** — multi-collateral / multi-debt `liquidationCall` with pair selection
- **Race-oriented path**: hot HF sets (Aave), graded cooldowns, local DEX first, parallel multicall shards
- **RPC budget controls**: concurrency caps, wave gaps, SharedBlockBus phase stagger (fewer 429s)
- **Flash loans**: Balancer V2 (0% fee) and Aave V3 premium; primary + fallback providers
- **Durable account registries**: split accounts JSON + checkpoint cursor; Aave subgraph backfill
- Modular [data providers](./apps/data-providers/README.md), [liquidity venues](./apps/liquidity-venues/README.md), [pricers](./apps/pricers/README.md)

### Disclaimer

This bot is provided as-is, without any warranty. Use at your own risk. The Morpho Association (and any other protocol) is not responsible for losses (gas, failed txs, or liquidations on misconfigured markets).

## Packages

| Package                                            | Description                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| [`apps/config`](./apps/config)                     | Chain configurations, module registrations, tunable parameters           |
| [`apps/client`](./apps/client)                     | Bot orchestration, registries, execution, health/webhook                 |
| [`apps/data-providers`](./apps/data-providers)     | Market/position data providers                                           |
| [`apps/hyperindex`](./apps/hyperindex)             | Envio HyperIndex indexer (optional Morpho data path)                     |
| [`apps/liquidity-venues`](./apps/liquidity-venues) | Collateral → loan conversion venues                                      |
| [`apps/pricers`](./apps/pricers)                   | USD pricing for profit checks                                            |

## Requirements

- Node.js >= 20
- [pnpm](https://pnpm.io/)
- At least one paid Base RPC (`RPC_URL_BASE` / `RPC_URL_8453`); extra `RPC_URL_BASE2`–`BASE7` for parallel reads
- EOA private key with gas
- Deployed executor contract for that EOA ([Executor Contract Deployment](#executor-contract-deployment))

## Installation

```bash
git clone <your-fork-or-repo>
cd base-bot   # or repo root
pnpm install
cp .env.example .env   # fill secrets
```

## Chain configuration

Edit `apps/config/src/config.ts` for each chain: `wNative`, Morpho whitelist, liquidity venues, pricers, flash loan, and optional:

- `cometWatchlist` — Compound V3 markets
- `moonwellWatchlist` — Moonwell mTokens
- `aaveWatchlist` — Aave V3 Pool + reserves
- `blockInterval`, `useFlashLoan`, `flashLoanProvider`, `flashLoanFallbackProviders`

Details: [ARCHITECTURE.md](./ARCHITECTURE.md).

### Secrets (`.env`)

See [`.env.example`](./.env.example). Core keys:

| Variable | Role |
| -------- | ---- |
| `RPC_URL_BASE` or `RPC_URL_8453` | Primary write/read RPC |
| `RPC_URL_BASE2` … `BASE7` | Paid read pool (round-robin multicall) |
| `WATCH_RPC_URL` | Free/public RPC for `watchBlocks` only |
| `FALLBACK_RPC_URL` / `PUBLIC_RPC_URL_BASE` | Write failover / historical scan fallback |
| `EXECUTOR_ADDRESS_8453` | Executor contract |
| `LIQUIDATION_PRIVATE_KEY_8453` | Liquidator EOA |
| `ACCOUNT_REGISTRY_DIR` | Persist registries (Docker: `/app/data`) |
| `THEGRAPH_API_KEY` | Optional Aave subgraph backfill |
| `TOKEN_BLACKLIST` | Extra blacklisted tokens (comma-separated) |

### Race / RPC budget (optional env)

Defaults favor **fewer 429s** while keeping the Aave hot path every block. **Env wins over config** when set.

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `HF_CONCURRENCY` | `min(3, poolSize)` | Parallel multicall shards |
| `HF_BATCH_SIZE` | `100` | Accounts per multicall |
| `RPC_WAVE_GAP_MS` | `40` | Pause between shards |
| `AAVE_FULL_SCAN_INTERVAL_BLOCKS` | `15` | Full registry cadence (hot set still every poll) |
| `AAVE_NEAR_HEALTH_FACTOR` | `1.05` | Hot-set threshold |
| `SKIP_ROUTE_WARM` | off | `1` skips DEX route warm-up |
| `ROUTE_WARM_MAX_MAJORS` | `6` | Cap warm fan-out tokens |

Ops guide: [docs/operations.md](./docs/operations.md).

### Cooldown

- `POSITION_LIQUIDATION_COOLDOWN_*` in config: **graded** race / soft / hard / success periods (not a single hard lock on every peek).

## Executor contract

```bash
pnpm deploy:executor
```

Or deploy via [executooor UI](https://rubilmax.github.io/executooor/).

## Run

```bash
# Bot only
pnpm liquidate

# Bot + Morpho discovery (concurrent)
pnpm start

# Offline Aave account backfill (subgraph preferred)
pnpm backfill:aave

# Skim profit tokens from executor
pnpm skim --chainId 8453 --token 0x... --recipient 0x...
```

### Tests

```bash
# All client tests (unit + Base + mainnet forks)
pnpm test:client

# Base only (8453) — unit + Aave/Comet/Moonwell/Morpho Base forks
pnpm test:client:base
# same as:
pnpm test:client -- --chainId 8453

# Ethereum mainnet fork tests only (needs RPC_URL_1)
pnpm test:client -- --chainId 1

# Multi-protocol Base fork suite only
pnpm test:fork-suite
```

Logs: colored console + `logs/bot.log` (gitignored). Size rotation by default (`LOG_FILE_MAX_MB=20`, keep `LOG_FILE_MAX_FILES=5` → `bot.log`, `bot.log.1`, …).

## Liquidation process

![Process](./img/liquidation-process-high-level.png)

### Morpho Blue

1. **Slow path**: shared block bus → `bot.run()` → data provider liquidatable positions  
2. **Fast path**: Alchemy webhook → `PositionCache` + oracle refresh → HF → liquidate  
3. Venues (local DEX first) → simulate → profit → execute (optional flash loan)

### Compound V3

1. `CometAccountRegistry` event discovery  
2. Every N blocks (phase 0): multicall `isLiquidatable` → absorb + buyCollateral + swap  

### Moonwell

1. Per-mToken registry  
2. Every N blocks (phase 2, staggered vs Comet): `getAccountLiquidity` shortfall → liquidateBorrow + redeem  

### Aave V3

1. Registry: split `aave-accounts.<chainId>.json` + `.checkpoint.json`; prefer `pnpm backfill:aave`  
2. **Hot path** (default every block): near-HF accounts only  
3. **Full path** (default every 15 ticks): getLogs + full HF sweep  
4. `selectBestLiquidationPair` → flash/direct liquidationCall + DEX  

## Security

- Token blacklist, mandatory pricers, simulation-first, dynamic slippage from route impact  
- Encoder snapshot/restore on failed venue probes  
- Treasury address separate from EOA when configured  

## Documentation

| Doc | Contents |
| --- | -------- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Protocol flows, shared bus, registries, config shapes |
| [docs/operations.md](./docs/operations.md) | RPC budget, backfill, Docker data, log metrics |
| [docs/liquidation-debug-guide.md](./docs/liquidation-debug-guide.md) | Decision debug logs + RaceSummary |

## Development

```bash
pnpm build
pnpm test:client          # unit (excludes broken forks if RPC unavailable)
pnpm test:fork-suite      # allBots fork suite (needs RPC)
pnpm lint
```
