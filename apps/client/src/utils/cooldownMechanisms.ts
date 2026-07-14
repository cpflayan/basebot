import { Address, Hex } from "viem";

/**
 * Graded cooldown after liquidation attempts.
 *
 * - race:  someone else liquidated / HF recovered — short retry window
 * - soft:  unprofitable / route/slippage — medium
 * - hard:  structural or unknown failure — long (default 1h)
 * - success: we liquidated — long (avoid re-hitting empty husk)
 */
export type CooldownClass = "race" | "soft" | "hard" | "success";

export interface CooldownPeriods {
  /** Default / hard / success period (seconds). */
  hard: number;
  /** Race-lost period (seconds). Default 15. */
  race: number;
  /** Soft business failure (seconds). Default 120. */
  soft: number;
}

const DEFAULT_RACE_SECONDS = 15;
const DEFAULT_SOFT_SECONDS = 120;

/** Target no longer liquidatable — competitor or price recovered. */
const RACE_LOST_PATTERNS: readonly RegExp[] = [
  /position is healthy/i, // Morpho Blue
  /health factor.*not below/i, // Aave V3
  /HEALTH_FACTOR_NOT_BELOW_THRESHOLD/i,
  /\b51\b/, // Aave V3 error code 51
  /not.?liquidatable/i, // Comet
  /insufficient shortfall/i, // Moonwell / CToken
  /collateral cannot be liquidated/i, // Aave
  /already.?liquidat/i,
  /no debt/i,
  /user has no.*debt/i,
  /zero debt/i,
  /must be liquidatable/i,
];

/** Business / venue failures that may clear soon. */
const SOFT_FAIL_PATTERNS: readonly RegExp[] = [
  /profit/i,
  /slippage/i,
  /too little received/i,
  /insufficient.*output/i,
  /insufficient.*liquidity/i,
  /STF\b/i,
  /TRANSFER_FROM_FAILED/i,
  /below threshold/i,
  /not profitable/i,
  /Simulation failed/i,
  /LIQUIDATE_SEIZE_TOO_MUCH/i, // Moonwell: repay > seizable collateral — amount drift
  /BAL#528/i, // Balancer flash liquidity
  // Empty revert / empty return — usually transient, not structural hard lock
  /returned no data/i,
  /empty revert/i,
  /all borrow positions exhausted/i, // Moonwell exhaust without structural error
  // Structured SimExecResult reasons (logs / armCooldown detail)
  /\bsim_fail\b/i,
  /\bprofit_fail\b/i,
  /\bslippage_fail\b/i,
  /\bexec_revert\b/i,
  /\bproviders_exhausted\b/i,
];

export function classifyLiquidationFailure(error: unknown): CooldownClass {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error == null
          ? ""
          : JSON.stringify(error);
  if (RACE_LOST_PATTERNS.some((p) => p.test(message))) return "race";
  if (SOFT_FAIL_PATTERNS.some((p) => p.test(message))) return "soft";
  return "hard";
}

export function isRaceLostFailure(error: unknown): boolean {
  return classifyLiquidationFailure(error) === "race";
}

export class PositionLiquidationCooldownMechanism {
  private periods: CooldownPeriods;
  private positionReadyAt: Record<Hex, Record<Address, number>>;

  constructor(hardPeriodSeconds: number, periods?: Partial<Omit<CooldownPeriods, "hard">>) {
    this.periods = {
      hard: hardPeriodSeconds,
      race: periods?.race ?? DEFAULT_RACE_SECONDS,
      soft: periods?.soft ?? DEFAULT_SOFT_SECONDS,
    };
    this.positionReadyAt = {};
  }

  get cooldownPeriod(): number {
    return this.periods.hard;
  }

  /** Legacy Morpho/Comet/Moonwell: peek + arm hard cooldown in one call. */
  isPositionReady(marketId: Hex, account: Address) {
    const mid = marketId.toLowerCase() as Hex;
    if (this.isCoolingDown(mid, account)) {
      return false;
    }
    this.markAttempted(mid, account, "hard");
    return true;
  }

  /** Peek only — does not arm the timer. */
  isCoolingDown(marketId: Hex, account: Address): boolean {
    const byMarket = this.positionReadyAt[marketId.toLowerCase() as Hex];
    if (!byMarket) return false;
    const readyAt = byMarket[account.toLowerCase() as Address];
    if (readyAt === undefined) return false;
    return readyAt > Math.floor(Date.now() / 1000);
  }

  /**
   * Arm cooldown. Prefer `markClass` for race-sensitive bots.
   * @param classOrSeconds CooldownClass or explicit seconds
   */
  markAttempted(
    marketId: Hex,
    account: Address,
    classOrSeconds: CooldownClass | number = "hard",
  ): void {
    const mid = marketId.toLowerCase() as Hex;
    const addr = account.toLowerCase() as Address;
    const seconds =
      typeof classOrSeconds === "number" ? classOrSeconds : this.secondsForClass(classOrSeconds);

    if (this.positionReadyAt[mid] === undefined) {
      this.positionReadyAt[mid] = {};
    }
    this.positionReadyAt[mid][addr] = Math.floor(Date.now() / 1000) + Math.max(0, seconds);
  }

  markClass(marketId: Hex, account: Address, cls: CooldownClass): number {
    this.markAttempted(marketId.toLowerCase() as Hex, account, cls);
    return this.secondsForClass(cls);
  }

  secondsForClass(cls: CooldownClass): number {
    switch (cls) {
      case "race":
        return this.periods.race;
      case "soft":
        return this.periods.soft;
      case "success":
      case "hard":
      default:
        return this.periods.hard;
    }
  }

  /** Seconds remaining, or 0 if ready. */
  remainingSeconds(marketId: Hex, account: Address): number {
    const readyAt =
      this.positionReadyAt[marketId.toLowerCase() as Hex]?.[account.toLowerCase() as Address];
    if (readyAt === undefined) return 0;
    return Math.max(0, readyAt - Math.floor(Date.now() / 1000));
  }
}

export class MarketsFetchingCooldownMechanism {
  private cooldownPeriod: number;
  private readyAt: number;

  constructor(cooldownPeriod: number) {
    this.cooldownPeriod = cooldownPeriod;
    this.readyAt = 0;
  }

  isFetchingReady() {
    if (this.readyAt > Math.floor(Date.now() / 1000)) {
      return false;
    }
    this.readyAt = Math.floor(Date.now() / 1000) + this.cooldownPeriod;
    return true;
  }
}
