// Decider: proposes keep / dual_source / exit, a confidence, 2-4 tripwires and limitations.
// Uses the reasoning model with thinking only when the Risk Officer says the case is high risk.
import { extractJson } from "../adapters/model.js";
import { METRICS } from "../metrics.js";

/** Risk flags that count as financial distress (the Risk Officer's wording). */
const DISTRESS = /current ratio|liabilities|debt|margin|revenue|8-K/;
import { defaultTripwires, type TripwireDraft } from "../tripwires.js";
import { callModel, type DecisionDraft, type Deps, type RunState } from "../orchestration/state.js";
import type { DecisionKind } from "../types.js";

const AGENT = "Decider";
const KINDS: DecisionKind[] = ["keep", "dual_source", "exit"];

export async function decide(deps: Deps, s: RunState, feedback: string[]): Promise<DecisionDraft> {
  const metricList = s.metrics.map((m) => `- ${m.metric} = ${m.value}`).join("\n");
  const res = await callModel(deps, s, {
    tier: "reasoning",
    agent_name: AGENT,
    thinking: s.risk.thinking,
    json: true,
    max_tokens: s.risk.thinking ? 6000 : 1200,
    system:
      "You decide what a buyer should do with a supplier: keep, dual_source (add a second supplier) or exit. " +
      "Base it only on the metrics given. Then set 2-4 tripwires: future conditions that should reopen this decision. " +
      "A tripwire must NOT already be true today. Use only metric names from the list. " +
      "For dual_source or exit, code then names the backup supplier from the category; do not name one yourself. " +
      'Reply only with JSON: {"decision": "keep|dual_source|exit", "confidence": 0-1, "rationale": "2-3 sentences, quoting only given numbers", ' +
      '"tripwires": [{"metric": "...", "op": "<" or ">", "threshold": number}], "limitations": ["..."]}',
    user:
      `Supplier ${s.subject_id}. Question: ${s.question}\nMetrics (today):\n${metricList}\n` +
      `Metric meanings: ${METRICS.map((m) => `${m.name} (${m.label}; worse when ${m.worseWhen})`).join("; ")}\n` +
      `Risk Officer: ${s.risk.level}${s.risk.flags.length ? ` (${s.risk.flags.join("; ")})` : ""}\n` +
      `Analyst summary: ${s.summary}\n` +
      (s.staleClaims.length ? `Memory: earlier claims now stale: ${s.staleClaims.map((c) => c.text).join("; ")}\n` : "") +
      (s.supersedes ? `This reopens decision ${s.supersedes.decision_id} (was ${s.supersedes.decision}).\n` : "") +
      (feedback.length ? `\nThe evidence critic rejected your last draft: ${feedback.join(" | ")}. Fix every point.` : ""),
  });

  const parsed = res.fallback ? undefined : extractJson<Record<string, unknown>>(res.text);
  const draft = parsed ? normalise(parsed) : undefined;
  const out = draft ?? rulesDecision(s);
  if (!res.fallback && !draft) out.limitations.push("Model reply was not valid JSON; rule-based decision used");
  deps.tracer.emit({
    decision_id: s.decision_id, agent_name: AGENT, action: "propose_decision", event: "handoff", target_agent: "EvidenceCritic",
    status: out.rules ? "fallback" : "success", confidence: out.confidence, retry_count: s.rounds - 1,
    output_summary: `${out.decision} @ ${out.confidence}; tripwires: ${out.tripwires.map((t) => `${t.metric} ${t.op} ${t.threshold ?? ""}`).join(", ")}`,
  });
  return out;
}

function normalise(p: Record<string, unknown>): DecisionDraft | undefined {
  const decision = String(p.decision ?? "").toLowerCase().replace(/[\s-]/g, "_") as DecisionKind;
  if (!KINDS.includes(decision)) return undefined;
  const tripwires: TripwireDraft[] = Array.isArray(p.tripwires)
    ? (p.tripwires as Record<string, unknown>[]).map((t) => ({
        metric: String(t.metric ?? ""),
        op: (t.op === "<" || t.op === ">" || t.op === "changed" ? t.op : "<") as TripwireDraft["op"],
        threshold: t.threshold === undefined ? undefined : Number(t.threshold),
      }))
    : [];
  return {
    decision,
    confidence: Number(p.confidence),
    rationale: String(p.rationale ?? ""),
    tripwires,
    limitations: Array.isArray(p.limitations) ? p.limitations.map(String) : [],
    rules: false,
  };
}

/** Deterministic policy used in SAMPLE_MODE or when the model is unavailable or keeps failing review. */
export function rulesDecision(s: RunState): DecisionDraft {
  const v = new Map(s.metrics.map((m) => [m.metric, m.value]));
  const alts = v.get("category_alternatives") ?? 0;
  const distress = s.risk.flags.filter((f) => DISTRESS.test(f)).length;
  const share = v.get("spend_share") ?? 0;
  const sanctioned = (v.get("sanctions_matches") ?? 0) >= 1;
  let decision: DecisionKind = "keep";
  if (sanctioned) decision = alts >= 1 ? "exit" : "dual_source";
  else if (distress >= 2 && alts >= 1) decision = "exit";
  else if (distress >= 1 || (share >= 0.3 && alts >= 1)) decision = "dual_source";
  // Confidence = evidence coverage (every metric expected) + how clear-cut the case is. Borderline cases score lower.
  const coverage = Math.min(1, s.metrics.length / METRICS.length);
  const clarity =
    decision === "exit" ? (distress >= 3 ? 0.2 : 0.1)
    : decision === "keep" ? (s.risk.flags.length === 0 ? 0.2 : 0.1)
    : distress >= 1 && share >= 0.3 ? 0.15
    : 0.05;
  const confidence = Math.min(0.9, 0.5 + 0.2 * coverage + clarity - (s.staleClaims.length ? 0.05 : 0));
  const distressFlags = s.risk.flags.filter((f) => DISTRESS.test(f));
  const altText = `${alts} alternative supplier${alts === 1 ? "" : "s"} in the category`;
  const rationale =
    sanctioned ? `${decision}: possible OFAC sanctions name match (${v.get("sanctions_matches")}); stop new orders until compliance clears it, ${altText}.`
    : decision === "exit" ? `exit: ${distressFlags.length} financial distress signals (${distressFlags.join("; ")}) and ${altText}.`
    : decision === "dual_source" && distressFlags.length ? `dual_source: financial distress signal (${distressFlags.join("; ")})${share >= 0.3 ? ` with spend share ${share}` : ""}; add a second source while ${altText} exist.`
    : decision === "dual_source" ? `dual_source: no financial distress, but spend share ${share} is concentrated and there are ${altText}.`
    : s.risk.flags.length ? `keep: no financial distress strong enough to act on; watch ${s.risk.flags.join("; ")}.`
    : "keep: no risk flags on the reviewed metrics.";
  return {
    decision,
    confidence: Math.round(confidence * 100) / 100,
    rationale: `Rule-based policy: ${rationale}`,
    tripwires: defaultTripwires(s.metrics),
    limitations: ["Decided by the rule-based policy, not the reasoning model"],
    rules: true,
  };
}
