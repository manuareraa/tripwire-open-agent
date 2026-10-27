// Proving Ground stage 4, Backtest: how Tripwire's tripwires did on real SEC history.
// The scoring rules below were fixed before any result was looked at (docs/proving/BACKTEST.md, "Pre-registered rules").
// scripts/backtest.ts fetches the history and writes eval/backtest_results.json; trackRecord() reads it for the UI.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RISK_ITEMS, round, type MetricValue } from "../metrics.js";
import { isTripped, type TripwireDraft } from "../tripwires.js";
import type { Evidence, TrackRecord } from "../types.js";

// ---------- Pre-registered rules (do not change after results are known) ----------

/** 8-K items that count as real trouble: bankruptcy, debt acceleration, material impairment, auditor change, prior financials unreliable. */
export const TROUBLE_ITEMS = ["1.03", "2.04", "2.06", "4.01", "4.02"];
/** Item 5.02 (officer change) counts only when the filing reports the CEO or CFO leaving. */
export const OFFICER_ITEM = "5.02";
/** Covenant-level break: current ratio under 1.0, or liabilities over 3x equity (or equity zero or negative). */
export const COVENANT = { current_ratio_below: 1.0, liabilities_to_equity_above: 3.0 };
/** First as-of date; a new set of tripwires every STEP quarters; each set is watched for WINDOW quarters. */
export const FIRST_ASOF = "2021-03-31";
export const STEP_QUARTERS = 2;
export const WINDOW_QUARTERS = 2;
/** A firing is a false alarm when no trouble shows up in its quarter or the next FOLLOWUP_QUARTERS. */
export const FOLLOWUP_QUARTERS = 2;

const ROLE = /chief\s+executive\s+officer|chief\s+financial\s+officer|principal\s+executive\s+officer|principal\s+financial\s+officer|\bCEO\b|\bCFO\b/i;
const LEAVING = /resign|retire|step(?:s|ped|ping)?\s+down|depart|terminat|separat|will\s+not\s+(?:stand|continue)|leave\s+the\s+company/i;

/** Does the Item 5.02 section of an 8-K say the CEO or CFO is leaving? A plain text match, no model. */
export function ceoCfoDeparture(text: string): boolean {
  const flat = text.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;|&#xa0;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ");
  const at = flat.search(/item\s*5\.02/i);
  if (at < 0) return false;
  const rest = flat.slice(at + 9);
  const next = rest.search(/item\s*\d\.\d\d/i);
  const section = rest.slice(0, next > 0 ? Math.min(next, 6000) : 6000);
  // Both a role and a leaving word in the same sentence.
  return section.split(/(?<=[.;])\s+/).some((s) => ROLE.test(s) && LEAVING.test(s));
}

// ---------- History shapes (data/backtest/history.json) ----------

export interface Period {
  /** Balance-sheet date of the quarter. */
  end: string;
  /** Date the original filing with these numbers was filed: the day the numbers became known. */
  known: string;
  current_ratio: number | null;
  debt_to_equity: number | null;
  equity_nonpositive?: boolean;
  gross_margin: number | null;
  revenue: number | null;
  accession: string;
}

export interface Filing8K {
  filed: string;
  accession: string;
  items: string[];
  /** Set only for filings with item 5.02, from ceoCfoDeparture() on the filing text. */
  ceo_cfo_departure?: boolean;
  url: string;
}

export interface SupplierHistory {
  supplier_id: string;
  ticker: string;
  cik: string;
  category: string;
  periods: Period[];
  filings: Filing8K[];
}

/** Values held at today's sample (not reconstructed for the past): spend share, lead time, alternatives, sanctions. */
export interface HeldValues {
  spend_share?: number;
  lead_time_weeks?: number;
  category_alternatives?: number;
  sanctions_matches?: number;
}

// ---------- Quarters ----------

