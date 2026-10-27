// Records a live Nemotron run through Meterless Nightshift, so the hosted demo can replay real answers with no keys.
//
// It plays the demo story on the bundled sample data, in a throwaway data folder:
//   1. decide every supplier,  2. apply each bundled change file in order (the Watcher reopens what it must),
//   3. restore the bundled data (the Watcher re-checks again).
// Every model call is appended, with Nightshift's receipt, to data/recordings/nightshift.jsonl (or --out).
// Usage (on the machine running Nightshift; see docs/NIGHTSHIFT.md):
//   npx tsx scripts/record_live.ts [--suppliers SUP-01,SUP-05] [--no-changes] [--out file] [--allow-backup]
// The run stops before any model call unless Nightshift answers its health check. Nothing here touches Zetaris.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const out = resolve(arg("--out") ?? join(ROOT, "data/recordings/nightshift.jsonl"));
const work = mkdtempSync(join(tmpdir(), "tripwire-record-"));

// Bundled sample data only, so the prompts match what sample mode will ask when it replays.
for (const k of Object.keys(process.env)) if (k.startsWith("ZETARIS_")) delete process.env[k];
Object.assign(process.env, { DATA_DIR: work, LOG_DIR: join(work, "logs"), HMEM_DIR: join(work, "memory"), MODEL_RECORD_FILE: out, MODEL_REPLAY: "false", TRACE_STDOUT: "false" });
if (!process.argv.includes("--allow-backup")) process.env.LLM_PROVIDER = "nightshift";

const { buildRuntime } = await import("../app/runtime.js");
const { runDecide } = await import("../app/orchestration/graph.js");
const { reopenFor } = await import("../app/watcher.js");
const { Tracer } = await import("../app/tracing.js");
const { readRecordings } = await import("../app/adapters/recording.js");

const rt = await buildRuntime();
console.log(`model: ${rt.modes.model}`);
for (const n of rt.modes.notes) console.log(`  note: ${n}`);
if (!rt.modes.model.startsWith("nightshift")) {
  console.error("\nNightshift is not answering, so nothing was recorded. Check METERLESS_BASE_URL and METERLESS_RUNTIME_TOKEN (docs/NIGHTSHIFT.md).");
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

const before = readRecordings(out).length;
const started = Date.now();
const tracer = new Tracer();
const deps = { gateway: rt.gateway, model: rt.model, memory: rt.memory, tracer };
const subjects = arg("--suppliers")?.split(",") ?? rt.sample.suppliers().map((s) => s.supplier_id);

for (const id of subjects) {
  const { decision } = await runDecide(deps, id, "Keep, dual-source or exit this supplier?");
  rt.store.put(decision);
  console.log(`${id}: ${decision.decision} (${decision.confidence.toFixed(2)})`);
}
if (!process.argv.includes("--no-changes")) {
  const steps: [string, () => Promise<{ table: string; key: string }[]>][] = [
    ...rt.sample.listChangeFiles().map((f) => [f, () => rt.sample.applyChange(f)] as [string, () => Promise<{ table: string; key: string }[]>]),
    ["restore bundled data", () => rt.sample.restoreBase()],
  ];
  for (const [name, apply] of steps) {
    const reopened: string[] = [];
    for (const row of await apply()) for (const r of (await reopenFor(deps, rt.store, row)).reopened) reopened.push(`${r.new.subject_id} -> ${r.new.decision}`);
    console.log(`${name}: ${reopened.length ? `reopened ${reopened.join(", ")}` : "nothing reopened"}`);
  }
}

// An honest summary of what was recorded: answered calls, fallbacks, the models that really answered.
const recs = readRecordings(out).slice(before);
const answered = recs.filter((r) => !r.response.fallback);
const served = new Map<string, number>();
for (const r of answered) served.set(r.response.model, (served.get(r.response.model) ?? 0) + 1);
console.log(`\nrecorded ${recs.length} calls to ${out} in ${((Date.now() - started) / 1000).toFixed(0)} s`);
console.log(`  answered by a model: ${answered.length}; fell back to rules: ${recs.length - answered.length}`);
console.log(`  with a Nightshift receipt: ${answered.filter((r) => r.response.receipt).length}`);
console.log(`  tokens in/out: ${answered.reduce((n, r) => n + r.response.tokens_in, 0)} / ${answered.reduce((n, r) => n + r.response.tokens_out, 0)}`);
for (const [m, n] of served) console.log(`  ${m}: ${n}`);
for (const r of recs.filter((x) => x.response.fallback).slice(0, 5)) console.log(`  fallback ${r.agent_name}: ${r.response.error}`);
rmSync(work, { recursive: true, force: true });
