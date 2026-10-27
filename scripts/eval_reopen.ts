// Selective reopen, measured. For each source change (real SEC filings, a synthetic OFAC match, synthetic ERP shifts):
//   1. decide all 20 suppliers on the data before the change, with lineage recorded in memory;
//   2. apply the change and let the Watcher reopen what it thinks is affected (lineage → tripwires → re-decide);
//   3. as ground truth, re-decide all 20 from scratch on the data after the change, and list the decisions whose
//      outcome (label or escalation) actually changed.
// Scored in code: a decision that changed but was not reopened is a miss. Work saved is the decisions not re-run,
// against the two obvious alternatives: re-decide everything, or re-decide everything that reads the changed table.
//
// Decisions here use the rule-based policy (no model), so the run is deterministic, needs no key and the "what changed"
// ground truth is exact. Which decisions get reopened is decided by code (lineage and tripwires), not by a model, so it
// is the same whichever model then makes the decision. The model cost of a re-run is taken from the live five-arm run
// (eval/results.json, the shipped graph's measured average per decision) and labelled as such.
// Usage: npx tsx scripts/eval_reopen.ts [--write]
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "tripwire-reopen-"));
Object.assign(process.env, { LOG_DIR: join(work, "logs"), TRACE_STDOUT: "false" });

const { RulesOnlyClient } = await import("../app/adapters/model.js");
const { SampleDataGateway } = await import("../app/adapters/sample_data.js");
const { LocalMemory } = await import("../app/adapters/local_memory.js");
const { runDecide } = await import("../app/orchestration/graph.js");
const { reopenFor } = await import("../app/watcher.js");
const { DecisionStore } = await import("../app/store.js");
const { Tracer } = await import("../app/tracing.js");
import type { Decision, RowRef } from "../app/types.js";

const QUESTION = "Keep, dual-source or exit this supplier?";
const SUPPLIERS = readFileSync(join(ROOT, "data/sample/supplier_spend.csv"), "utf8").trim().split("\n").slice(1).map((l) => l.split(",")[0]);
const sanctionsCase = (JSON.parse(readFileSync(join(ROOT, "eval/cases.json"), "utf8")).cases as { id: string; rows?: unknown[] }[]).find((c) => c.id === "SUP-08+sanctions")!;

interface Scenario { id: string; what: string; real: boolean; file?: string; rows?: unknown[] }
const SCENARIOS: Scenario[] = [
  { id: "new-quarter", what: "Vishay's next quarterly financials arrive (SEC)", real: true, file: "01_new_quarter.json" },
  { id: "new-8k", what: "Dow files an 8-K: item 2.05, restructuring (SEC)", real: true, file: "04_new_8k.json" },
  { id: "sanctions-match", what: "OFAC screen returns a possible match for Eastman", real: false, rows: sanctionsCase.rows },
  { id: "spend-jump", what: "ERP: Celanese's share of chemicals spend 35% → 58%", real: false, file: "02_spend_share_jump.json" },
  { id: "lead-time-slip", what: "ERP: XPO's quoted lead time 3 → 9 weeks", real: false, file: "03_lead_time_slip.json" },
];

/** The live run's measured cost of one decision through the shipped graph. */
const live = (() => {
  const r = JSON.parse(readFileSync(join(ROOT, "eval/results.json"), "utf8"));
  const s = r.summary.find((x: { arm: string }) => x.arm === "tripwire");
  if (!s?.cases || !/^live|^replay/.test(s.mode)) return undefined;
  return { recorded: String(r.generated_at).slice(0, 10), calls: s.calls / s.cases, tokens: (s.tokens_in + s.tokens_out) / s.cases, model_s: s.model_s / s.cases, providers: s.providers as string[] };
})();

async function decideAll(gateway: InstanceType<typeof SampleDataGateway>, memory: InstanceType<typeof LocalMemory>, store?: InstanceType<typeof DecisionStore>) {
  const deps = { gateway, model: new RulesOnlyClient(), memory, tracer: new Tracer() };
  const out = new Map<string, Decision>();
  for (const id of SUPPLIERS) {
    const { decision } = await runDecide(deps, id, QUESTION);
    out.set(id, decision);
    store?.put(decision);
  }
  return { deps, out };
}

