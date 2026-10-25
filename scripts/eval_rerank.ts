// Does Nemotron rerank put the evidence a buyer's question is about at the top? For each question in
// eval/rerank_gold.json, the findings of each listed supplier (the same claims the Analyst writes) are ranked by
// Nemotron rerank and by keyword overlap, and code scores both against the gold labels: hit@1, recall@3 and MRR.
//
// Live (NVIDIA_API_KEY set): calls build.nvidia.com directly (Nightshift serves chat models only) and records every
// call to eval/recordings/rerank.jsonl. No key: the recording is replayed, and the report says so. Neither: only the
// keyword baseline is scored.
// Usage: npx tsx scripts/eval_rerank.ts [--recordings dir] [--overwrite] [--write]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "tripwire-rerank-"));
Object.assign(process.env, { LOG_DIR: join(work, "logs"), TRACE_STDOUT: "false" });

const { config } = await import("../app/config.js");
const { KeywordReranker, NemotronReranker, RecordingReranker, ReplayReranker } = await import("../app/adapters/rerank.js");
const { RulesOnlyClient } = await import("../app/adapters/model.js");
const { SampleDataGateway } = await import("../app/adapters/sample_data.js");
const { LocalMemory } = await import("../app/adapters/local_memory.js");
const { newState } = await import("../app/orchestration/graph.js");
const { ORDER } = await import("../app/agents/planner.js");
const { gather } = await import("../app/agents/analyst.js");
const { Tracer } = await import("../app/tracing.js");
import type { Reranker } from "../app/adapters/rerank.js";

interface Gold { suppliers: string[]; questions: { id: string; q: string; relevant: string[] }[] }
const gold: Gold = JSON.parse(readFileSync(join(ROOT, "eval/rerank_gold.json"), "utf8"));
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const recDir = arg("--recordings") ?? join(ROOT, "eval/recordings");
const file = join(recDir, "rerank.jsonl");

let model: Reranker | undefined;
let mode = "skipped (no NVIDIA_API_KEY and no recording)";
mkdirSync(recDir, { recursive: true });
if (config.nvidia.apiKey && process.env.SAMPLE_MODE !== "true") {
  if (existsSync(file)) {
    if (!process.argv.includes("--overwrite")) throw new Error(`${file} exists; pass --overwrite to keep it as .bak and record a new run`);
    renameSync(file, `${file}.bak`);
  }
  model = new RecordingReranker(new NemotronReranker(), file);
  mode = `live, ${config.nvidia.rerankModel} on build.nvidia.com (direct)`;
} else {
  const replay = new ReplayReranker(file);
  if (replay.size) {
    model = replay;
    mode = `replay of a live run of ${config.nvidia.rerankModel} recorded ${replay.recordedAt?.slice(0, 10)}`;
  }
}
const keyword = new KeywordReranker();

// The pool for each supplier: exactly the claims the Analyst writes for it.
const pools: { subject: string; metrics: string[]; claims: string[] }[] = [];
for (const subject of gold.suppliers) {
  const ledgerDir = mkdtempSync(join(work, "ledger-"));
  const deps = { gateway: new SampleDataGateway({ ledgerDir }), model: new RulesOnlyClient(), memory: new LocalMemory(join(ledgerDir, "m.json")), tracer: new Tracer() };
  const s = newState(deps.tracer.run_id, subject, "eval");
  s.plan = [...ORDER];
  await gather(deps, s);
  pools.push({ subject, metrics: s.findings.map((f) => f.metric), claims: s.findings.map((f) => f.claim) });
}

const score = (order: number[], metrics: string[], relevant: string[]) => {
  const ranked = order.map((i) => metrics[i]);
  const rel = relevant.filter((m) => metrics.includes(m));
  const first = ranked.findIndex((m) => rel.includes(m));
  return {
    hit1: rel.includes(ranked[0]) ? 1 : 0,
    recall3: rel.length ? ranked.slice(0, 3).filter((m) => rel.includes(m)).length / Math.min(rel.length, 3) : 0,
    rr: first < 0 ? 0 : 1 / (first + 1),
    top3: ranked.slice(0, 3),
  };
};