/** Quarter index: year * 4 + quarter (0-3). */
export const qIndex = (date: string) => {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return y * 4 + Math.floor((m - 1) / 3);
};
export const qLabel = (qi: number) => `${Math.floor(qi / 4)}Q${(qi % 4) + 1}`;
/** Last day of the quarter with index qi. */
export const qEnd = (qi: number) => {
  const y = Math.floor(qi / 4);
  return `${y}-${["03-31", "06-30", "09-30", "12-31"][qi % 4]}`;
};

/** As-of dates: FIRST_ASOF, then every STEP_QUARTERS, while the window plus follow-up has fully passed by `cutoff`. */
export function asOfDates(cutoff: string): string[] {
  const out: string[] = [];
  for (let qi = qIndex(FIRST_ASOF); qEnd(qi + WINDOW_QUARTERS + FOLLOWUP_QUARTERS) <= cutoff; qi += STEP_QUARTERS) out.push(qEnd(qi));
  return out;
}

// ---------- Trouble ----------

export interface TroubleEvent {
  date: string;
  quarter: string;
  kind: "8-K" | "covenant";
  detail: string;
  source: string;
}

export const inBreak = (p: Period) =>
  !!p.equity_nonpositive ||
  (p.current_ratio !== null && p.current_ratio < COVENANT.current_ratio_below) ||
  (p.debt_to_equity !== null && p.debt_to_equity > COVENANT.liabilities_to_equity_above);

