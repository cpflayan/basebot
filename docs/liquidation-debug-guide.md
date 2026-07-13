# Liquidation Debug Log Guide

## Overview

All protocol bots emit structured decision logs and periodic race metrics so you can verify *why* a position was attempted or skipped, and where time is spent.

## Decision log (`logLiquidationDebug`)

Emitted for skip/liquidate decisions across Morpho, Comet, Moonwell, and Aave.

### Fields

1. **Account** — address  
2. **Health factor** (when available) — color-coded in console (🔴 &lt;1.0, 🟡 1.0–1.1, 🟢 &gt;1.1)  
3. **Collateral / debt** — token + amount when known  
4. **Decision** — `LIQUIDATE` or `SKIP`  
5. **Reason** — human-readable cause  
6. **Details** — market id, blacklist flags, cooldown, flash loan flag, etc.

### Common SKIP reasons

| Reason | Notes |
| ------ | ----- |
| Position is in cooldown period | Graded cooldown still active (peek only — does not re-arm) |
| Simulation failure cooldown | Moonwell: repeated sim failures (separate map) |
| No profitable liquidation pair | Aave: no (collateral, debt) with positive estimate |
| Blacklisted token | `TOKEN_BLACKLIST` / config blacklist |
| Bad debt position | Underwater and `alwaysRealizeBadDebt` disabled |
| No DEX route | Convert failed; soft cooldown / try next market |

## Race metrics

Implemented in `apps/client/src/utils/raceMetrics.ts`. Each bot flushes approximately every 20 ticks.

### `[RaceTick]`

```
[Base aave][RaceTick] mode=hot accounts=42 hot=12 liq=1 hfScanMs=180
```

- `mode=hot|full` — Aave hot set vs full registry  
- `hfScanMs` — multicall health/shortfall scan wall time  

### `[RaceSummary]`

```
[Base aave][RaceSummary] ticks=20 liquidatableSeen=3 convertCacheHit=80% ...
  hfScan:{avg=… max=… n=…} pair:{…} convert:{…} simExec:{…} |
  outcomes: fail_race=2 success=1 skip_cooldown=5 ...
```

| Stage | What it measures |
| ----- | ---------------- |
| `hfScan` | Batch HF / isLiquidatable / shortfall multicall |
| `pair` | Aave pair selection (etc.) |
| `convert` | DEX route build (local first, then aggregators) |
| `simExec` | simulateCalls + send |

| Outcome | Meaning |
| ------- | ------- |
| `success` | Tx path returned success |
| `fail_race` | Position no longer liquidatable |
| `fail_soft_profit` | Sim soft-fail / not profitable |
| `fail_hard` | Structural / unknown |
| `skip_no_route` | No venue path |
| `skip_cooldown` / `skip_blacklist` / `skip_bad_debt` / `skip_no_pair` | Pre-exec filters |

Hints after enough samples (e.g. HF scan dominates → tighten hot set / raise concurrency carefully).

## Where logs go

| Sink | Path |
| ---- | ---- |
| Console | Colorized by protocol tag |
| File | `logs/bot.log` (ANSI stripped) |

`logs/` is gitignored.

## When to use this

1. After webhook Morpho events — did we liquidate or skip?  
2. High 429 rate — check `hfScan` avg + concurrency env  
3. Many `fail_race` — detection/submit latency (need faster tip / event watch)  
4. Many `skip_no_route` — warm cache / venue list / pair selection  

## Related

- [docs/operations.md](./operations.md) — env knobs for RPC budget  
- [ARCHITECTURE.md](../ARCHITECTURE.md) — protocol flows  
