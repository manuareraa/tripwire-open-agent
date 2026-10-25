// Nemotron rerank: parses the hosted response, never throws, orders the Analyst's findings without dropping any,
// says in the trace where the order came from, and changes nothing when no reranker is set.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeywordReranker, NemotronReranker, RecordingReranker, ReplayReranker, rerankUrl, type Reranker } from "../app/adapters/rerank.js";
import { SampleDataGateway } from "../app/adapters/sample_data.js";
import { FakeMemory } from "./fakes.js";
import type { Deps } from "../app/orchestration/state.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../app/types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let runDecide: typeof import("../app/orchestration/graph.js").runDecide;
let Tracer: typeof import("../app/tracing.js").Tracer;
const tmpDirs: string[] = [];
const tmp = (prefix: string, from?: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (from) cpSync(from, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
};
beforeAll(async () => {
  process.env.LOG_DIR = mkdtempSync(join(tmpdir(), "tw-"));
  process.env.TRACE_STDOUT = "false";
  ({ runDecide } = await import("../app/orchestration/graph.js"));
  ({ Tracer } = await import("../app/tracing.js"));
});
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Captures the Analyst's summary prompt; answers nothing else, so the rest of the graph runs on rules. */
class CaptureAnalyst implements ModelClient {
  readonly enabled = true;
  analystPrompt = "";
  async complete(req: ModelRequest): Promise<ModelResponse> {
    if (req.agent_name === "Analyst") this.analystPrompt = req.user;
    return { text: "", model: "m", thinking: false, tokens_in: 0, tokens_out: 0, latency_ms: 0, fallback: true, error: "test" };
  }
}

/** Puts the sanctions finding first, whatever the question. */
const sanctionsFirst: Reranker = {
  enabled: true,
  async rank(_q, passages) {
    const i = passages.findIndex((p) => /OFAC/.test(p));
    const order = [i, ...passages.keys()].filter((x, k, a) => x >= 0 && a.indexOf(x) === k);
    return { order, scores: passages.map((_, k) => (k === i ? 5 : 0)), model: "nvidia/nemotron-3.5-rerank-8b", provider: "nvidia", latency_ms: 3, fallback: false };
  },
};

const deps = (model: ModelClient, reranker?: Reranker): Deps => ({
  gateway: new SampleDataGateway({ ledgerDir: tmp("tw-ledger-"), sampleDir: tmp("tw-sample-", join(REPO_ROOT, "data/sample")) }),
  model, memory: new FakeMemory(), tracer: new Tracer(), reranker,
});

describe("Nemotron rerank", () => {
  it("sends the hosted schema and orders by logit", async () => {
    let sent: { url: string; body: any } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return json({ rankings: [{ index: 2, logit: 1.5 }, { index: 0, logit: -0.2 }, { index: 1, logit: -3 }] });
    }) as unknown as typeof fetch;
    const r = await new NemotronReranker("k", "nvidia/nemotron-3.5-rerank-8b", 1000, fake).rank("q", ["a", "b", "c"]);
    expect(sent!.url).toBe("https://ai.api.nvidia.com/v1/retrieval/nvidia/nemotron-3_5-rerank-8b/reranking");
    expect(sent!.body).toEqual({ model: "nvidia/nemotron-3.5-rerank-8b", query: { text: "q" }, passages: [{ text: "a" }, { text: "b" }, { text: "c" }], truncate: "END" });
    expect(r).toMatchObject({ order: [2, 0, 1], fallback: false, provider: "nvidia" });
    expect(rerankUrl("nvidia/llama-nemotron-rerank-1b-v2")).toContain("/nvidia/llama-nemotron-rerank-1b-v2/reranking");
  });

  it("keeps the original order on errors, with the reason", async () => {
    const fail = (async () => json({}, 403)) as unknown as typeof fetch;
    expect(await new NemotronReranker("k", "m", 1000, fail).rank("q", ["a", "b"])).toMatchObject({ order: [0, 1], fallback: true, error: "HTTP 403" });
    expect(await new NemotronReranker("", "m").rank("q", ["a"])).toMatchObject({ fallback: true, error: "no NVIDIA_API_KEY" });
  });

  it("records and replays a live ranking", async () => {
    const file = join(tmp("tw-rr-"), "rerank.jsonl");
    const fake = (async () => json({ rankings: [{ index: 1, logit: 2 }, { index: 0, logit: 1 }] })) as unknown as typeof fetch;
    await new RecordingReranker(new NemotronReranker("k", "m", 1000, fake), file).rank("q", ["a", "b"]);
    const replay = new ReplayReranker(file, "m");
    expect((await replay.rank("q", ["a", "b"])).order).toEqual([1, 0]);
    expect((await replay.rank("q", ["a", "b"])).replayed_from).toBeTruthy();
    expect(await replay.rank("other", ["a", "b"])).toMatchObject({ fallback: true });
  });

  it("the keyword baseline scores word overlap", async () => {
    const r = await new KeywordReranker().rank("What share of our spend goes to them?", ["Current ratio: 1.2", "Share of our category spend: 31%"]);
    expect(r.order[0]).toBe(1);
  });

  it("orders the Analyst's findings for the question, keeps every finding, and says so in the trace", async () => {
    const plain = new CaptureAnalyst();
    await runDecide(deps(plain), "SUP-05", "Any compliance concerns?");
    const ranked = new CaptureAnalyst();
    const d = deps(ranked, sanctionsFirst);
    await runDecide(d, "SUP-05", "Any compliance concerns?");

    const lines = (p: string) => p.split("\n").filter((l) => l.startsWith("- "));
    expect(plain.analystPrompt).toContain("Findings:\n");
    expect(ranked.analystPrompt).toContain("Findings (most relevant to the question first):");
    expect(lines(ranked.analystPrompt)[0]).toMatch(/OFAC/);
    expect([...lines(ranked.analystPrompt)].sort()).toEqual([...lines(plain.analystPrompt)].sort());
    const ev = d.tracer.all().find((e) => e.action === "rerank_findings")!;
    expect(ev.output_summary).toMatch(/^top 3 by nvidia\/nemotron-3.5-rerank-8b via build.nvidia.com \(direct\): sanctions_matches/);
  });
});