const outcome = (d: Decision) => `${d.decision}${d.escalated ? " (escalated)" : ""}`;
const readsTable = (d: Decision, table: string) => (d.evidence ?? []).some((e) => (e.depends_on ?? []).some((r: RowRef) => r.table === table));

const rows: Record<string, unknown>[] = [];
for (const sc of SCENARIOS) {
  const ledgerDir = mkdtempSync(join(work, `${sc.id}-`));
  const gateway = new SampleDataGateway({ ledgerDir });
  const store = new DecisionStore();
  const { deps, out: before } = await decideAll(gateway, new LocalMemory(join(ledgerDir, "memory.json")), store);

  const refs = sc.file ? await gateway.applyChange(sc.file) : await gateway.applyChangeRows(sc.rows as never, `eval:${sc.id}`);
  const reports = [];
  for (const ref of refs) reports.push(await reopenFor(deps, store, ref));
  const dependents = new Set(reports.flatMap((r) => r.dependents));
  const reopened = reports.flatMap((r) => r.reopened);
  const reopenedSubjects = new Set(reopened.map((r) => r.new.subject_id));

  // Ground truth: everything re-decided from scratch on the changed data, with its own empty memory.
  const truthGateway = new SampleDataGateway({ ledgerDir: mkdtempSync(join(work, `${sc.id}-truth-`)) });
  if (sc.file) await truthGateway.applyChange(sc.file);
  else await truthGateway.applyChangeRows(sc.rows as never, `eval:${sc.id}`);
  const { out: after } = await decideAll(truthGateway, new LocalMemory());
  const changed = SUPPLIERS.filter((id) => outcome(before.get(id)!) !== outcome(after.get(id)!));
  const missed = changed.filter((id) => !reopenedSubjects.has(id));
  // A reopened decision should land where a from-scratch decision on the new data lands.
  const disagree = reopened.filter((r) => outcome(r.new) !== outcome(after.get(r.new.subject_id)!)).map((r) => r.new.subject_id);
  const tables = [...new Set(refs.map((r) => r.table))];
  const tableLevel = SUPPLIERS.filter((id) => tables.some((t) => readsTable(before.get(id)!, t))).length;

  const row = {
    scenario: sc.id, what: sc.what, real: sc.real, changed_rows: refs,
    decisions: SUPPLIERS.length, table_level_reruns: tableLevel,
    dependents: dependents.size, reopened: reopened.length,
    reopened_detail: reopened.map((r) => ({ subject: r.new.subject_id, was: outcome(before.get(r.new.subject_id)!), now: outcome(r.new), fired: r.fired })),
    outcome_changed: changed.map((id) => ({ subject: id, was: outcome(before.get(id)!), now: outcome(after.get(id)!) })),
    missed, disagree_with_full_redecide: disagree,
    not_rerun: SUPPLIERS.length - reopened.length,
  };
  rows.push(row);
  console.log(`${sc.id}: ${dependents.size} depend on the row, ${reopened.length} reopened (${row.reopened_detail.map((r) => `${r.subject} ${r.was} → ${r.now}`).join("; ") || "none"}); ` +
    `${changed.length} changed under a full re-decide; missed ${missed.length}${disagree.length ? `; DISAGREE ${disagree.join(", ")}` : ""}`);
}

const total = (k: string) => rows.reduce((n, r) => n + Number(r[k]), 0);
const changedTotal = rows.reduce((n, r) => n + (r.outcome_changed as unknown[]).length, 0);
const missedTotal = rows.reduce((n, r) => n + (r.missed as unknown[]).length, 0);
const disagreeTotal = rows.reduce((n, r) => n + (r.disagree_with_full_redecide as unknown[]).length, 0);
const summary = {
  scenarios: rows.length, decisions_each: SUPPLIERS.length,
  reruns: { full: SUPPLIERS.length * rows.length, table_level: total("table_level_reruns"), tripwire: total("reopened") },
  dependents_checked: total("dependents"),
  outcome_changed: changedTotal, missed: missedTotal, disagree_with_full_redecide: disagreeTotal,
  live_cost_per_decision: live,
};
const avoided = summary.reruns.full - summary.reruns.tripwire;

