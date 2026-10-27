// Proving Ground stage 3, Crash-test: for each candidate tripwire, Lightning re-decides with that one number pushed
// just past the line and, as a control, just short of it. A tripwire is only worth keeping if crossing it changes the call.
//   verified    holds short of the line, changes past it        → kept
//   decorative  still holds past the line                        → dropped (crossing it would not change the call)
//   mis_set     already changes short of the line                → one reset (line moved halfway to today), else dropped
//   untested    no model, no recording, no number, op "changed"  → kept as proposed, with the reason
// "Changes the call" means the re-decision names a different decision kind. For an exit, a supplier getting worse only
// confirms the exit, so lines in the worse direction come out decorative; see docs/proving/CRASH.md.
// Owner: the "crash-test" stream. Returns the final tripwire drafts (each with crash_test set) and fills s.proving.crash.
import { extractJson } from "../adapters/model.js";
import { metricDef, round, type MetricDef } from "../metrics.js";
import { isTripped, type TripwireDraft } from "../tripwires.js";
import { callModel, type DecisionDraft, type Deps, type RunState } from "../orchestration/state.js";
import type { CrashTest, DecisionKind } from "../types.js";

const AGENT = "CrashTester";
const KINDS: DecisionKind[] = ["keep", "dual_source", "exit"];

/** What one re-decision said, with the re-decider's one plain sentence on why. */
export interface Redecision { decision: DecisionKind; why: string }
/** Re-decide with one metric moved to `value`. Returns a reason string when no answer could be had. */
export type Redecider = (decision: DecisionKind, today: Map<string, number>, metric: string, value: number) => Promise<Redecision | string>;

/** The smallest move that means something, per unit. */
export const STEP: Record<MetricDef["unit"], number> = { ratio: 0.05, share: 0.01, pct: 1, weeks: 1, count: 1 };

/** The value just past the line and just short of it, or a reason the line cannot be pushed. */
export function probeValues(metric: string, op: "<" | ">", t: number): { past: number; short: number } | string {
  const def = metricDef(metric);
  if (!def) return `unknown metric "${metric}"`;
  const step = STEP[def.unit];
  let past: number, short: number;
  if (def.unit === "count") {
    past = op === ">" ? Math.floor(t) + 1 : Math.ceil(t) - 1;
    short = op === ">" ? Math.floor(t) : Math.ceil(t);
  } else {
    past = op === ">" ? t + step : t - step;
    short = op === ">" ? t - step : t + step;
  }
  const clamp = (v: number) => (def.unit === "share" ? Math.min(1, Math.max(0, v)) : def.unit === "pct" ? v : Math.max(0, v));
  past = round(clamp(past));
  short = round(clamp(short));
  if (!isTripped({ op, threshold: t }, past)) return `the line ${op} ${t} cannot be crossed (${words(metric)} cannot go ${op === ">" ? "above" : "below"} it)`;
  if (isTripped({ op, threshold: t }, short)) return `no value short of the line ${op} ${t}`;
  return { past, short };
}

const words = (metric: string) => metric.replace(/_/g, " ");
const describe = (c: Pick<TripwireDraft, "metric" | "op" | "threshold">) => `${words(c.metric)} ${c.op} ${c.threshold ?? ""}`.trim();

/** The re-decision prompt. Deterministic: only the decision, today's numbers and the one moved number. */
export function redecidePrompt(decision: DecisionKind, today: Map<string, number>, metric: string, value: number) {
  const names = [...today.keys()].sort();
  const meanings = names.map((n) => metricDef(n)).filter((d): d is MetricDef => !!d).map((d) => `${d.name} (${d.label}; worse when ${d.worseWhen})`);
  return {
    system:
      "You re-check a supplier decision when one number moves. The buyer chose keep (stay with the supplier), " +
      "dual_source (add a second supplier) or exit (move the work to another supplier). Judge only from the numbers given. " +
      'Reply only with JSON: {"decision": "keep|dual_source|exit", "still_holds": true or false, "why": "one plain sentence"}',
    user:
      `We decided ${decision} for this supplier on these numbers:\n${names.map((n) => `- ${n} = ${today.get(n)}`).join("\n")}\n` +
      `Metric meanings: ${meanings.join("; ")}\n` +
      `Now one number moves: ${metric} is ${value} instead of ${today.get(metric)}. Every other number stays the same.\n` +
      "Does the decision still hold? If not, which decision fits now?",
  };
}