/** Every trouble event in a supplier's history, by the date it became public. One event per 8-K; a covenant break counts when it starts. */
export function troubleEvents(h: SupplierHistory): TroubleEvent[] {
  const out: TroubleEvent[] = [];
  for (const f of h.filings) {
    const hits = f.items.filter((i) => TROUBLE_ITEMS.includes(i));
    if (f.items.includes(OFFICER_ITEM) && f.ceo_cfo_departure) hits.push(`${OFFICER_ITEM} (CEO/CFO leaving)`);
    if (hits.length) out.push({ date: f.filed, quarter: qLabel(qIndex(f.filed)), kind: "8-K", detail: `8-K item ${hits.join(", ")}`, source: f.url });
  }
  const periods = [...h.periods].sort((a, b) => a.end.localeCompare(b.end));
  for (let i = 1; i < periods.length; i++) {
    const p = periods[i];
    if (!inBreak(p) || inBreak(periods[i - 1])) continue;
    const why = p.equity_nonpositive ? "equity at or below zero"
      : p.current_ratio !== null && p.current_ratio < COVENANT.current_ratio_below ? `current ratio ${p.current_ratio}`
      : `liabilities to equity ${p.debt_to_equity}`;
    out.push({ date: p.known, quarter: qLabel(qIndex(p.known)), kind: "covenant", detail: `covenant-level break for period ${p.end}: ${why}`, source: p.accession });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Metrics as of a date (only what was filed by then) ----------

const BACKTEST_EVIDENCE: Evidence = { template_id: "backtest_history", params: {}, sql: "", table: "backtest_history", result_hash: "", depends_on: [] };

export function metricsAsOf(h: SupplierHistory, date: string, held: HeldValues): MetricValue[] {
  const out: MetricValue[] = [];
  const push = (metric: string, value: number | null | undefined) => {
    if (value !== null && value !== undefined && Number.isFinite(value)) out.push({ metric, value: round(value), evidence: BACKTEST_EVIDENCE });
  };
  const known = h.periods.filter((p) => p.known <= date).sort((a, b) => b.end.localeCompare(a.end));
  const latest = known[0];
  if (latest) {
    push("current_ratio", latest.current_ratio);
    push("debt_to_equity", latest.debt_to_equity);
    push("gross_margin", latest.gross_margin);
  }
  const hist = known.slice(0, 6).filter((p) => p.revenue !== null);
  if (hist.length >= 2 && hist[hist.length - 1].revenue) {
    const a = hist[0].revenue!;
    const b = hist[hist.length - 1].revenue!;
    push("revenue_change_pct", ((a - b) / Math.abs(b)) * 100);
  }
  push("spend_share", held.spend_share);
  push("lead_time_weeks", held.lead_time_weeks);
  const from = new Date(Date.parse(date) - 365 * 86_400_000).toISOString().slice(0, 10);
  push("risk_events_12m", h.filings.filter((f) => f.filed > from && f.filed <= date && f.items.some((i) => RISK_ITEMS.includes(i))).length);
  push("sanctions_matches", held.sanctions_matches);
  push("category_alternatives", held.category_alternatives);
  return out;
}

// ---------- Replaying one set of tripwires ----------

export interface Firing {
  date: string;
  quarter: string;
  metric: string;
  value: number;
  threshold?: number;
}

/** Step through every filing after `from` up to `to`; the first tripwire to cross its line reopens the decision. */
export function firstFiring(tripwires: TripwireDraft[], h: SupplierHistory, from: string, to: string, held: HeldValues): Firing | undefined {
  const dates = new Set<string>();
  for (const p of h.periods) if (p.known > from && p.known <= to) dates.add(p.known);
  for (const f of h.filings) if (f.filed > from && f.filed <= to) dates.add(f.filed);
  const start = new Map(metricsAsOf(h, from, held).map((m) => [m.metric, m.value]));
  for (const d of [...dates].sort()) {
    const now = new Map(metricsAsOf(h, d, held).map((m) => [m.metric, m.value]));
    for (const tw of tripwires) {
      const v = now.get(tw.metric);
      if (v === undefined) continue;
      if (isTripped({ op: tw.op, threshold: tw.threshold }, v, start.get(tw.metric))) {
        return { date: d, quarter: qLabel(qIndex(d)), metric: tw.metric, value: v, threshold: tw.threshold };
      }
    }
  }
  return undefined;
}

// ---------- Scoring an arm ----------

/** One decision replayed: the tripwires set for a supplier on an as-of date. */
export interface CaseTripwires {
  supplier_id: string;
  as_of: string;
  tripwires: TripwireDraft[];
}

export interface CaseResult extends CaseTripwires {
  window_end: string;
  firing?: Firing;
  false_alarm: boolean;
}

export interface EventResult extends TroubleEvent {
  supplier_id: string;
  as_of: string;
  caught_early: boolean;
  quarters_of_warning?: number;
  firing?: Firing;
}

export interface ArmTotals {
  decisions: number;
  trouble_events: number;
  trouble_8k: number;
  trouble_covenant: number;
  caught_early: number;
  caught_a_quarter_or_more_early: number;
  median_quarters_of_warning: number | null;
  firings: number;
  false_alarms: number;
}

export interface SupplierRow {
  supplier_id: string;
  ticker: string;
  trouble_events: number;
  caught_early: number;
  false_alarms: number;
  firings: number;
}

export interface ArmResult {
  arm: string;
  label: string;
  status: "measured" | "not run yet";
  note?: string;
  totals?: ArmTotals;
  suppliers?: SupplierRow[];
  events?: EventResult[];
  cases?: CaseResult[];
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Score one arm. Each trouble event is judged by the tripwire set in force when it became public
 * (the latest as-of date before it, within its window). Caught early = that set fired in the event's quarter or before.
 * Each set fires at most once (the decision reopens); a firing with no trouble in its quarter or the next two is a false alarm.
 */
export function scoreArm(arm: string, label: string, cases: CaseTripwires[], histories: SupplierHistory[], held: Record<string, HeldValues>): ArmResult {
  const bySupplier = new Map(histories.map((h) => [h.supplier_id, h]));
  const trouble = new Map(histories.map((h) => [h.supplier_id, troubleEvents(h)]));
  const caseResults: CaseResult[] = [];
  for (const c of cases) {
    const h = bySupplier.get(c.supplier_id);
    if (!h) continue;
    const window_end = qEnd(qIndex(c.as_of) + WINDOW_QUARTERS);
    const firing = firstFiring(c.tripwires, h, c.as_of, window_end, held[c.supplier_id] ?? {});
    let false_alarm = false;
    if (firing) {
      const fq = qIndex(firing.date);
      false_alarm = !(trouble.get(c.supplier_id) ?? []).some((e) => qIndex(e.date) >= fq && qIndex(e.date) <= fq + FOLLOWUP_QUARTERS);
    }
    caseResults.push({ ...c, window_end, firing, false_alarm });
  }
  const events: EventResult[] = [];
  for (const h of histories) {
    for (const e of trouble.get(h.supplier_id) ?? []) {
      const c = caseResults
        .filter((x) => x.supplier_id === h.supplier_id && x.as_of < e.date && e.date <= x.window_end)
        .sort((a, b) => b.as_of.localeCompare(a.as_of))[0];
      if (!c) continue; // outside every window: not scored
      const caught = !!c.firing && qIndex(c.firing.date) <= qIndex(e.date);
      events.push({
        ...e, supplier_id: h.supplier_id, as_of: c.as_of, caught_early: caught,
        ...(caught ? { quarters_of_warning: qIndex(e.date) - qIndex(c.firing!.date), firing: c.firing } : {}),
      });
    }
  }
  const caught = events.filter((e) => e.caught_early);
  const fired = caseResults.filter((c) => c.firing);
  const totals: ArmTotals = {
    decisions: caseResults.length,
    trouble_events: events.length,
    trouble_8k: events.filter((e) => e.kind === "8-K").length,
    trouble_covenant: events.filter((e) => e.kind === "covenant").length,
    caught_early: caught.length,
    caught_a_quarter_or_more_early: caught.filter((e) => (e.quarters_of_warning ?? 0) >= 1).length,
    median_quarters_of_warning: median(caught.map((e) => e.quarters_of_warning!)),
    firings: fired.length,
    false_alarms: fired.filter((c) => c.false_alarm).length,
  };
  const suppliers: SupplierRow[] = histories.map((h) => ({
    supplier_id: h.supplier_id,
    ticker: h.ticker,
    trouble_events: events.filter((e) => e.supplier_id === h.supplier_id).length,
    caught_early: caught.filter((e) => e.supplier_id === h.supplier_id).length,
    false_alarms: fired.filter((c) => c.supplier_id === h.supplier_id && c.false_alarm).length,
    firings: fired.filter((c) => c.supplier_id === h.supplier_id).length,
  }));
  return { arm, label, status: "measured", totals, suppliers, events, cases: caseResults };
}

// ---------- Track record for the UI ----------

export interface BacktestResults {
  window: string;
  arms: ArmResult[];
}

const RESULTS = join(fileURLToPath(new URL("../..", import.meta.url)), "eval/backtest_results.json");
let cache: { path: string; data: BacktestResults | null } | undefined;

function load(path: string): BacktestResults | null {
  if (cache?.path === path) return cache.data;
  let data: BacktestResults | null = null;
  try {
    if (existsSync(path)) data = JSON.parse(readFileSync(path, "utf8")) as BacktestResults;
  } catch {
    data = null;
  }
  cache = { path, data };
  return data;
}

/** Best measured arm: most trouble caught early, then fewest false alarms. Arms not run yet never count. */
export function bestArm(results: BacktestResults): ArmResult | undefined {
  return results.arms
    .filter((a) => a.status === "measured" && a.totals)
    .sort((a, b) => b.totals!.caught_early - a.totals!.caught_early || a.totals!.false_alarms - b.totals!.false_alarms)[0];
}

/** This supplier's record on real SEC history under the best measured arm, or undefined when there is no results file. */
export function trackRecord(subject_id: string, path = process.env.BACKTEST_RESULTS ?? RESULTS): TrackRecord | undefined {
  const results = load(path);
  if (!results) return undefined;
  const arm = bestArm(results);
  const row = arm?.suppliers?.find((r) => r.supplier_id === subject_id);
  if (!arm || !row) return undefined;
  const t = arm.totals!;
  return {
    window: results.window,
    trouble_events: row.trouble_events,
    caught_early: row.caught_early,
    false_alarms: row.false_alarms,
    note: `${arm.label}. Across all ${arm.suppliers!.length} suppliers: caught ${t.caught_early} of ${t.trouble_events} trouble events early, ${t.false_alarms} false alarms.`,
  };
}
