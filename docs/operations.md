# Operations Guide

Runtime ops for the multi-protocol liquidation bot on Base.

## Quick start

```bash
cp .env.example .env   # fill keys
pnpm backfill:aave     # first-time Aave accounts (optional but strongly recommended)
pnpm start             # or: pnpm liquidate
```

Watch:

- Console / `logs/bot.log` — colored tags + `[RaceSummary]`
- Health: `http://127.0.0.1:3000/health` (default host)

## Data directories

| Path | Purpose |
| ---- | ------- |
| `ACCOUNT_REGISTRY_DIR` (default `./data`) | Protocol registries + checkpoints |
| `aave-accounts.<chainId>.json` | Large account set |
| `aave-accounts.<chainId>.checkpoint.json` | Block cursors (`lastScanned` / `accountsSynced`) |
| `comet-accounts.<chainId>.json` | Comet accounts |
| `moonwell-accounts.<chainId>.json` | Moonwell accounts |
| `position-cache.<chainId>.json` | Morpho position cache snapshot |

**Docker / Railway:** mount a volume and set `ACCOUNT_REGISTRY_DIR=/app/data` so checkpoints survive restarts.

Resume safety: durable resume uses `accountsSyncedBlock` so a crash never skips undiscovered accounts.

## Aave backfill

```bash
# Subgraph (preferred) — needs THEGRAPH_API_KEY or AAVE_SUBGRAPH_URL
pnpm backfill:aave

# Explicit RPC catch-up if subgraph unavailable
# (script falls back when no Graph key)
```

Subgraph path uses official Aave protocol subgraphs (Bearer `THEGRAPH_API_KEY`).  
Only accounts with outstanding debt (`currentTotalDebt > 0`) are imported.  
Liquidators-only addresses are **not** tracked from `LiquidationCall.liquidator`.

After backfill, the bot only does incremental `getLogs` from the checkpoint.

## RPC layout

| Client | Env | Use |
| ------ | --- | --- |
| Write wallet | `RPC_URL_BASE` + `BASE2`–`7` failover + `FALLBACK_RPC_URL` | sim + send tx |
| Paid read pool | `RPC_URL_BASE` + `BASE2`–`7` | HF / shortfall multicall, pair select |
| Watch | `WATCH_RPC_URL` (or public) | `watchBlocks` only — keep free to protect paid quota |
| Scan | `scanRpcUrls` in config (paid first) | historical eth_getLogs |

## RPC budget (429 vs race)

Implemented in `apps/client/src/utils/rpcBudget.ts`. **Env overrides config when set.**

### Defaults (balance)

```bash
# usually leave unset — defaults apply
# HF_CONCURRENCY=3
# RPC_WAVE_GAP_MS=40
# AAVE_FULL_SCAN_INTERVAL_BLOCKS=15
# AAVE_NEAR_HEALTH_FACTOR=1.05
```

### Fewer 429s

```bash
HF_CONCURRENCY=2
RPC_WAVE_GAP_MS=80
AAVE_FULL_SCAN_INTERVAL_BLOCKS=20
SKIP_ROUTE_WARM=1
```

### Aggressive race (will burn quota)

```bash
HF_CONCURRENCY=7          # capped by paid pool size
HF_BATCH_SIZE=150
RPC_WAVE_GAP_MS=0
AAVE_FULL_SCAN_INTERVAL_BLOCKS=1
AAVE_NEAR_HEALTH_FACTOR=1.10
ROUTE_WARM_MAX_MAJORS=12
# do not set SKIP_ROUTE_WARM
```

### SharedBlockBus phase

- **Aave / Morpho**: every registered interval (Aave default every block for hot path)
- **Comet**: phase `0` (e.g. blocks 5, 10, 15…)
- **Moonwell**: phase `2` (e.g. 2, 7, 12…) — staggered vs Comet to cut bursts

If a tick is still running, the next fire for that bot is skipped (`running` flag).

## Graded cooldowns

After a real attempt (not on peek):

| Class | Typical period | When |
| ----- | -------------- | ---- |
| `race` | ~15s | Competitor / HF recovered |
| `soft` | ~120s | Unprofitable / no route / soft sim fail |
| `hard` | config period (e.g. 1h) | Structural / unknown error |
| `success` | hard period | We liquidated |

Aave also drops race/success accounts from the **hot set** until HF is re-sampled.

## Logs to watch

| Marker | Meaning |
| ------ | ------- |
| `[RaceTick]` | Per full scan / liquidatable tick: accounts, hfScanMs |
| `[RaceSummary]` | Stage avgs (hfScan / pair / convert / simExec) + outcome counts |
| `[Route Timing]` | convert via cache/probe/fail |
| `Cooldown race\|soft\|hard\|success` | Graded arm |
| `Rate limited` / `429` | Need lower concurrency or more RPCs |
| `FULL history scan` | Missing checkpoint — run backfill |

## Comet note

`isLiquidatable(address)` returns a **single bool**. The bot ABI matches that; older wrong ABI `(bool,uint256)` would break multicall decode.

## Health endpoint

`GET /health` aggregates bot stats (registry size, liquidations attempted/succeeded, rpc error rate, optional `raceMetrics` snapshot for Aave).
