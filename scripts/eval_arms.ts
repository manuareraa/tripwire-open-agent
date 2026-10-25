// Measured comparison: the same cases through five set-ups ("arms"), scored by code on the same checks.
//
//   rules            no model at all: the rule-based policy every model step falls back to
//   ultra_alone      one Nemotron Ultra call with the same metrics and source dates; no planner, critic or guard
//   lightning_only   the full Tripwire graph, but the reasoning steps run on Lightning instead of Ultra
//   tripwire         the full Tripwire graph as shipped (thinking on only when the Risk Officer says high risk)
//   thinking_always  the full graph with thinking on for every reasoning step
//
// Cases and their expected labels are in eval/cases.json, written from the policy before any run.
// Live (Nightshift answering): every arm's calls are recorded to eval/recordings/<arm>.jsonl.
// No live model: an arm with a recording is replayed from it (and the report says so); an arm without one is skipped.
// Usage: npx tsx scripts/eval_arms.ts [--arms rules,tripwire] [--cases SUP-08,SUP-18] [--recordings dir] [--overwrite] [--write]
//   --write saves eval/results.json and eval/RESULTS.md; without it the table is only printed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "tripwire-eval-"));
Object.assign(process.env, { LOG_DIR: join(work, "logs"), TRACE_STDOUT: "false" });

const { config } = await import("../app/config.js");
const { DEFAULT_MODELS, FallbackModelClient, NemotronClient, NightshiftClient, RulesOnlyClient, extractJson } = await import("../app/adapters/model.js");
const { RecordingModelClient, ReplayModelClient, readRecordings } = await import("../app/adapters/recording.js");
const { SampleDataGateway } = await import("../app/adapters/sample_data.js");
const { LocalMemory } = await import("../app/adapters/local_memory.js");
const { newState, runDecide } = await import("../app/orchestration/graph.js");
const { callModel } = await import("../app/orchestration/state.js");
const { ORDER } = await import("../app/agents/planner.js");
const { gather } = await import("../app/agents/analyst.js");
const { reviewFreshness, unsupportedNumbers } = await import("../app/agents/critic.js");
const { RISK_THRESHOLDS } = await import("../app/agents/risk.js");
const { METRICS } = await import("../app/metrics.js");
const { reviewTripwires } = await import("../app/tripwires.js");
const { FRESHNESS_PREFIX } = await import("../app/freshness.js");
const { Tracer } = await import("../app/tracing.js");
import type { ModelCall, ModelClient, ModelRequest, ModelResponse } from "../app/types.js";
import type { SourceFreshness } from "../app/freshness.js";
import type { MetricValue } from "../app/metrics.js";
import type { TripwireDraft } from "../app/tripwires.js";

interface Case { id: string; subject: string; expect?: string[]; escalate?: boolean; why?: string; change_file?: string; rows?: { table: string; key: string; row: Record<string, unknown> }[] }
interface Outcome { decision?: string; confidence?: number; rationale: string; tripwires: TripwireDraft[]; limitations: string[]; escalated: boolean; metrics: MetricValue[]; sources: SourceFreshness[]; calls: ModelCall[]; rules: boolean }

const ARMS = ["rules", "ultra_alone", "lightning_only", "tripwire", "thinking_always"] as const;
type Arm = (typeof ARMS)[number];
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const arms = (arg("--arms")?.split(",") ?? [...ARMS]) as Arm[];
const allCases: Case[] = JSON.parse(readFileSync(join(ROOT, "eval/cases.json"), "utf8")).cases;
const pick = arg("--cases")?.split(",");
const cases = pick ? allCases.filter((c) => pick.includes(c.id)) : allCases;
const recDir = arg("--recordings") ?? join(ROOT, "eval/recordings");
const QUESTION = "Keep, dual-source or exit this supplier?";

/** Thinking on for every reasoning step, with the same token budget the Decider gives a high-risk case. */
class ThinkingAlways implements ModelClient {
  constructor(private inner: ModelClient) {}
  get enabled() { return this.inner.enabled; }
  complete(req: ModelRequest): Promise<ModelResponse> {
    return this.inner.complete(req.tier === "reasoning" ? { ...req, thinking: true, max_tokens: Math.max(req.max_tokens ?? 0, 6000) } : req);
  }
}

