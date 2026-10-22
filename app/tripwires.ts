// Tripwires are proposed by the Decider but checked and evaluated here, in code.
import { METRIC_NAMES, metricDef, round, type MetricValue } from "./metrics.js";
import type { Tripwire } from "./types.js";

export interface TripwireDraft {
  metric: string;
  op: "<" | ">" | "changed";
  threshold?: number;
}

export function isTripped(tw: Pick<Tripwire, "op" | "threshold">, value: number, previous?: number): boolean {
  if (tw.op === "changed") return previous !== undefined && previous !== value;
  if (tw.threshold === undefined) return false;
  return tw.op === "<" ? value < tw.threshold : value > tw.threshold;
}

/** Problems with a drafted tripwire set; empty means it passes review. */
export function reviewTripwires(drafts: TripwireDraft[], metrics: MetricValue[]): string[] {
  const issues: string[] = [];
  if (drafts.length < 2 || drafts.length > 4) issues.push(`need 2-4 tripwires, got ${drafts.length}`);
  const values = new Map(metrics.map((m) => [m.metric, m.value]));
  for (const d of drafts) {
    if (!METRIC_NAMES.includes(d.metric)) { issues.push(`unknown metric "${d.metric}"`); continue; }
    if (!values.has(d.metric)) { issues.push(`no data for metric "${d.metric}"`); continue; }
    if (d.op !== "changed" && typeof d.threshold !== "number") { issues.push(`${d.metric}: threshold must be a number`); continue; }
    if (d.op !== "changed" && isTripped(d, values.get(d.metric)!)) {
      issues.push(`${d.metric} ${d.op} ${d.threshold} is already true today (value ${values.get(d.metric)}), so it cannot act as a future trigger`);
    }
  }
  return issues;
}

/** Attach ids and row dependencies from the evidence behind each metric. */
export function compileTripwires(decisionId: string, drafts: TripwireDraft[], metrics: MetricValue[]): Tripwire[] {
  const byMetric = new Map(metrics.map((m) => [m.metric, m]));
  return drafts.map((d, i) => ({
    id: `${decisionId}-tw${i + 1}`,
    metric: d.metric,
    op: d.op,
    threshold: d.threshold === undefined ? undefined : round(d.threshold),
    depends_on: byMetric.get(d.metric)?.evidence.depends_on ?? [],
  }));
}

/** Rule-based tripwires: a margin past today's value in the risky direction. Always passes review. */
export function defaultTripwires(metrics: MetricValue[]): TripwireDraft[] {
  const prefer = ["current_ratio", "debt_to_equity", "spend_share", "revenue_change_pct", "gross_margin", "category_alternatives"];
  const out: TripwireDraft[] = [];
  for (const name of prefer) {
    const m = metrics.find((x) => x.metric === name);
    const def = metricDef(name);
    if (!m || !def) continue;
    const v = m.value;
    let threshold: number;
    switch (name) {
      case "current_ratio": threshold = v >= 1.1 ? 1.0 : v * 0.85; break;
      case "debt_to_equity": threshold = Math.max(3.0, v * 1.2); break;
      case "spend_share": threshold = Math.min(1, v + 0.1); break;
      case "revenue_change_pct": threshold = Math.min(-10, v - 10); break;
      case "gross_margin": threshold = v * 0.8; break;
      case "category_alternatives": if (v < 1) continue; threshold = 1; break;
      default: continue;
    }
    out.push({ metric: name, op: def.worseWhen === "lower" ? "<" : ">", threshold: round(threshold) });
    if (out.length === 3) break;
  }
  return out;
}
