# P0 Fix Plan — Liquidation Bot Logic Audit

**Status:** P0 implemented (2026-07-14)  
**Source:** Full logic review (4-auditor team, prompt-engineering-patterns)  
**Goal:** Unblock end-to-end liquidation paths so protocols are not systematically broken.

## Fix Team (Role + CoT + Structured Output)

| Role | Pattern | Scope | P0s |
|------|---------|-------|-----|
| Venue Engineer | Role + fail-closed + Verification | Aerodrome convert / hop fallthrough | P0-1 |
| Aave Protocol Engineer | Role + CoT checklist + FILE:LINE | pair selector + event ABI | P0-2, P0-3 |
| Comet Engineer | Role + Cross-protocol (fork vs prod) | debt estimation ABI | P0-4 |
| Morpho Fast-Path Engineer | Role + event fidelity + resync | webhook Liquidate + cache | P0-5 |
| Integration Verifier | Role + Verification checklist §7 | unit/build + smoke | all |

Each fix must produce:
```
issue_id | files_changed | root_cause | fix_summary | tests | residual_risk | status: FIXED|PARTIAL|BLOCKED
```

## Order (min blast radius)

1. **P0-1 Aerodrome** — system-wide venue dead-end on Base  
2. **P0-2 Aave pair** — entire Aave path blocked at pair selection  
3. **P0-3 Aave events** — incremental discovery ABI  
4. **P0-4 Comet debt** — flash amount systematic error  
5. **P0-5 Morpho Liquidate** — husk / race-lost from bad event filter  

P1 (webhook cooldown, RF filter, receipt success, etc.) is **out of scope** for this pass unless zero-cost.

## Acceptance (from audit §7)

| # | Check | Pass criteria |
|---|-------|---------------|
| 1 | Aerodrome pair | amountOut>0 encoded OR convert fails and hop continues (not swap 0,0 success) |
| 2 | Aave pair | selectBestLiquidationPair uses Pool-valid views; non-null when positions exist |
| 3 | Aave events | Supply/Borrow topic/indexed match IPool (≤3 indexed) |
| 4 | Comet debt | estimateDebt ≈ borrowBalanceOf (or correct totalsBasic index) |
| 5 | Morpho Liquidate | topic0 matches morphoBlue.ts; decode borrower; resync not hard-delete only |

## Implementation notes

### P0-1 Aerodrome
- Add `getAmountOut(uint256,address)` to pool ABI  
- `convert`: compute amountOut; if 0 return unchanged `toConvert` (tryVenueConvert treats as skip)  
- Encode `amount0Out` / `amount1Out` based on token0 direction  

### P0-2 Aave pair
- Pool has no `getUserReserveData` / `getReserveConfigurationMap`  
- Use `getReserveData` → aToken / variableDebt / stableDebt + config bitmap  
- `balanceOf` multicall; decode LTV/LT/bonus/decimals/active/frozen from config  
- Optional: `getUserConfiguration` for collateral-enabled bit (or treat aToken>0 as candidate if usage bit unavailable)  

### P0-3 Aave events
- Official IPool: Supply `user` non-indexed; max 3 indexed  
- Borrow: `user` + `interestRateMode` + `borrowRate` non-indexed; `referralCode` indexed  

### P0-4 Comet
- Prefer `borrowBalanceOf(account)`  
- Fix `totalsBasic` ABI order to official 8 fields as fallback  

### P0-5 Morpho
- Signature: 5×uint256 non-indexed after id/caller/borrower  
- Decode `borrower` as user  
- Liquidate: remove stale cache entry + add market to affectedMarkets for chain resync  

---

## Fix Team Results (structured)

| issue_id | files_changed | root_cause | fix_summary | tests | residual_risk | status |
|----------|---------------|------------|-------------|-------|---------------|--------|
| P0-1 | `aerodrome/index.ts`, `abis/aerodrome.ts` | swap(0,0) returned success | getAmountOut → amount0/1Out; amountOut==0 fail-closed | aerodrome.unit + p0Fixes | live fork convert not re-run | FIXED |
| P0-2 | `AaveV3.ts`, `aaveAssetPairSelector.ts`, `aaveBot.ts` | called Pool for DataProvider views | ProtocolDataProvider + correct config field order | p0Fixes unit | need fork selectBestLiquidationPair | FIXED |
| P0-3 | `AaveV3.ts` aaveEventAbi | wrong indexed flags | align IPool Supply/Borrow/Repay | p0Fixes unit | historical logs with old decode already skipped | FIXED |
| P0-4 | `Comet.ts`, `cometBot.ts` | totalsBasic field order wrong | borrowBalanceOf primary; ABI 8-field fallback | p0Fixes unit | — | FIXED |
| P0-5 | `webhook.ts`, `bot.ts` | Liquidate sig missing badDebt* | 5×uint + caller/borrower; resync via affectedMarkets | p0Fixes + allBots 6.5 | P1 cooldown still drops bursts | FIXED |

### Verification run (local)

- `pnpm --filter @morpho-blue-liquidation-bot/client typecheck` ✅  
- `vitest` p0Fixes.unit + aerodrome.unit + aaveBot.test ✅ (42 tests)  
- On-chain smoke: Base ProtocolDataProvider + Comet totalsBasic 8-tuple + Liquidate topic0 ✅  

### P1 completed (2026-07-14)

| issue | fix |
|-------|-----|
| Webhook cooldown drops whole batch | Always `handleEvents`; `attemptLiquidation=false` under cooldown |
| Success = hash only | `waitForTransactionReceipt` before true (Flashbots still tentative) |
| Moonwell RF≥99% discovery filter | Keep all markets in watchlist; profit gate at attempt |

### Still out of scope

- Morpho fast path coveredMarkets gate  
- Provider error ≠ empty array health  
- Full E2E fork suite §7 items beyond P0  
