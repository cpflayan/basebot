# Liquidation Debug Log Guide

## Overview

The bot now includes comprehensive debug logging for all liquidation decisions. This helps verify that the liquidation logic is making correct decisions.

## What Gets Logged

### For Every Liquidation Check:

1. **Account Information**
   - Account address
   - Health Factor (color-coded: 🔴 <1.0, 🟡 1.0-1.1, 🟢 >1.1)

2. **Position Details**
   - Collateral token and amount
   - Debt token and amount
   - Seizable collateral amount
   - Bad debt status (underwater position)

3. **Decision & Reason**
   - `LIQUIDATE` or `SKIP`
   - Detailed reason for the decision
   - Additional context (market ID, blacklist status, cooldown, etc.)

## Decision Reasons

### SKIP Reasons:

- **No profitable liquidation pair found** — Could not find collateral/debt pair with positive expected profit
- **Blacklisted token in liquidation pair** — Token is in TOKEN_BLACKLIST
- **Position is in cooldown period** — Recently attempted liquidation, waiting before retry
- **Bad debt position** — Position is underwater (collateral < debt) and `alwaysRealizeBadDebt` is disabled
- **Blacklisted token in market** — Market involves blacklisted tokens

### LIQUIDATE Reasons:

- **Best pair selected** — Found profitable collateral/debt pair, proceeding with liquidation
- **Position evaluation in progress** — Initial check passed, continuing evaluation

## Example Output

```
================================================================================
[Base client Liquidation Debug] ⏭️ SKIP
================================================================================
Account: 0x1234...5678
Health Factor: 🔴 0.850000

Collateral:
  Token: 0xABC...DEF
  Amount: 1000000000000000000

Debt:
  Token: 0x123...789
  Amount: 500000000

Seizable Collateral: 1000000000000000000
Bad Debt: ⚠️ YES (underwater)

Decision: SKIP
Reason: Bad debt position (collateral fully seizable, no liquidation bonus)

Details:
  marketId: 0xMARKET...ID
  alwaysRealizeBadDebt: false
  note: Position is underwater and bot is configured to skip bad debt
================================================================================
```

## Configuration

The debug logger is always enabled and logs to stdout. No additional configuration needed.

## When to Check Debug Logs

1. **After webhook events** — See why the bot did or didn't liquidate after receiving Morpho events
2. **During periodic scans** — Verify Aave/Comet/Moonwell liquidation decisions
3. **When troubleshooting** — Understand why a position wasn't liquidated
4. **Before deploying changes** — Verify liquidation logic is working correctly

## Files Modified

- `apps/client/src/utils/liquidationDebug.ts` — Debug logger implementation
- `apps/client/src/aaveBot.ts` — Aave liquidation debug logging
- `apps/client/src/bot.ts` — Morpho liquidation debug logging

## Future Enhancements

- Add USD value estimates for collateral/debt
- Log expected profit calculation details
- Add simulation results
- Track liquidation success/failure rates
