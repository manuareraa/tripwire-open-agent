// The decision graph: Planner → Analyst → Critic (evidence, source freshness ⇄ Planner re-read) → Memory Keeper (recall) ⇄ Critic (stale memory) → Analyst summary ⇄ Critic
// → Risk Officer → Decider ⇄ Critic (max 3 rounds) → Backup Picker (dual_source / exit) → Risk Officer final check → Memory Keeper (record).
import { config } from "../config.js";
import { compileTripwires } from "../tripwires.js";
import { plan, replan } from "../agents/planner.js";
import { gather, reread, rulesSummary, summarize } from "../agents/analyst.js";
import { holdForStale, reviewDecision, reviewFreshness, reviewMemory, reviewSummary, verifyEvidence } from "../agents/critic.js";
import { dropStale, recallPrior, record } from "../agents/memory_keeper.js";
import { assess, finalCheck } from "../agents/risk.js";
import { decide, rulesDecision } from "../agents/decider.js";
import { pickBackup } from "../agents/backup.js";
import { readFilings } from "../proving/filings.js";
import { premortem } from "../proving/premortem.js";
import { crashTest } from "../proving/crashtest.js";
import { trackRecord } from "../proving/backtest.js";
import { selfChallenge } from "../proving/challenge.js";
import type { DecisionDraft, Deps, RunState } from "./state.js";
import type { Decision, Evidence } from "../types.js";

export function newState(run_id: string, subject_id: string, question: string, supersedes?: Decision): RunState {
  const stamp = Date.now().toString(36).slice(-6);
  return {
    run_id, subject_id, question, supersedes,
    decision_id: `DEC-${subject_id}-${stamp}`,
    plan: [], results: {}, freshness: [], modelCalls: [], metrics: [], findings: [], summary: "",
    priorClaims: [], staleClaims: [],
    risk: { level: "low", flags: [], thinking: false },
    proving: {},
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
  // Proving Ground 1, Read: real 8-K filings, read by Nemotron Parse, join the evidence before anything is checked.
  await readFilings(deps, s);
  await verifyEvidence(deps, s);
  // Critic → Planner: a source past its line is re-read once before anything is decided on it.
  if (reviewFreshness(deps, s).length) {
    t.emit({
      decision_id: s.decision_id, agent_name: "EvidenceCritic", action: "send_back_stale", event: "critique", target_agent: "Planner",
      status: "needs_revision", output_summary: `re-plan: ${s.freshness.filter((f) => f.status !== "fresh").map((f) => f.label).join(", ")} past the policy line`,
    });
    await reread(deps, s, replan(deps, s, s.freshness.filter((f) => f.status !== "fresh")));
    reviewFreshness(deps, s);
  }
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

  // A second source or an exit needs somewhere for the work to go: name it in code, with its own evidence and tripwires.
  const backup = draft.decision === "keep" ? undefined : await pickBackup(deps, s);
  const stale = holdForStale(deps, s, draft);

  // Proving Ground 2-3: Ultra imagines how this call fails (pre-mortem), then Lightning crash-tests every candidate
  // tripwire, so only lines that really change the call are kept.
  // A failure inside a Proving Ground stage is recorded as skipped; it never takes the decision down with it.
  const skip = (stage: string, e: unknown) => (s.proving.skipped ??= []).push(`${stage}: failed (${(e as Error).message})`);
  const own = draft.tripwires.map((t) => ({ origin: draft!.rules ? "rules" as const : "decider" as const, ...t }));
  const stories = await premortem(deps, s, draft, backup?.metrics).catch((e) => (skip("pre-mortem", e), []));
  const candidates = [...own, ...stories];
  const proven = await crashTest(deps, s, draft, candidates).catch((e) => (skip("crash-test", e), candidates));
  // If its own findings argue against the call, Nemotron escalates rather than presenting a confident card.
  try { selfChallenge(deps, s, draft, proven); } catch (e) { skip("self-challenge", e); }
  let track: ReturnType<typeof trackRecord> | undefined;
  try { track = trackRecord(subject_id); } catch (e) { skip("backtest", e); }
  if (track) s.proving.track_record = track;

  await finalCheck(deps, s, draft);

  const evidence = uniqueEvidence([...s.findings, ...(backup?.backup.findings ?? [])].map((f) => f.evidence));
  const decision: Decision = {
    decision_id: s.decision_id,
    subject_id,
    decision: draft.decision,
    confidence: draft.confidence,
    status: "proposed",
    findings: s.findings,
    evidence,
    tripwires: compileTripwires(s.decision_id, [...proven, ...(backup?.tripwires ?? []).map((t) => ({ origin: "backup" as const, ...t })), ...stale.tripwires.map((t) => ({ origin: "stale" as const, ...t }))], [...s.metrics, ...(backup?.metrics ?? []), ...stale.metrics]),
    limitations: [...new Set([...s.limitations, ...draft.limitations])],
    sources: s.freshness,
    model_calls: s.modelCalls,
    supersedes: supersedes?.decision_id,
    ...(backup ? { backup: backup.backup } : {}),
    proving: s.proving,
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
