// Memory Keeper: recalls prior claims (Meterless H-MEM), catches stale ones, and records new claims
// with derivedFrom lineage so the Watcher can find exactly which decisions depend on a changed row.
import type { Deps, RunState } from "../orchestration/state.js";
import type { Decision, MemoryClaim } from "../types.js";

const AGENT = "MemoryKeeper";
const rowId = (r: { table: string; key: string }) => `${r.table}:${r.key}`;

export async function recallPrior(deps: Deps, s: RunState): Promise<void> {
  try {
    s.priorClaims = await deps.memory.recall(s.subject_id, s.question, 20);
  } catch (e) {
    deps.tracer.emit({ decision_id: s.decision_id, agent_name: AGENT, action: "recall", event: "fallback", sponsor: "meterless-hmem", status: "fallback", output_summary: `memory unavailable: ${(e as Error).message}` });
    s.priorClaims = [];
    return;
  }
  // A claim is stale when the row it came from now hashes differently.
  const current = new Map<string, string>();
  for (const r of Object.values(s.results)) for (const d of r.evidence.depends_on) current.set(rowId(d), r.evidence.result_hash);
  s.staleClaims = s.priorClaims.filter((c) => c.derivedFrom.some((d) => current.has(rowId(d.row)) && current.get(rowId(d.row)) !== d.result_hash));

  deps.tracer.emit({
    decision_id: s.decision_id, agent_name: AGENT, action: "recall", event: "sponsor_call", sponsor: "meterless-hmem",
    target_agent: "Decider", status: "success",
    output_summary: `${s.priorClaims.length} prior claims; ${s.staleClaims.length} stale` +
      (s.staleClaims.length ? ` (e.g. "${s.staleClaims[0].text}" is based on data that has since changed)` : ""),
  });
}

export async function record(deps: Deps, s: RunState, decision: Decision): Promise<void> {
  const oldByMetric = new Map<string, MemoryClaim>();
  if (s.supersedes) for (const c of s.priorClaims) if (c.decision_id === s.supersedes.decision_id && c.metric) oldByMetric.set(c.metric, c);
  let written = 0;
  let superseded = 0;
  try {
    for (const f of decision.findings) {
      const claim = {
        subject_id: s.subject_id,
        text: f.claim,
        metric: f.metric,
        value: f.value,
        derivedFrom: f.evidence.depends_on.map((row) => ({ row, result_hash: f.evidence.result_hash })),
        decision_id: decision.decision_id,
      };
      const old = oldByMetric.get(f.metric);
      if (old) {
        await deps.memory.supersede(old.id, { ...claim, supersedes: old.id });
        superseded++;
      } else {
        await deps.memory.remember(claim);
      }
      written++;
    }
    deps.tracer.emit({
      decision_id: s.decision_id, agent_name: AGENT, action: "remember", event: "sponsor_call", sponsor: "meterless-hmem", status: "success",
      output_summary: `${written} claims stored with lineage${superseded ? `, ${superseded} superseding the old decision` : ""}`,
    });
  } catch (e) {
    s.limitations.push(`Memory write failed after ${written} claims; reopen may miss this decision`);
    deps.tracer.emit({ decision_id: s.decision_id, agent_name: AGENT, action: "remember", event: "error", sponsor: "meterless-hmem", status: "failed", output_summary: (e as Error).message });
  }
}