// One live client for the whole run, or none.
let live: ModelClient | undefined;
if (config.useNightshift) {
  const ns = new NightshiftClient();
  const d = await ns.discover();
  if (d.status === "online") live = process.argv.includes("--allow-backup") && config.useNvidiaDirect ? new FallbackModelClient(ns, new NemotronClient()) : ns;
  else console.log(`Nightshift ${d.status} (${d.detail}); arms with a recording are replayed, the rest skipped`);
}
mkdirSync(recDir, { recursive: true });

function clientFor(arm: Arm): { model?: ModelClient; mode: string } {
  if (arm === "rules") return { model: new RulesOnlyClient(), mode: "rules" };
  const file = join(recDir, `${arm}.jsonl`);
  if (live) {
    if (existsSync(file)) {
      if (!process.argv.includes("--overwrite")) throw new Error(`${file} exists; pass --overwrite to keep it as .bak and record a new run`);
      renameSync(file, `${file}.bak`);
    }
    const rec = new RecordingModelClient(live, file);
    return { model: arm === "thinking_always" ? new ThinkingAlways(rec) : rec, mode: "live" };
  }
  const replay = new ReplayModelClient(file);
  if (!replay.size) return { mode: "skipped (no live model and no recording)" };
  const first = readRecordings(file)[0]?.recorded_at.slice(0, 10);
  return { model: arm === "thinking_always" ? new ThinkingAlways(replay) : replay, mode: `replay of a live run recorded ${first}` };
}

async function setup(c: Case) {
  const ledgerDir = mkdtempSync(join(work, "ledger-"));
  const gateway = new SampleDataGateway({ ledgerDir });
  if (c.change_file) await gateway.applyChange(c.change_file);
  if (c.rows) await gateway.applyChangeRows(c.rows, `eval:${c.id}`);
  return { gateway, memory: new LocalMemory(join(ledgerDir, "memory.json")) };
}

async function runGraph(model: ModelClient, c: Case): Promise<Outcome> {
  const { gateway, memory } = await setup(c);
  const { decision: d } = await runDecide({ gateway, model, memory, tracer: new Tracer() }, c.subject, QUESTION);
  const metrics = (d.findings ?? []).map((f) => ({ metric: f.metric, value: Number(f.value) })) as MetricValue[];
  return {
    decision: d.decision, confidence: d.confidence, rationale: d.rationale ?? "", limitations: d.limitations, escalated: d.escalated,
    tripwires: d.tripwires.filter((t) => !t.metric.startsWith("backup_") && !t.metric.startsWith(FRESHNESS_PREFIX)), metrics, sources: d.sources ?? [], calls: d.model_calls ?? [],
    rules: (d.rationale ?? "").startsWith("Rule-based policy"),
  };
}

