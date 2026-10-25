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
    deps.tracer.emit({ decision_id: s.decision_id, agent_name: AGENT, action: "recall", event: "fallback", sponsor: deps.memory.name ?? "memory", status: "fallback", output_summary: `memory unavailable: ${(e as Error).message}` });
    s.priorClaims = [];
    return;
  }
  // A claim is stale when no query run today over its source row reproduces the hash it was built from.
  // (Several templates read the same row, e.g. latest and history financials, so keep every hash per row.)
  const current = new Map<string, Set<string>>();
  for (const r of Object.values(s.results)) {
    for (const d of r.evidence.depends_on) {
      if (!current.has(rowId(d))) current.set(rowId(d), new Set());
      current.get(rowId(d))!.add(r.evidence.result_hash);
    }
  }
  s.staleClaims = s.priorClaims.filter((c) => c.derivedFrom.some((d) => current.has(rowId(d.row)) && !current.get(rowId(d.row))!.has(d.result_hash)));

  deps.tracer.emit({
    decision_id: s.decision_id, agent_name: AGENT, action: "recall", event: "sponsor_call", sponsor: deps.memory.name ?? "memory",
    target_agent: "Decider", status: "success",
    output_summary: `${s.priorClaims.length} prior claims; ${s.staleClaims.length} stale` +
      (s.staleClaims.length ? ` (e.g. "${s.staleClaims[0].text}" is based on data that has since changed)` : ""),
  });
}

/** After the Critic rejects stale claims: keep them only as "stale" context, never as facts. */
export function dropStale(deps: Deps, s: RunState): void {
  if (!s.staleClaims.length) return;
  const stale = new Set(s.staleClaims.map((c) => c.id));
  s.priorClaims = s.priorClaims.filter((c) => !stale.has(c.id));
  deps.tracer.emit({
    decision_id: s.decision_id, agent_name: AGENT, action: "drop_stale", event: "retry", target_agent: "Decider", status: "success",
    output_summary: `${stale.size} stale claim(s) withheld as facts and passed to the Decider as "changed since"; they are superseded when this decision is recorded`,
  });
}

export async function record(deps: Deps, s: RunState, decision: Decision): Promise<void> {
  const oldByMetric = new Map<string, MemoryClaim>();
  if (s.supersedes) for (const c of s.priorClaims) if (c.decision_id === s.supersedes.decision_id && c.metric) oldByMetric.set(c.metric, c);
  let written = 0;
  let superseded = 0;
  try {
    // The backup's numbers are stored too, so a change to the backup's rows also finds this decision.
    for (const f of [...decision.findings, ...(decision.backup?.findings ?? [])]) {
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
      decision_id: s.decision_id, agent_name: AGENT, action: "remember", event: "sponsor_call", sponsor: deps.memory.name ?? "memory", status: "success",
      output_summary: `${written} claims stored with lineage${superseded ? `, ${superseded} superseding the old decision` : ""}`,
    });
  } catch (e) {
    s.limitations.push(`Memory write failed after ${written} claims; reopen may miss this decision`);
    deps.tracer.emit({ decision_id: s.decision_id, agent_name: AGENT, action: "remember", event: "error", sponsor: deps.memory.name ?? "memory", status: "failed", output_summary: (e as Error).message });
  }
}