/** Lightning re-decides, through callModel so the call is traced, counted and recorded. */
export function modelRedecider(deps: Deps, s: RunState): Redecider {
  return async (decision, today, metric, value) => {
    if (deps.model.enabled === false) return "no model and no recorded answer (rules-only run)";
    const res = await callModel(deps, s, { tier: "small", agent_name: AGENT, json: true, max_tokens: 300, ...redecidePrompt(decision, today, metric, value) });
    if (res.fallback) return `no model answered (${res.error ?? "unavailable"})`;
    const p = extractJson<Record<string, unknown>>(res.text);
    const kind = String(p?.decision ?? "").toLowerCase().replace(/[\s-]/g, "_") as DecisionKind;
    const why = String(p?.why ?? "").trim();
    if (KINDS.includes(kind)) return { decision: kind, why };
    // No decision kind in the reply: trust a plain "still holds", never guess which way it changed.
    if (p && p.still_holds === true) return { decision, why };
    return "the model's reply named no decision";
  };
}

interface Probe { verdict: CrashTest["verdict"]; test: CrashTest }

/**
 * The crash test with a pluggable re-decider: the graph uses Lightning; the eval also runs a rules-only re-decider as a
 * labelled control. Answers are cached by (metric, value), so two candidates on the same number share one call.
 */
