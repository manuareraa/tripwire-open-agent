// Self-challenge: after the crash test, check whether Nemotron's own Proving Ground findings argue against approving
// the decision as it stands. Pure code, no model call. When they do, the decision is escalated with plain reasons,
// so a human sees "Nemotron disagrees with itself" instead of a confident-looking card.
import { metricDef } from "../metrics.js";
import type { TripwireDraft } from "../tripwires.js";
import type { DecisionDraft, Deps, RunState } from "../orchestration/state.js";

const MODEL_ORIGINS = new Set(["decider", "premortem"]);

export function selfChallenge(deps: Deps, s: RunState, draft: DecisionDraft, proven: TripwireDraft[]): void {
  const reasons: string[] = [];
  const label = (m: string) => metricDef(m)?.label.toLowerCase() ?? m.replace(/_/g, " ");

  // 1. The safety net is decoration: Nemotron proposed tripwires, Lightning tested them, and none would change the call.
  // Not for an exit: there a worse number only confirms the call by design, and the crash stage already says so.
  const crash = s.proving.crash;
  const modelTested = proven.filter((t) => MODEL_ORIGINS.has(t.origin ?? "") && t.crash_test && t.crash_test.verdict !== "untested");
  if (draft.decision !== "exit" && crash && crash.tested > 0 && crash.verified === 0 && modelTested.length > 0) {
    reasons.push("none of the tripwires Nemotron proposed would change the decision when crossed, so nothing would reopen it in time");
  }

  // 2. Knife-edge: the call already flips when a number moves only part of the way to its line.
  // A line that was reset closer to today counts too: its original position was past the point where the call flips.
  const misSet = proven.filter((t) => t.crash_test?.verdict === "mis_set" || t.crash_test?.reset_from !== undefined).map((t) => label(t.metric));
  if (misSet.length) reasons.push(`the decision already changes before the line is crossed (${misSet.join(", ")}), so it sits on a knife-edge`);

  // 3. The pre-mortem's own story: a likely failure path backed by a serious real filing.
  const highFilings = new Set((s.proving.filings ?? []).filter((f) => f.severity === "high").map((f) => f.id));
  const likely = (s.proving.stories ?? []).filter((st) => st.likelihood === "high" && st.grounded_in.some((g) => highFilings.has(g)));
  if (likely.length) reasons.push(`Ultra's pre-mortem rates a failure path as likely and it rests on a serious 8-K filing: "${likely[0].story}"`);

  s.proving.challenge = { disagrees: reasons.length > 0, reasons };
  if (reasons.length) {
    s.escalated = true;
    for (const r of reasons) s.escalationReasons.push(`Nemotron disagrees with itself: ${r}`);
  }
  deps.tracer.emit({
    decision_id: s.decision_id, agent_name: "SelfChallenge", action: "challenge_decision", event: reasons.length ? "escalation" : "critique",
    target_agent: "RiskOfficer", status: reasons.length ? "needs_revision" : "success",
    output_summary: reasons.length ? `escalate ${draft.decision}: ${reasons.join("; ")}` : `${draft.decision} holds up against its own pre-mortem and crash tests`,
  });
}
