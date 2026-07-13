/**
 * Lightweight race-path metrics for liquidation bots.
 * Aggregates stage timings + outcome counts, flushes a one-line summary periodically
 * so operators can see where time goes (HF scan vs pair vs convert vs sim/exec)
 * and why attempts fail (race / no_route / profit / hard).
 */

export type RaceOutcome =
  | "success"
  | "skip_cooldown"
  | "skip_no_pair"
  | "skip_blacklist"
  | "skip_bad_debt"
  | "skip_no_route"
  | "fail_soft_profit"
  | "fail_race"
  | "fail_hard"
  | "fail_error";

export type RaceStage = "hfScan" | "pair" | "convert" | "simExec" | "totalLiq";

const EMPTY_STAGES: Record<RaceStage, { sum: number; n: number; max: number }> = {
  hfScan: { sum: 0, n: 0, max: 0 },
  pair: { sum: 0, n: 0, max: 0 },
  convert: { sum: 0, n: 0, max: 0 },
  simExec: { sum: 0, n: 0, max: 0 },
  totalLiq: { sum: 0, n: 0, max: 0 },
};

function avg(sum: number, n: number): number {
  return n === 0 ? 0 : Math.round(sum / n);
}

export class RaceMetrics {
  private outcomes = new Map<RaceOutcome, number>();
  private stages: Record<RaceStage, { sum: number; n: number; max: number }> = {
    hfScan: { sum: 0, n: 0, max: 0 },
    pair: { sum: 0, n: 0, max: 0 },
    convert: { sum: 0, n: 0, max: 0 },
    simExec: { sum: 0, n: 0, max: 0 },
    totalLiq: { sum: 0, n: 0, max: 0 },
  };
  private convertCacheHits = 0;
  private convertCacheMisses = 0;
  private ticks = 0;
  private liquidatableFound = 0;
  private readonly flushEveryTicks: number;

  constructor(flushEveryTicks = 20) {
    this.flushEveryTicks = Math.max(1, flushEveryTicks);
  }

  recordOutcome(outcome: RaceOutcome): void {
    this.outcomes.set(outcome, (this.outcomes.get(outcome) ?? 0) + 1);
  }

  recordStage(stage: RaceStage, ms: number): void {
    const s = this.stages[stage];
    s.sum += ms;
    s.n += 1;
    if (ms > s.max) s.max = ms;
  }

  recordConvert(ms: number, via: "same" | "cache" | "probe" | "fail"): void {
    this.recordStage("convert", ms);
    if (via === "cache") this.convertCacheHits += 1;
    else if (via === "probe") this.convertCacheMisses += 1;
  }

  /** Call once per poll tick (hot or full). Optionally force summary flush. */
  onTick(opts?: {
    logTag?: string;
    mode?: "hot" | "full";
    accounts?: number;
    hot?: number;
    liquidatable?: number;
    hfScanMs?: number;
    forceSummary?: boolean;
  }): void {
    this.ticks += 1;
    if (opts?.liquidatable !== undefined) this.liquidatableFound += opts.liquidatable;
    if (opts?.hfScanMs !== undefined) this.recordStage("hfScan", opts.hfScanMs);

    if (opts?.logTag && opts.mode && opts.accounts !== undefined) {
      // Per-tick one-liner when we found targets, or full scans
      if ((opts.liquidatable ?? 0) > 0 || opts.mode === "full" || opts.forceSummary) {
        console.log(
          `${opts.logTag}[RaceTick] mode=${opts.mode} accounts=${opts.accounts} ` +
            `hot=${opts.hot ?? "?"} liq=${opts.liquidatable ?? 0} hfScanMs=${opts.hfScanMs ?? "?"}`,
        );
      }
    }

    if (opts?.forceSummary || this.ticks % this.flushEveryTicks === 0) {
      this.flushSummary(opts?.logTag ?? "[RaceMetrics] ");
    }
  }

  flushSummary(logTag: string): void {
    const o = [...this.outcomes.entries()]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(" ");

    const st = (name: RaceStage) => {
      const s = this.stages[name];
      return `${name}:{avg=${avg(s.sum, s.n)} max=${s.max} n=${s.n}}`;
    };

    const cacheTotal = this.convertCacheHits + this.convertCacheMisses;
    const cachePct =
      cacheTotal === 0 ? "n/a" : `${Math.round((100 * this.convertCacheHits) / cacheTotal)}%`;

    console.log(
      `${logTag}[RaceSummary] ticks=${this.ticks} liquidatableSeen=${this.liquidatableFound} ` +
        `convertCacheHit=${cachePct} (${this.convertCacheHits}/${cacheTotal}) | ` +
        `${st("hfScan")} ${st("pair")} ${st("convert")} ${st("simExec")} ${st("totalLiq")} | ` +
        `outcomes: ${o || "(none)"}`,
    );

    // Hint which stage dominates when we have enough samples
    const samples = (["hfScan", "pair", "convert", "simExec"] as RaceStage[])
      .map((k) => ({ k, avg: avg(this.stages[k].sum, this.stages[k].n), n: this.stages[k].n }))
      .filter((x) => x.n >= 3);
    if (samples.length > 0) {
      samples.sort((a, b) => b.avg - a.avg);
      const top = samples[0]!;
      let hint = "";
      if (top.k === "hfScan" && top.avg > 500) {
        hint = "HINT: HF scan dominates → consider tighter hot set / more RPC concurrency";
      } else if (top.k === "pair" && top.avg > 300) {
        hint = "HINT: pair select dominates → reserve multicall / fewer reserves";
      } else if (top.k === "convert" && top.avg > 400) {
        hint = "HINT: DEX convert dominates → warm cache / local venues / fewer aggregators";
      } else if (top.k === "simExec" && top.avg > 800) {
        hint = "HINT: sim+exec dominates → private RPC / tip / fewer flash fallbacks";
      }
      const race = this.outcomes.get("fail_race") ?? 0;
      const noRoute = this.outcomes.get("skip_no_route") ?? 0;
      const profit = this.outcomes.get("fail_soft_profit") ?? 0;
      const attempts =
        race +
        noRoute +
        profit +
        (this.outcomes.get("success") ?? 0) +
        (this.outcomes.get("fail_hard") ?? 0) +
        (this.outcomes.get("fail_error") ?? 0);
      if (attempts >= 5 && race / attempts > 0.4) {
        hint =
          (hint ? hint + " | " : "") +
          "HINT: many race fails → need faster detect/submit (event watch / private tip)";
      }
      if (hint) console.log(`${logTag}[RaceSummary] ${hint}`);
    }
  }

  /** Snapshot for health endpoint (optional). */
  snapshot() {
    return {
      ticks: this.ticks,
      liquidatableFound: this.liquidatableFound,
      outcomes: Object.fromEntries(this.outcomes),
      stages: Object.fromEntries(
        Object.entries(this.stages).map(([k, v]) => [
          k,
          { avgMs: avg(v.sum, v.n), maxMs: v.max, n: v.n },
        ]),
      ),
      convertCacheHits: this.convertCacheHits,
      convertCacheMisses: this.convertCacheMisses,
    };
  }

  reset(): void {
    this.outcomes.clear();
    this.stages = structuredClone(EMPTY_STAGES);
    this.convertCacheHits = 0;
    this.convertCacheMisses = 0;
    this.ticks = 0;
    this.liquidatableFound = 0;
  }
}

export function nowMs(): number {
  return Date.now();
}

export function elapsedMs(start: number): number {
  return Date.now() - start;
}