export async function runCrash(deps: Deps, s: RunState, draft: DecisionDraft, candidates: TripwireDraft[], redecide: Redecider): Promise<TripwireDraft[]> {
  const today = new Map(s.metrics.map((m) => [m.metric, m.value]));
  const orig = draft.decision;
  const cache = new Map<string, Promise<Redecision | string>>();
  const ask = (metric: string, value: number) => {
    const k = `${metric}=${value}`;
    if (!cache.has(k)) cache.set(k, redecide(orig, today, metric, value));
    return cache.get(k)!;
  };
  const emit = (summary: string, status: "success" | "needs_revision" | "partial", data: unknown) =>
    deps.tracer.emit({ decision_id: s.decision_id, agent_name: AGENT, action: "crash_test", event: "critique", status, output_summary: summary, data });

  /** Push past the line first; the control (short of the line) is only worth a call if the call changed. */
  async function probe(metric: string, op: "<" | ">", threshold: number): Promise<Probe> {
    const v = probeValues(metric, op, threshold);
    if (typeof v === "string") return { verdict: "untested", test: { verdict: "untested", reason: v } };
    const past = await ask(metric, v.past);
    if (typeof past === "string") return { verdict: "untested", test: { verdict: "untested", reason: past, past_value: v.past, short_value: v.short } };
    if (past.decision === orig) {
      return { verdict: "decorative", test: { verdict: "decorative", past_value: v.past, short_value: v.short, past_decision: past.decision, why: past.why } };
    }
    const short = await ask(metric, v.short);
    if (typeof short === "string") return { verdict: "untested", test: { verdict: "untested", reason: short, past_value: v.past, short_value: v.short, past_decision: past.decision } };
    const verdict = short.decision === orig ? "verified" : "mis_set";
    return { verdict, test: { verdict, past_value: v.past, short_value: v.short, past_decision: past.decision, short_decision: short.decision, why: verdict === "mis_set" ? short.why : past.why } };
  }

  const outcome = (d: DecisionKind | undefined) => (d === orig ? `still ${orig}` : `${d} instead of ${orig}`);
  const summary = (c: TripwireDraft, t: CrashTest) =>
    t.verdict === "untested"
      ? `${describe(c)}: untested (${t.reason})`
      : `${words(c.metric)} ${t.past_value} (past ${c.threshold}): ${outcome(t.past_decision)}` +
        (t.short_decision ? `; ${t.short_value} (short of it): ${outcome(t.short_decision)}` : "") +
        ` → ${t.verdict.replace("_", "-")}`;

  const seen = new Set<string>();
  const results: { c: TripwireDraft; test: CrashTest; keep: boolean }[] = [];
  const dropped: string[] = [];
  for (const c of candidates) {
    const key = `${c.metric}|${c.op}|${c.threshold}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const now = today.get(c.metric);
    let test: CrashTest;
    if (c.op === "changed") test = { verdict: "untested", reason: "fires on any change, so there is no line to push" };
    else if (typeof c.threshold !== "number" || !Number.isFinite(c.threshold)) test = { verdict: "untested", reason: "no threshold" };
    else if (now === undefined) test = { verdict: "untested", reason: `no value today for ${words(c.metric)}` };
    else if (isTripped(c, now)) {
      dropped.push(`${describe(c)} (already true today at ${now}, so it can never fire)`);
      emit(`${describe(c)}: already true today (${now}) → dropped`, "needs_revision", { tripwire: describe(c), metric: c.metric, origin: c.origin });
      continue;
    } else test = (await probe(c.metric, c.op, c.threshold)).test;

    emit(summary(c, test), test.verdict === "verified" ? "success" : test.verdict === "untested" ? "partial" : "needs_revision", { tripwire: describe(c), metric: c.metric, origin: c.origin, ...test });

    // One reset for a line set too far out: move it halfway to today's value and test again.
    if (test.verdict === "mis_set" && now !== undefined && c.op !== "changed" && c.threshold !== undefined) {
      const def = metricDef(c.metric)!;
      const mid = now + (c.threshold - now) / 2;
      const moved = round(def.unit === "count" ? Math.round(mid) : Math.round(mid / STEP[def.unit]) * STEP[def.unit]);
      if ((moved - now) * (c.threshold - moved) > 0 && !isTripped({ op: c.op, threshold: moved }, now)) {
        const r = { ...c, threshold: moved };
        const again = await probe(c.metric, c.op, moved);
        emit(`reset ${describe(c)} → ${moved}: ${summary(r, again.test)}`, again.verdict === "verified" ? "success" : "needs_revision", { tripwire: describe(r), metric: c.metric, origin: c.origin, reset_from: c.threshold, ...again.test });
        if (again.verdict === "verified") {
          const why = `Line moved from ${c.threshold} to ${moved}: the old line was past the point where the call already changes. ${again.test.why ?? ""}`.trim();
          results.push({ c: { ...r, crash_test: { ...again.test, why } }, test: again.test, keep: true });
          continue;
        }
      }
    }
    const keep = test.verdict === "verified" || test.verdict === "untested";
    if (!keep) dropped.push(`${describe(c)} (${test.verdict.replace("_", "-")})${test.why ? `: ${test.why}` : ""}`);
    results.push({ c: { ...c, crash_test: test }, test, keep });
  }

  let kept = results.filter((r) => r.keep).map((r) => r.c);
  if (!kept.length && results.length) {
    // Never leave a decision with nothing that can reopen it: keep the Decider's (or the rules') own lines, as tested.
    const own = results.filter((r) => r.c.origin === "decider" || r.c.origin === "rules");
    const pool = own.length ? own : results;
    kept = pool.slice(0, 4).map((r) => r.c);
    for (const k of kept) {
      const i = dropped.findIndex((d) => d.startsWith(`${describe(k)} (`));
      if (i >= 0) dropped.splice(i, 1);
    }
    const who = pool[0].c.origin === "rules" ? "rule-based policy" : pool[0].c.origin === "decider" ? "Decider" : "pre-mortem";
    s.limitations.push(
      `Crash test: none of the ${results.length} candidate tripwires changed the call when crossed; kept the ${kept.length} proposed by the ${who} so the decision can still reopen` +
        (orig === "exit" ? " (for an exit, a worse number only confirms the call; the backup supplier's tripwires are the ones that can change it)" : ""),
    );
  }

  const tested = results.filter((r) => r.test.verdict !== "untested").length;
  const count = (v: CrashTest["verdict"]) => results.filter((r) => r.test.verdict === v).length;
  s.proving.crash = { tested, verified: count("verified"), decorative: count("decorative"), mis_set: count("mis_set"), dropped };
  if (results.length && !tested) (s.proving.skipped ??= []).push(`crash-test: ${results[0].test.reason ?? "not tested"}`);
  deps.tracer.emit({
    decision_id: s.decision_id, agent_name: AGENT, action: "crash_test_done", event: "handoff", target_agent: "RiskOfficer",
    status: tested ? "success" : "partial",
    output_summary: tested
      ? `${count("verified")} of ${tested} tested tripwires survived the crash test; kept ${kept.length}, dropped ${dropped.length}`
      : `no tripwire could be crash-tested; kept all ${kept.length} as proposed`,
  });
  return kept;
}

export async function crashTest(deps: Deps, s: RunState, draft: DecisionDraft, candidates: TripwireDraft[]): Promise<TripwireDraft[]> {
  return runCrash(deps, s, draft, candidates, modelRedecider(deps, s));
}
