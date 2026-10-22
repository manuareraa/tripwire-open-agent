// Risk Officer: scores risk in code, sets the reasoning budget (thinking on only for high risk),
// runs the guard model over the final rationale, and decides escalation.
import { guardVerdict } from "../adapters/model.js";
import { callModel, type DecisionDraft, type Deps, type RiskLevel, type RunState } from "../orchestration/state.js";

const AGENT = "RiskOfficer";

/** Policy thresholds; the Critic accepts these numbers in prose since they are policy, not data. */
export const RISK_THRESHOLDS = [1, 2, 0.1, -10, 0.25, 12];

export function assess(deps: Deps, s: RunState): void {
  const v = new Map(s.metrics.map((m) => [m.metric, m.value]));
  const distress: string[] = [];
  const exposure: string[] = [];
  const cr = v.get("current_ratio");
  const de = v.get("debt_to_equity");
  const gm = v.get("gross_margin");
  const rev = v.get("revenue_change_pct");
  const share = v.get("spend_share");
  const alts = v.get("category_alternatives");
  const lead = v.get("lead_time_weeks");
  if (cr !== undefined && cr < 1) distress.push(`current ratio ${cr} < 1`);
  if (de !== undefined && de > 2) distress.push(`debt/equity ${de} > 2`);
  if (gm !== undefined && gm < 0.1) distress.push(`gross margin ${gm} < 0.1`);
  if (rev !== undefined && rev < -10) distress.push(`revenue change ${rev}% < -10%`);
  if (share !== undefined && share >= 0.25) exposure.push(`spend share ${share} ≥ 0.25`);
  if (alts !== undefined && alts === 0) exposure.push(`no alternative supplier in category`);
  if (lead !== undefined && lead >= 12) exposure.push(`lead time ${lead} weeks ≥ 12`);

  const flags = [...distress, ...exposure];
  let level: RiskLevel = "low";
  if ((distress.length && exposure.length) || distress.length >= 2) level = "high";
  else if (flags.length) level = "medium";
  if (s.staleClaims.length && level === "low") {
    level = "medium";
    flags.push("prior decision relied on data that has since changed");
  }
  s.risk = { level, flags, thinking: level === "high" };
  if (level === "high") {
    s.escalated = true;
    s.escalationReasons.push(`high risk: ${flags.join("; ")}`);
  }
  deps.tracer.emit({
    decision_id: s.decision_id, agent_name: AGENT, action: "assess_risk", event: level === "high" ? "escalation" : "handoff",
    target_agent: "Decider", status: "success",
    output_summary: `risk ${level}${flags.length ? `: ${flags.join("; ")}` : ""}; reasoning budget: thinking ${s.risk.thinking ? "ON" : "off"}`,
  });
}

/** After the Decider: guard check and escalation rules. */
export async function finalCheck(deps: Deps, s: RunState, draft: DecisionDraft): Promise<void> {
  const res = await callModel(deps, s, {
    tier: "guard", agent_name: AGENT, system: "",
    user: `Recommendation for supplier ${s.subject_id}: ${draft.decision}. ${draft.rationale}`,
  });
  const verdict = res.fallback ? "unknown" : guardVerdict(res.text);
  if (verdict === "unsafe") {
    s.escalated = true;
    s.escalationReasons.push("guard model flagged the rationale");
  }
  if (draft.confidence < 0.6) {
    s.escalated = true;
    s.escalationReasons.push(`low confidence ${draft.confidence}`);
  }
  if (draft.decision === "exit" && !s.escalationReasons.some((r) => r.startsWith("exit"))) {
    s.escalated = true;
    s.escalationReasons.push("exit decisions always go to a senior buyer");
  }
  deps.tracer.emit({
    decision_id: s.decision_id, agent_name: AGENT, action: "final_check", event: s.escalated ? "escalation" : "handoff",
    target_agent: "Human", status: "success", confidence: draft.confidence,
    output_summary: `guard: ${verdict}; ${s.escalated ? `ESCALATED: ${s.escalationReasons.join("; ")}` : "standard approval"}`,
  });
}
