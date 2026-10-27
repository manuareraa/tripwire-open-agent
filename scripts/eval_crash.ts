// Crash test, measured: across all 20 sample suppliers, what share of the proposed tripwires survive (crossing the
// line really changes the call, and stopping just short of it does not), split by who proposed them.
//
// Two re-deciders, reported apart and never mixed:
//   rules   the rule-based policy re-decides (Risk Officer flags + decider rules), on the rule-based decisions. A control:
//           it shows which proposed lines the policy itself would act on. It is not a model result.
//   model   Nemotron Lightning re-decides, through the full graph. Runs only from recorded live answers
//           (data/recordings/*.jsonl with CrashTester calls); until the live recording it is reported as "not run yet".
// Usage: npx tsx scripts/eval_crash.ts [--write]
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "tripwire-crash-"));
Object.assign(process.env, { LOG_DIR: join(work, "logs"), TRACE_STDOUT: "false" });

const { config } = await import("../app/config.js");
const { RulesOnlyClient } = await import("../app/adapters/model.js");
const { ReplayModelClient, readRecordings } = await import("../app/adapters/recording.js");
const { SampleDataGateway } = await import("../app/adapters/sample_data.js");
const { LocalMemory } = await import("../app/adapters/local_memory.js");
const { runDecide } = await import("../app/orchestration/graph.js");
const { runCrash } = await import("../app/proving/crashtest.js");
const { assess } = await import("../app/agents/risk.js");
const { rulesDecision } = await import("../app/agents/decider.js");
const { Tracer } = await import("../app/tracing.js");
import type { Deps, RunState } from "../app/orchestration/state.js";
import type { Redecider } from "../app/proving/crashtest.js";
import type { TraceEvent, TripwireOrigin } from "../app/types.js";

const QUESTION = "Keep, dual-source or exit this supplier?";
const SUPPLIERS = readFileSync(join(ROOT, "data/sample/supplier_spend.csv"), "utf8").trim().split("\n").slice(1).map((l) => l.split(",")[0]);
const silent = { emit: () => ({}) } as unknown as InstanceType<typeof Tracer>;

/** The rule-based policy as a re-decider: same metrics with one moved, Risk Officer flags recomputed, rules decide. */
function rulesRedecider(s: RunState): Redecider {
  return async (_decision, today, metric, value) => {
    const clone: RunState = {
      ...s, metrics: [...today].map(([m, v]) => ({ metric: m, value: m === metric ? value : v, evidence: s.metrics.find((x) => x.metric === m)!.evidence })),
      risk: { level: "low", flags: [], thinking: false }, escalated: false, escalationReasons: [], limitations: [],
    };
    assess({ tracer: silent, model: { enabled: false } } as unknown as Deps, clone);
    const d = rulesDecision(clone);
    return { decision: d.decision, why: d.rationale.replace(/^Rule-based policy: /, "") };
  };
}

interface Row { supplier: string; decision: string; origin: TripwireOrigin | "?"; tripwire: string; verdict: string; reset?: number; summary: string }

/** One row per candidate, read from the CrashTester trace (a reset that verifies counts as verified, with the new line). */
function rowsFrom(events: readonly TraceEvent[], supplier: string, decision: string): Row[] {
  const out: Row[] = [];
  for (const e of events.filter((x) => x.agent_name === "CrashTester" && x.action === "crash_test")) {
    const d = (e.data ?? {}) as { origin?: TripwireOrigin; verdict?: string; reset_from?: number; metric?: string; tripwire?: string };
    const s = e.output_summary ?? "";
    if (d.reset_from !== undefined) {
      const last = out[out.length - 1];
      if (last && d.verdict === "verified") Object.assign(last, { verdict: "verified", reset: d.reset_from, tripwire: d.tripwire ?? last.tripwire, summary: `${last.summary} | ${s}` });
      continue;
    }
    out.push({ supplier, decision, origin: d.origin ?? "?", tripwire: d.tripwire ?? "?", verdict: d.verdict ?? "invalid", summary: s });
  }
  return out;
}

async function rulesArm(): Promise<Row[]> {
  const rows: Row[] = [];
  const gateway = new SampleDataGateway({ ledgerDir: mkdtempSync(join(work, "rules-")) });
  const deps: Deps = { gateway, model: new RulesOnlyClient(), memory: new LocalMemory(join(work, "rules-memory.json")), tracer: new Tracer() };
  for (const id of SUPPLIERS) {
    const { decision, state } = await runDecide(deps, id, QUESTION);
    const candidates = decision.tripwires
      .filter((t) => t.origin === "rules" || t.origin === "decider" || t.origin === "premortem")
      .map(({ metric, op, threshold, origin, story_id }) => ({ metric, op, threshold, origin, story_id }));
    const tracer = new Tracer();
    const s: RunState = { ...state, proving: {}, limitations: [] };
    await runCrash({ ...deps, tracer }, s, { decision: decision.decision, confidence: decision.confidence, rationale: "", tripwires: [], limitations: [], rules: true }, candidates, rulesRedecider(s));
    rows.push(...rowsFrom(tracer.all(), id, decision.decision));
  }
  return rows;
}