type Score = ReturnType<typeof score>;
const rows: { question: string; subject: string; relevant: string[]; keyword: Score; model?: Score }[] = [];
let unanswered = 0;
let firstError: string | undefined;
for (const g of gold.questions) for (const p of pools) {
  const kw = await keyword.rank(g.q, p.claims);
  const nm = model ? await model.rank(g.q, p.claims) : undefined;
  if (nm?.fallback) { unanswered++; firstError ??= nm.error; }
  rows.push({
    question: g.id, subject: p.subject, relevant: g.relevant,
    keyword: score(kw.order, p.metrics, g.relevant),
    model: nm && !nm.fallback ? score(nm.order, p.metrics, g.relevant) : undefined,
  });
}
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null);
const agg = (key: "keyword" | "model") => {
  const set = rows.map((r) => r[key]).filter((x): x is NonNullable<typeof x> => !!x);
  return { n: set.length, hit_at_1: mean(set.map((x) => x.hit1)), recall_at_3: mean(set.map((x) => x.recall3)), mrr: mean(set.map((x) => x.rr)) };
};
const summary = { mode, questions: gold.questions.length, suppliers: gold.suppliers, pool_size: pools.map((p) => p.claims.length), keyword: agg("keyword"), model: agg("model"), unanswered };

console.log(`rerank: ${mode}`);
console.log(`pairs: ${rows.length} (${gold.questions.length} questions x ${gold.suppliers.length} suppliers, ${pools[0]?.claims.length} findings each)`);
console.log(`              hit@1  recall@3  MRR`);
for (const k of ["keyword", "model"] as const) {
  const a = summary[k];
  console.log(`${k.padEnd(12)} ${String(a.hit_at_1 ?? "-").padStart(6)}  ${String(a.recall_at_3 ?? "-").padStart(8)}  ${String(a.mrr ?? "-").padStart(5)}  (n=${a.n})`);
}
if (unanswered) console.log(`rerank gave no answer on ${unanswered}: ${firstError}`);

if (process.argv.includes("--write")) {
  if (!model || !summary.model.n) throw new Error("--write needs a live run or a recording with answers; the baseline alone is not a rerank result");
  writeFileSync(join(ROOT, "eval/rerank_results.json"), JSON.stringify({ generated_at: new Date().toISOString(), summary, rows }, null, 2) + "\n");
  const f = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));
  writeFileSync(join(ROOT, "eval/RERANK.md"), [
    "# Rerank: does the evidence the question is about come first?", "",
    `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by \`npx tsx scripts/eval_rerank.ts --write\`: ${gold.questions.length} questions from [rerank_gold.json](rerank_gold.json) x ${gold.suppliers.length} suppliers (${rows.length} rankings of the Analyst's findings).`,
    `Rerank: ${mode}.`, "",
    "| Ranking | hit@1 | recall@3 | MRR | n |", "|---|---|---|---|---|",
    `| Keyword overlap (baseline) | ${f(summary.keyword.hit_at_1)} | ${f(summary.keyword.recall_at_3)} | ${f(summary.keyword.mrr)} | ${summary.keyword.n} |`,
    `| Nemotron rerank | ${f(summary.model.hit_at_1)} | ${f(summary.model.recall_at_3)} | ${f(summary.model.mrr)} | ${summary.model.n} |`, "",
    "hit@1: the top finding answers the question. recall@3: share of the relevant findings in the top three. MRR: 1 / rank of the first relevant finding, averaged.", "",
    ...(unanswered ? [`Rerank gave no answer on ${unanswered} of ${rows.length}; those are left out of its row.`, ""] : []),
    "## Per question", "", "| Question | Supplier | Relevant | Keyword top 3 | Rerank top 3 |", "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.question} | ${r.subject} | ${r.relevant.join(", ")} | ${r.keyword.top3.join(", ")} | ${r.model?.top3.join(", ") ?? "no answer"} |`), "",
  ].join("\n"));
  console.log("wrote eval/rerank_results.json and eval/RERANK.md");
}
