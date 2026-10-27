// Proving Ground stage 2, Imagine: Ultra writes a pre-mortem ("six months on, this went badly: what happened?")
// and turns each failure story into a candidate tripwire on the earliest number it would move.
// Owner: the "imagine" stream. Fills s.proving.stories and returns the candidates (origin "premortem", story_id set).
// The model proposes; code checks every story and drops bad ones. No model answer means no stories: code never writes them.
import { extractJson } from "../adapters/model.js";
import { METRIC_NAMES, metricDef, round, type MetricValue } from "../metrics.js";
import { isTripped, reviewTripwires, type TripwireDraft } from "../tripwires.js";
import { callModel, type DecisionDraft, type Deps, type RunState } from "../orchestration/state.js";
import type { FailureStory } from "../types.js";

const AGENT = "PreMortem";
const MAX_STORIES = 4;
const LABEL: Record<string, string> = { keep: "keep", dual_source: "dual-source", exit: "exit" };

/**
 * One Ultra call (reasoning tier, thinking on). Returns the valid stories as tripwire drafts.
 * backupMetrics: the Backup Picker's metrics (backup_*), when graph.ts passes them; optional so the current call compiles.
 */
export async function premortem(deps: Deps, s: RunState, draft: DecisionDraft, backupMetrics: MetricValue[] = []): Promise<TripwireDraft[]> {
  const metrics = [...s.metrics, ...backupMetrics];
  const filings = s.proving.filings ?? [];
  // The prompt holds no ids, run ids or timestamps, so recorded answers replay by prompt hash.
  const res = await callModel(deps, s, {
    tier: "reasoning",
    agent_name: AGENT,
    thinking: true,
    json: true,
    max_tokens: 6000,
    system:
      "You run a pre-mortem on a supplier decision: imagine it failed and explain how. " +
      'Each failure story names ONE metric from the list given, the direction it would move (op "<" or ">") and the line (threshold) that would warn us first. ' +
      "The line must NOT already be crossed today. Use only metric names from the list and quote only numbers given. " +
      "In grounded_in, cite only metric names or filing ids from the lists given. " +
      'Reply only with JSON: {"stories": [{"story": "1-2 plain sentences", "metric": "...", "op": "<" or ">", "threshold": number, "grounded_in": ["..."]}]}',
    user:
      `It is six months from now. We made this decision (${LABEL[draft.decision] ?? draft.decision} for ${s.subject_id}) and it went badly. ` +
      "Write the 2-4 most likely failure stories. For each, name the earliest number from this list that would move first, the direction, and the line.\n" +
      `Metrics (today):\n${metrics.map((m) => `- ${m.metric} = ${m.value}${meaning(m.metric)}`).join("\n")}\n` +
      `Why we decided: ${draft.rationale}\n` +
      (s.findings.length ? `Findings:\n${s.findings.map((f) => `- ${f.claim}`).join("\n")}\n` : "") +
      (filings.length ? `8-K filings:\n${filings.map((f) => `- ${f.id} (${f.filed}, items ${f.items.join(", ")}, ${f.severity}): ${f.headline}`).join("\n")}\n` : ""),
  });

  const skip = (why: string) => { (s.proving.skipped ??= []).push(`imagine: ${why}`); return []; };
  if (res.fallback) return skip(`no model answered (${res.error ?? "fallback"})`);
  const parsed = extractJson<{ stories?: unknown }>(res.text);
  if (!parsed || !Array.isArray(parsed.stories)) return skip("the model's reply was not valid JSON, so no stories were kept");

  const cite = new Set([...metrics.map((m) => m.metric), ...filings.map((f) => f.id)]);
  const taken = new Set(draft.tripwires.map(lineKey));
  const stories: FailureStory[] = [];
  const out: TripwireDraft[] = [];
  (parsed.stories as unknown[]).forEach((raw, i) => {
    const id = `${s.decision_id}-s${i + 1}`;
    const st = toStory(raw, id);
    const why = st ? check(st, s.metrics, backupMetrics, cite, taken, stories.length) : "not a story object";
    if (why) {
      s.limitations.push(`Pre-mortem story ${id} dropped: ${why}`);
    } else {
      stories.push(st!);
      taken.add(lineKey(st!));
      out.push({ metric: st!.metric, op: st!.op as "<" | ">", threshold: st!.threshold, origin: "premortem", story_id: id });
    }
    deps.tracer.emit({
      decision_id: s.decision_id, agent_name: AGENT, action: "failure_story", event: "message", target_agent: "CrashTest",
      status: why ? "failed" : "success",
      output_summary: why ? `Dropped story ${id}: ${why}` : `${st!.story} Watch: ${st!.metric} ${st!.op} ${st!.threshold}`,
      data: st ? { story: st, ...(why ? { dropped: why } : {}) } : { raw },
    });
  });
  s.proving.stories = stories;
  return out;
}

function meaning(name: string): string {
  const d = metricDef(name);
  return d ? ` (${d.label}; worse when ${d.worseWhen})` : "";
}

const lineKey = (t: { metric: string; op: string; threshold?: number }) => `${t.metric}|${t.op}|${t.threshold ?? ""}`;

function toStory(raw: unknown, id: string): FailureStory | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const threshold = r.threshold === undefined || r.threshold === null || r.threshold === "" ? NaN : Number(r.threshold);
  return {
    id,
    story: String(r.story ?? "").trim(),
    metric: String(r.metric ?? "").trim(),
    op: String(r.op ?? "").trim() as FailureStory["op"], // checked in check()
    ...(Number.isFinite(threshold) ? { threshold: round(threshold) } : {}),
    grounded_in: Array.isArray(r.grounded_in) ? r.grounded_in.map((g) => String(g).trim()) : [],
  };
}

/** Why a story cannot become a tripwire, or undefined when it passes. */
function check(st: FailureStory, metrics: MetricValue[], backup: MetricValue[], cite: Set<string>, taken: Set<string>, kept: number): string | undefined {
  if (!st.story) return "no story text";
  if (st.op !== "<" && st.op !== ">") return `direction "${st.op}" is not "<" or ">"`;
  if (st.threshold === undefined) return `${st.metric || "metric"}: no numeric line`;
  const tw: TripwireDraft = { metric: st.metric, op: st.op, threshold: st.threshold };
  if (st.metric.startsWith("backup_")) {
    // reviewTripwires only knows the main supplier's metrics; backup ones are checked the same way here.
    if (!metricDef(st.metric)) return `unknown metric "${st.metric}"`;
    const v = backup.find((m) => m.metric === st.metric);
    if (!v) return `no data for metric "${st.metric}"`;
    if (isTripped(tw, v.value)) return `${st.metric} ${st.op} ${st.threshold} is already true today (value ${v.value})`;
  } else {
    if (!METRIC_NAMES.includes(st.metric)) return `unknown metric "${st.metric}"`;
    // One story at a time, so the set-size rule (2-4 tripwires) does not apply.
    const issue = reviewTripwires([tw], metrics).find((x) => !x.startsWith("need 2-4"));
    if (issue) return issue;
  }
  const bad = st.grounded_in.filter((g) => !cite.has(g));
  if (bad.length) return `cites ${bad.map((b) => `"${b}"`).join(", ")}, which is not a filing or metric we have`;
  if (taken.has(lineKey(st))) return "same line as a tripwire already set";
  if (kept >= MAX_STORIES) return `more than ${MAX_STORIES} stories`;
  return undefined;
}
