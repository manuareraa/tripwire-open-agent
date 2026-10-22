// The decision graph: Planner → Analyst → Critic (evidence) → Memory Keeper (recall) ⇄ Critic (stale memory) → Analyst summary ⇄ Critic
// → Risk Officer → Decider ⇄ Critic (max 3 rounds) → Risk Officer final check → Memory Keeper (record).
import { config } from "../config.js";
import { compileTripwires } from "../tripwires.js";
import { plan } from "../agents/planner.js";
import { gather, rulesSummary, summarize } from "../agents/analyst.js";
import { reviewDecision, reviewMemory, reviewSummary, verifyEvidence } from "../agents/critic.js";
import { dropStale, recallPrior, record } from "../agents/memory_keeper.js";
import { assess, finalCheck } from "../agents/risk.js";
import { decide, rulesDecision } from "../agents/decider.js";
import type { DecisionDraft, Deps, RunState } from "./state.js";
import type { Decision, Evidence } from "../types.js";

export function newState(run_id: string, subject_id: string, question: string, supersedes?: Decision): RunState {
  const stamp = Date.now().toString(36).slice(-6);
  return {
    run_id, subject_id, question, supersedes,
    decision_id: `DEC-${subject_id}-${stamp}`,
    plan: [], results: {}, metrics: [], findings: [], summary: "",
    priorClaims: [], staleClaims: [],
    risk: { level: "low", flags: [], thinking: false },
    rounds: 0, limitations: [], escalated: false, escalationReasons: [],
  };
}

export async function runDecide(deps: Deps, subject_id: string, question: string, supersedes?: Decision): Promise<{ decision: Decision; state: RunState }> {
  const s = newState(deps.tracer.run_id, subject_id, question, supersedes);
  const t = deps.tracer;
  t.emit({
    decision_id: s.decision_id, agent_name: "Orchestrator", action: supersedes ? "reopen_decision" : "start_decision", event: "handoff",
    target_agent: "Planner", status: "pending", input_summary: `${subject_id}: ${question}`,
    output_summary: `data: ${deps.gateway.name}${supersedes ? `; supersedes ${supersedes.decision_id}` : ""}`,
  });

  s.plan = await plan(deps, s);
  await gather(deps, s);
  await verifyEvidence(deps, s);
  await recallPrior(deps, s);
  if (reviewMemory(deps, s).length) dropStale(deps, s);

  // Summary: model writes, Critic checks every number, bounded retries, then rule-based text.
  let feedback: string | undefined;
  for (let attempt = 0; attempt <= config.limits.maxRetriesPerQuery; attempt++) {
    const { text, fromModel } = await summarize(deps, s, feedback);
    const issues = reviewSummary(deps, s, text);
    if (!issues.length) { s.summary = text; break; }
    feedback = issues.join("; ");
    if (!fromModel || attempt === config.limits.maxRetriesPerQuery) {
      s.summary = rulesSummary(s);
      s.limitations.push("Analyst summary failed evidence review; rule-based summary used");
      break;
    }
  }

  assess(deps, s);

  // Decide ⇄ critique, max rounds; fall back to the rule-based policy if it never passes.
  let draft: DecisionDraft | undefined;
  let decisionFeedback: string[] = [];
  for (s.rounds = 1; s.rounds <= config.limits.maxRoundsPerDecision; s.rounds++) {
    const d = await decide(deps, s, decisionFeedback);
    decisionFeedback = reviewDecision(deps, s, d);
    if (!decisionFeedback.length) { draft = d; break; }
    if (d.rules) break;
  }
  if (!draft) {
    s.rounds = Math.min(s.rounds, config.limits.maxRoundsPerDecision);
    draft = rulesDecision(s);
    draft.limitations.push(`Decider drafts failed review (${decisionFeedback.join(" | ")}); rule-based decision used`);
    t.emit({ decision_id: s.decision_id, agent_name: "Orchestrator", action: "round_limit", event: "fallback", status: "fallback", output_summary: "switched to rule-based policy after failed review rounds" });
  }

  await finalCheck(deps, s, draft);

  const evidence = uniqueEvidence(s.findings.map((f) => f.evidence));
  const decision: Decision = {
    decision_id: s.decision_id,
    subject_id,
    decision: draft.decision,
    confidence: draft.confidence,
    status: "proposed",
    findings: s.findings,
    evidence,
    tripwires: compileTripwires(s.decision_id, draft.tripwires, s.metrics),
    limitations: [...new Set([...s.limitations, ...draft.limitations])],
    supersedes: supersedes?.decision_id,
    escalated: s.escalated,
    escalation_reasons: s.escalationReasons,
    risk: s.risk.level,
    rationale: draft.rationale,
    summary: s.summary,
    created_at: new Date().toISOString(),
  };

  await record(deps, s, decision);
  t.emit({
    decision_id: s.decision_id, agent_name: "Orchestrator", action: "decision_proposed", event: "decision", target_agent: "Human",
    status: "success", confidence: decision.confidence,
    output_summary: `${decision.decision} @ ${decision.confidence}, ${decision.tripwires.length} tripwires, ${decision.escalated ? "escalated" : "standard"} approval, awaiting human`,
  });
  return { decision, state: s };
}

function uniqueEvidence(list: Evidence[]): Evidence[] {
  const seen = new Map<string, Evidence>();
  for (const e of list) seen.set(`${e.template_id}:${e.result_hash}`, e);
  return [...seen.values()];
}