/** Recorded live CrashTester answers, if any; the model arm runs only on those. */
const recorded = readRecordings(join(ROOT, config.modelReplayFile)).filter((r) => r.agent_name === "CrashTester" && !r.response.fallback).length;

async function modelArm(): Promise<{ rows: Row[]; unanswered: number }> {
  const rows: Row[] = [];
  let unanswered = 0;
  const gateway = new SampleDataGateway({ ledgerDir: mkdtempSync(join(work, "model-")) });
  const tracer = new Tracer();
  const deps: Deps = { gateway, model: new ReplayModelClient(join(ROOT, config.modelReplayFile)), memory: new LocalMemory(join(work, "model-memory.json")), tracer };
  for (const id of SUPPLIERS) {
    const before = tracer.all().length;
    const { decision } = await runDecide(deps, id, QUESTION);
    const r = rowsFrom(tracer.all().slice(before), id, decision.decision);
    unanswered += r.filter((x) => x.verdict === "untested").length;
    rows.push(...r);
  }
  return { rows, unanswered };
}

function summarise(rows: Row[]) {
  const by = (key: (r: Row) => string) => {
    const groups = new Map<string, Row[]>();
    for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
    return [...groups].map(([k, g]) => {
      const tested = g.filter((r) => r.verdict !== "untested" && r.verdict !== "invalid");
      const n = (v: string) => g.filter((r) => r.verdict === v).length;
      return {
        group: k, proposed: g.length, tested: tested.length, verified_first_try: g.filter((r) => r.verdict === "verified" && r.reset === undefined).length,
        decorative: n("decorative"), mis_set_dropped: n("mis_set"),
        untested: n("untested"), already_true: n("invalid"), mis_set_reset_verified: g.filter((r) => r.reset !== undefined).length,
        survived_share: tested.length ? Math.round((n("verified") / tested.length) * 1000) / 1000 : null,
      };
    });
  };
  return { all: by(() => "all")[0] ?? null, by_origin: by((r) => r.origin), by_decision: by((r) => r.decision) };
}

const rules = await rulesArm();
const model = recorded ? await modelArm() : undefined;
const result = {
  generated_at: new Date().toISOString(),
  suppliers: SUPPLIERS.length,
  note: "Measured by scripts/eval_crash.ts on the bundled sample data (20 suppliers). survived_share = verified / tested.",
  arms: {
    rules: { label: "Control: the rule-based policy re-decides (not a model)", ...summarise(rules), rows: rules },
    model: model
      ? { label: `Nemotron Lightning re-decides (replayed from ${recorded} recorded live answers)`, unanswered_prompts: model.unanswered, ...summarise(model.rows), rows: model.rows }
      : { label: "Nemotron Lightning re-decides", status: "not run yet: no recorded live CrashTester answers" },
  },
};

const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
type Sum = ReturnType<typeof summarise>["by_origin"][number];
const table = (rowsIn: Sum[]) => [
  "| Group | Proposed | Tested | Verified | Mis-set, reset, then verified | Mis-set, dropped | Decorative | Untested | Already true today | Survived |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...rowsIn.map((r) => `| ${r.group} | ${r.proposed} | ${r.tested} | ${r.verified_first_try} | ${r.mis_set_reset_verified} | ${r.mis_set_dropped} | ${r.decorative} | ${r.untested} | ${r.already_true} | ${pct(r.survived_share)} |`),
];
const r = result.arms.rules as ReturnType<typeof summarise> & { label: string };
const md = [
  "# Crash test: do the tripwires really change the call?",
  "",
  `Generated ${result.generated_at.slice(0, 16).replace("T", " ")} UTC by \`npx tsx scripts/eval_crash.ts --write\` on the ${SUPPLIERS.length} sample suppliers.`,
  "",
  "Each proposed tripwire is pushed just past its line and just short of it, and the decision is made again with only that number moved.",
  "**Verified**: holds short of the line, changes past it. **Decorative**: still holds past the line. **Mis-set**: already changes short of the line.",
  "Survived = tripwires kept as verified (first try, or after one reset of a mis-set line) ÷ tested. Plain-language explanation: `docs/proving/CRASH.md`.",
  "",
  `## ${r.label}`,
  "",
  "The decisions here are made by the rule-based policy, and the same policy re-decides. This is a control, not a model result: it shows which proposed lines the policy itself would act on.",
  "",
  ...table(r.all ? [r.all] : []),
  "",
  "By who proposed the tripwire:",
  "",
  ...table(r.by_origin),
  "",
  "By decision:",
  "",
  ...table(r.by_decision),
  "",
  "## Nemotron Lightning re-decides",
  "",
  ...(model
    ? [`Replayed from ${recorded} recorded live answers; ${model.unanswered} prompts had no recording and are counted as untested.`, "", ...table(summarise(model.rows).by_origin)]
    : ["Not run yet: there are no recorded live CrashTester answers. It runs inside the decision graph during the live recording, and this script then replays it."]),
  "",
];

console.log(md.join("\n"));
if (process.argv.includes("--write")) {
  writeFileSync(join(ROOT, "eval/crash_results.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(join(ROOT, "eval/CRASH.md"), md.join("\n"));
}
rmSync(work, { recursive: true, force: true });
