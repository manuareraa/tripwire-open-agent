// Offline end-to-end check with the real H-MEM adapter: decide all 20 sample suppliers, apply change 02, reopen.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.LOG_DIR ??= mkdtempSync(join(tmpdir(), "tw-log-"));
process.env.TRACE_STDOUT = "false";
const { SampleDataGateway } = await import("../app/adapters/sample_data.js");
const { HmemMemoryStore } = await import("../app/adapters/hmem.js");
const { RulesOnlyClient } = await import("../app/adapters/model.js");
const { Tracer } = await import("../app/tracing.js");
const { DecisionStore } = await import("../app/store.js");
const { runDecide } = await import("../app/orchestration/graph.js");
const { reopenFor } = await import("../app/watcher.js");

const tmp = mkdtempSync(join(tmpdir(), "tw-smoke-"));
const gateway = new SampleDataGateway({ ledgerDir: join(tmp, "ledger") });
const memory = new HmemMemoryStore({ persistDir: join(tmp, "memory") });
const deps = { gateway, model: new RulesOnlyClient(), memory, tracer: new Tracer() };
const store = new DecisionStore();
const tally: Record<string, number> = {};
for (let i = 1; i <= 20; i++) {
  const id = `SUP-${String(i).padStart(2, "0")}`;
  const { decision } = await runDecide(deps, id, "Keep, dual-source or exit this supplier?");
  store.put(decision);
  tally[decision.decision] = (tally[decision.decision] ?? 0) + 1;
  if (process.env.VERBOSE) console.log(id, decision.decision, decision.confidence, decision.risk, decision.rationale.slice(0, 110));
}
console.log("decisions:", tally);
const rows = await gateway.applyChange("02_spend_share_jump.json").catch(async () => gateway.applyChange(gateway.listChangeFiles()[1]));
for (const r of rows) {
  const rep = await reopenFor(deps, store, r);
  console.log("change", r, "dependents", rep.dependents.length, "reopened", rep.reopened.map((x) => x.new.subject_id), "work_saved", rep.work_saved);
}
const sponsors = new Set(deps.tracer.all().map((e) => e.sponsor).filter(Boolean));
console.log("sponsors in trace:", [...sponsors]);