/** The single-call baseline: what one strong model does with the same numbers and source dates, and nothing else. */
async function runUltraAlone(model: ModelClient, c: Case): Promise<Outcome> {
  const { gateway, memory } = await setup(c);
  const deps = { gateway, model, memory, tracer: new Tracer() };
  const s = newState(deps.tracer.run_id, c.subject, QUESTION);
  s.plan = [...ORDER];
  await gather(deps, s);
  reviewFreshness(deps, s);
  const res = await callModel(deps, s, {
    tier: "reasoning", agent_name: "SingleCall", json: true, max_tokens: 1200,
    system:
      "You decide what a buyer should do with a supplier: keep, dual_source (add a second supplier) or exit. Base it only on the data given. " +
      "Set 2-4 tripwires: future conditions that should reopen the decision, not already true today, using only the metric names given. " +
      "List any source that is out of date or missing under limitations. Set escalate to true when a human must review before acting. " +
      'Reply only with JSON: {"decision": "keep|dual_source|exit", "confidence": 0-1, "rationale": "2-3 sentences, quoting only given numbers", ' +
      '"tripwires": [{"metric": "...", "op": "<" or ">", "threshold": number}], "limitations": ["..."], "escalate": true|false}',
    user:
      `Supplier ${c.subject}. Question: ${QUESTION}\nMetrics (today):\n${s.metrics.map((m) => `- ${m.metric} = ${m.value}`).join("\n")}\n` +
      `Metric meanings: ${METRICS.map((m) => `${m.name} (${m.label}; worse when ${m.worseWhen})`).join("; ")}\n` +
      `Sources: ${s.freshness.map((f) => `${f.label} as of ${f.as_of ?? "unknown"} (${f.status}; policy line ${f.max_age_days} days)`).join("; ")}`,
  });
  const p = res.fallback ? undefined : extractJson<Record<string, unknown>>(res.text);
  const kind = String(p?.decision ?? "").toLowerCase().replace(/[\s-]/g, "_");
  return {
    decision: ["keep", "dual_source", "exit"].includes(kind) ? kind : undefined,
    confidence: p ? Number(p.confidence) : undefined,
    rationale: String(p?.rationale ?? ""),
    tripwires: Array.isArray(p?.tripwires) ? (p!.tripwires as Record<string, unknown>[]).map((t) => ({ metric: String(t.metric ?? ""), op: t.op as TripwireDraft["op"], threshold: t.threshold === undefined ? undefined : Number(t.threshold) })) : [],
    limitations: Array.isArray(p?.limitations) ? (p!.limitations as unknown[]).map(String) : [],
    escalated: p?.escalate === true,
    metrics: s.metrics, sources: s.freshness, calls: s.modelCalls, rules: false,
  };
}

const STALE_WORDS = /stale|out of date|outdated|older than|not current|missing|old data|past its|as of/i;
function score(c: Case, o: Outcome) {
  const thresholds = o.tripwires.map((t) => t.threshold).filter((x): x is number => typeof x === "number");
  const notFresh = o.sources.filter((f) => f.status !== "fresh");
  const lim = o.limitations.join(" ");
  const checks: Record<string, boolean | null> = {
    valid: !!o.decision && o.confidence !== undefined && o.confidence >= 0 && o.confidence <= 1,
    grounded: !!o.decision && unsupportedNumbers(o.rationale, o.metrics, [...thresholds, ...RISK_THRESHOLDS]).length === 0,
    tripwires: o.tripwires.length >= 2 && o.tripwires.length <= 4 && reviewTripwires(o.tripwires, o.metrics).length === 0,
    stale_named: notFresh.length ? notFresh.every((f) => lim.toLowerCase().includes(f.label.toLowerCase()) || lim.includes(f.table)) || STALE_WORDS.test(lim) : null,
    escalated: c.escalate ? o.escalated : null,
    label: c.expect ? !!o.decision && c.expect.includes(o.decision) : null,
  };
  return checks;
}