const table = [
  "| Change | Real or synthetic | Decisions that read the row | Reopened | Outcome changed under a full re-decide | Missed | Re-runs: everything / same table / Tripwire |",
  "|---|---|---|---|---|---|---|",
  ...rows.map((r: any) => `| ${r.what} | ${r.real ? "real" : "synthetic"} | ${r.dependents} | ${r.reopened}${r.reopened_detail.length ? ` (${r.reopened_detail.map((x: any) => `${x.subject}: ${x.was} → ${x.now}`).join("; ")})` : ""} | ${r.outcome_changed.length}${r.outcome_changed.length ? ` (${r.outcome_changed.map((x: any) => x.subject).join(", ")})` : ""} | ${r.missed.length} | ${r.decisions} / ${r.table_level_reruns} / ${r.reopened} |`),
  `| **All ${rows.length} changes** | | ${summary.dependents_checked} | **${summary.reruns.tripwire}** | ${changedTotal} | **${missedTotal}** | ${summary.reruns.full} / ${summary.reruns.table_level} / **${summary.reruns.tripwire}** |`,
];
console.log("\n" + table.join("\n"));
const costLine = live
  ? `At the shipped graph's measured cost per decision in the live run of ${live.recorded} (${live.calls.toFixed(1)} model calls, ${Math.round(live.tokens).toLocaleString()} tokens, ${live.model_s.toFixed(0)} s of model time; provider: ${live.providers.join(", ")}), ` +
    `the ${avoided} re-runs not made are about ${Math.round(avoided * live.calls)} model calls, ${Math.round(avoided * live.tokens).toLocaleString()} tokens and ${Math.round((avoided * live.model_s) / 60)} minutes of model time.`
  : "No live cost figures in eval/results.json, so model cost is not estimated.";
console.log(costLine);

if (process.argv.includes("--write")) {
  writeFileSync(join(ROOT, "eval/reopen_results.json"), JSON.stringify({ generated_at: new Date().toISOString(), summary, rows }, null, 2) + "\n");
  writeFileSync(join(ROOT, "eval/REOPEN.md"), [
    "# Selective reopen: what a source change costs", "",
    `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by \`npx tsx scripts/eval_reopen.ts --write\`.`, "",
    `For each change, all ${SUPPLIERS.length} suppliers are first decided on the data before it, with the rows each decision read recorded in memory. ` +
    "The change is applied and the Watcher reopens what it thinks is affected: memory names the decisions that read the changed row, code checks only their tripwires, and only those that fire are re-decided. " +
    `As ground truth, all ${SUPPLIERS.length} are then re-decided from scratch on the changed data; "Outcome changed" lists those whose label or escalation differs from before. ` +
    "A decision whose outcome changed but was not reopened is a miss.", "",
    ...table, "",
    `Over ${rows.length} changes, Tripwire re-ran ${summary.reruns.tripwire} decisions where re-deciding everything takes ${summary.reruns.full} and re-deciding everything that reads the changed table takes ${summary.reruns.table_level}. ` +
    `It missed ${missedTotal} of the ${changedTotal} decisions whose outcome changed${disagreeTotal ? `, and ${disagreeTotal} reopened decisions landed somewhere other than a from-scratch decision` : ", and every reopened decision landed where a from-scratch decision on the new data lands"}.`, "",
    costLine, "",
    "How to read it:",
    "- Decisions here use the rule-based policy, so the run is exact and needs no key. Which decisions get reopened is decided in code (lineage, then tripwires), never by a model, so the selectivity is the same whichever model then decides. The cost line multiplies the re-runs avoided by the live run's measured average; it is an estimate, not a separate measurement.",
    "- The ground truth is the rule-based policy too. A model deciding from scratch could change an outcome that no tripwire watches (for example, moving Celanese from dual-source to exit after the spend jump); the tripwires are the line the buyer agreed to, and anything they do not cover is not re-run. That is the trade the design makes, and this table does not measure it.",
    "- A reopened decision can keep its label: a tripwire fired, so the case was looked at again, but the new evidence was not enough to change it.",
    "- The Watcher also reads the current rows for each dependent decision to check its tripwires. That is a few SQL queries per dependent, with no model call.",
    `- Five changes on ${SUPPLIERS.length} suppliers is a small set. The two SEC filings are real; the OFAC match and the two ERP changes are synthetic and labelled so in [cases.json](cases.json) and \`data/sample/changes/\`.`, "",
    "Per-change detail, including which tripwire fired, is in [reopen_results.json](reopen_results.json).", "",
  ].join("\n"));
  console.log("wrote eval/reopen_results.json and eval/REOPEN.md");
}
rmSync(work, { recursive: true, force: true });
