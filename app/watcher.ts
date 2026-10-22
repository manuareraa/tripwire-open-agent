// Watcher (code, not a model): when a source row changes, ask memory which decisions derive from it,
// re-check only those decisions' tripwires, and reopen only the ones that fire.
import { gather } from "./agents/analyst.js";
import { newState, runDecide } from "./orchestration/graph.js";
import type { Deps } from "./orchestration/state.js";
import type { DecisionStore } from "./store.js";
import { isTripped } from "./tripwires.js";
import type { Decision, RowRef } from "./types.js";

const AGENT = "Watcher";

export interface ReopenReport {
  changed: RowRef;
  active: number;
  dependents: string[];
  still_valid: { decision_id: string; checked: string[] }[];
  reopened: { old: string; new: Decision; fired: string[] }[];
  /** Decisions not re-run because nothing they depend on changed, or no tripwire fired. */
  work_saved: number;
}

export async function reopenFor(deps: Deps, store: DecisionStore, changed: RowRef): Promise<ReopenReport> {
  const t = deps.tracer;
  const active = store.active();
  const activeIds = new Set(active.map((d) => d.decision_id));
  let dependents: string[] = [];
  try {
    dependents = (await deps.memory.dependentsOf(changed)).filter((id) => activeIds.has(id));
  } catch (e) {
    // Without lineage we cannot be selective: fall back to checking every active decision.
    dependents = [...activeIds];
    t.emit({ agent_name: AGENT, action: "lineage_lookup", event: "fallback", sponsor: "meterless-hmem", status: "fallback", output_summary: `memory unavailable (${(e as Error).message}); checking all ${dependents.length}` });
  }
  t.emit({
    agent_name: AGENT, action: "lineage_lookup", event: "sponsor_call", sponsor: "meterless-hmem", status: "success",
    input_summary: `${changed.table}:${changed.key} changed`,
    output_summary: `${dependents.length} of ${active.length} active decisions depend on this row: ${dependents.join(", ") || "none"}`,
  });

  const report: ReopenReport = { changed, active: active.length, dependents, still_valid: [], reopened: [], work_saved: active.length - dependents.length };

  for (const id of dependents) {
    const old = store.get(id)!;
    const s = newState(t.run_id, old.subject_id, "tripwire check");
    s.decision_id = old.decision_id;
    s.plan = ["supplier_spend_row", "supplier_financials_latest", "supplier_financials_history", "category_concentration"];
    await gather(deps, s);
    const now = new Map(s.metrics.map((m) => [m.metric, m.value]));
    const before = new Map(old.findings.map((f) => [f.metric, Number(f.value)]));
    const fired: string[] = [];
    const checked: string[] = [];
    for (const tw of old.tripwires) {
      const v = now.get(tw.metric);
      if (v === undefined) continue;
      const desc = `${tw.metric} ${tw.op} ${tw.threshold ?? ""} (now ${v}, was ${before.get(tw.metric)})`;
      checked.push(desc);
      if (isTripped(tw, v, before.get(tw.metric))) fired.push(desc);
    }
    t.emit({
      decision_id: id, agent_name: AGENT, action: "check_tripwires", event: fired.length ? "escalation" : "message",
      target_agent: fired.length ? "Planner" : undefined, status: "success",
      output_summary: fired.length ? `FIRED: ${fired.join("; ")} → reopening` : `no tripwire fired (${checked.join("; ")}); decision stands`,
    });
    if (!fired.length) {
      report.still_valid.push({ decision_id: id, checked });
      report.work_saved++;
      continue;
    }
    const { decision } = await runDecide(deps, old.subject_id, `Reopened: ${fired.join("; ")}. Should we change the decision?`, old);
    store.put({ ...old, status: "superseded" });
    store.put(decision);
    report.reopened.push({ old: id, new: decision, fired });
  }

  t.emit({
    agent_name: AGENT, action: "reopen_summary", event: "decision", status: "success",
    output_summary: `reopened ${report.reopened.length} of ${active.length}; ${report.work_saved} decisions not re-run`,
  });
  return report;
}

/** One polling step: pick up changes from the data layer since the marker and process each. */
export async function watchTick(deps: Deps, store: DecisionStore, marker: string): Promise<{ marker: string; reports: ReopenReport[] }> {
  const { changes, marker: next } = await deps.gateway.changesSince(marker);
  const reports: ReopenReport[] = [];
  for (const c of changes) reports.push(await reopenFor(deps, store, c));
  return { marker: next, reports };
}