const results: Record<string, unknown>[] = [];
const summary: Record<string, unknown>[] = [];
for (const arm of arms) {
  const { model, mode } = clientFor(arm);
  if (!model) {
    summary.push({ arm, mode });
    console.log(`${arm}: ${mode}`);
    continue;
  }
  const saved = { ns: config.nightshift.reasoningModel, nv: config.nvidia.reasoningModel };
  if (arm === "lightning_only") {
    config.nightshift.reasoningModel = config.nightshift.smallModel || DEFAULT_MODELS.small;
    config.nvidia.reasoningModel = config.nvidia.smallModel || DEFAULT_MODELS.small;
  }
  const started = Date.now();
  const rows: { checks: Record<string, boolean | null>; rule_based_decision: boolean; calls: number; fallbacks: number; tokens_in: number; tokens_out: number; model_ms: number; served: string[] }[] = [];
  try {
    for (const c of cases) {
      const t0 = Date.now();
      const o = arm === "ultra_alone" ? await runUltraAlone(model, c) : await runGraph(model, c);
      const checks = score(c, o);
      const answered = o.calls.filter((x) => !x.fallback);
      const row = {
        arm, case: c.id, decision: o.decision ?? "(invalid)", confidence: o.confidence, checks, rule_based_decision: o.rules,
        calls: o.calls.length, fallbacks: o.calls.length - answered.length,
        tokens_in: answered.reduce((n, x) => n + x.tokens_in, 0), tokens_out: answered.reduce((n, x) => n + x.tokens_out, 0),
        model_ms: answered.reduce((n, x) => n + x.latency_ms, 0), wall_ms: Date.now() - t0,
        served: [...new Set(answered.map((x) => x.model))],
      };
      rows.push(row);
      results.push(row);
      const failed = Object.entries(checks).filter(([, v]) => v === false).map(([k]) => k);
      console.log(`${arm} ${c.id}: ${row.decision}${failed.length ? `  FAILED ${failed.join(", ")}` : ""}`);
    }
  } finally {
    config.nightshift.reasoningModel = saved.ns;
    config.nvidia.reasoningModel = saved.nv;
  }
  const rate = (k: string) => {
    const applicable = rows.filter((r) => r.checks[k] !== null);
    return { passed: applicable.filter((r) => r.checks[k]).length, of: applicable.length };
  };
  summary.push({
    arm, mode, cases: rows.length,
    label: rate("label"), valid: rate("valid"), grounded: rate("grounded"), tripwires: rate("tripwires"), stale_named: rate("stale_named"), escalated: rate("escalated"),
    rule_based_decisions: rows.filter((r) => r.rule_based_decision).length,
    calls: rows.reduce((n, r) => n + r.calls, 0), fallbacks: rows.reduce((n, r) => n + r.fallbacks, 0),
    tokens_in: rows.reduce((n, r) => n + r.tokens_in, 0), tokens_out: rows.reduce((n, r) => n + r.tokens_out, 0),
    model_s: Math.round(rows.reduce((n, r) => n + r.model_ms, 0) / 1000), wall_s: Math.round((Date.now() - started) / 1000),
    served: [...new Set(rows.flatMap((r) => r.served))],
  });
}

const frac = (x?: { passed: number; of: number }) => (x && x.of ? `${x.passed}/${x.of}` : "–");
const lines = [
  "| Arm | Run | Expected label | Valid | Numbers grounded | Tripwires valid | Stale source named | Escalated when required | Rule-based decisions | Model calls (fallbacks) | Tokens in / out | Model time |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...summary.map((s: any) => s.cases === undefined
    ? `| ${s.arm} | ${s.mode} | | | | | | | | | | |`
    : `| ${s.arm} | ${s.mode} | ${frac(s.label)} | ${frac(s.valid)} | ${frac(s.grounded)} | ${frac(s.tripwires)} | ${frac(s.stale_named)} | ${frac(s.escalated)} | ${s.rule_based_decisions}/${s.cases} | ${s.calls} (${s.fallbacks}) | ${s.tokens_in.toLocaleString()} / ${s.tokens_out.toLocaleString()} | ${s.model_s} s |`),
];
console.log("\n" + lines.join("\n"));
for (const s of summary as any[]) if (s.served?.length) console.log(`${s.arm} served by: ${s.served.join(", ")}`);

if (process.argv.includes("--write")) {
  writeFileSync(join(ROOT, "eval/results.json"), JSON.stringify({ generated_at: new Date().toISOString(), cases: cases.map((c) => c.id), summary, results }, null, 2) + "\n");
  writeFileSync(join(ROOT, "eval/RESULTS.md"), [
    "# Measured comparison", "",
    `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by \`npx tsx scripts/eval_arms.ts --write\` over ${cases.length} cases from [cases.json](cases.json).`,
    "Each arm's \"Run\" column says whether it ran live through Meterless Nightshift, was replayed from a recorded live run, or used no model.", "",
    ...lines, "",
    ...(summary as any[]).filter((s) => s.served?.length).map((s) => `- **${s.arm}** was answered by: ${s.served.join(", ")}`), "",
    "How to read it: expected labels exist only for clear-cut cases. The other columns are checks any good decision should pass, applied by code to every arm alike. " +
    "\"Rule-based decisions\" counts cases where the graph fell back to the rule-based policy; those pass the checks by construction, so a model arm with many of them says little about the model.",
    "Per-case rows are in [results.json](results.json).", "",
  ].join("\n"));
  console.log("wrote eval/results.json and eval/RESULTS.md");
}
rmSync(work, { recursive: true, force: true });
