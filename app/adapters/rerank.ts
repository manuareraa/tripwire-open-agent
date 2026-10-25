// Nemotron rerank: orders the Analyst's findings by how much they bear on the buyer's question, so the summary leads
// with the evidence the question is about. Called on build.nvidia.com directly (Nightshift serves chat models only),
// and labelled as such in the trace. A keyword-overlap ranking is the baseline it is measured against
// (scripts/eval_rerank.ts). Never throws: on any failure the original order stands and the reason is returned.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { config } from "../config.js";

export interface RerankResult {
  /** Passage indexes, most relevant first. */
  order: number[];
  /** Relevance score per passage index (logits for the model, overlap counts for the baseline). */
  scores: number[];
  model: string;
  provider: string;
  latency_ms: number;
  fallback: boolean;
  error?: string;
  replayed_from?: string;
}

export interface Reranker {
  readonly enabled: boolean;
  rank(query: string, passages: string[]): Promise<RerankResult>;
}

const identity = (n: number) => [...Array(n).keys()];
const unranked = (n: number, model: string, provider: string, started: number, error: string): RerankResult =>
  ({ order: identity(n), scores: Array(n).fill(0), model, provider, latency_ms: Date.now() - started, fallback: true, error });

/** Hosted reranking endpoint for a model id (the id goes into the path as is, dots included; checked live 2026-10-25). NVIDIA_RERANK_URL overrides it. */
export const rerankUrl = (model: string) => config.nvidia.rerankUrl || `https://ai.api.nvidia.com/v1/retrieval/${model}/reranking`;

export class NemotronReranker implements Reranker {
  constructor(
    private apiKey = config.nvidia.apiKey,
    readonly model = config.nvidia.rerankModel,
    private timeoutMs = config.nvidia.timeoutMs,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return !!this.apiKey;
  }

  async rank(query: string, passages: string[]): Promise<RerankResult> {
    const started = Date.now();
    if (!this.apiKey) return unranked(passages.length, this.model, "nvidia", started, "no NVIDIA_API_KEY");
    if (!passages.length) return { ...unranked(0, this.model, "nvidia", started, ""), fallback: false, error: undefined };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(rerankUrl(this.model), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ model: this.model, query: { text: query }, passages: passages.map((text) => ({ text })), truncate: "END" }),
        signal: ctrl.signal,
      });
      if (!res.ok) return unranked(passages.length, this.model, "nvidia", started, `HTTP ${res.status}`);
      const data = (await res.json()) as { rankings?: { index?: number; logit?: number }[] };
      const rankings = (data.rankings ?? []).filter((r) => Number.isInteger(r.index) && r.index! >= 0 && r.index! < passages.length);
      if (!rankings.length) return unranked(passages.length, this.model, "nvidia", started, "no rankings in response");
      const scores = Array(passages.length).fill(Number.NEGATIVE_INFINITY);
      for (const r of rankings) scores[r.index!] = Number(r.logit ?? 0);
      return { order: identity(passages.length).sort((a, b) => scores[b] - scores[a] || a - b), scores, model: this.model, provider: "nvidia", latency_ms: Date.now() - started, fallback: false };
    } catch (e) {
      const reason = (e as Error).name === "AbortError" ? `timeout after ${this.timeoutMs} ms` : (e as Error).message;
      return unranked(passages.length, this.model, "nvidia", started, reason);
    } finally {
      clearTimeout(timer);
    }
  }
}

const STOP = new Set("a an and are as at be by can do does for from has have how in is it its of on or our the their them they this to was we what when which who will with would should could any".split(" "));
const words = (t: string) => t.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => !STOP.has(w)).map((w) => w.replace(/(ing|es|s)$/, "")) ?? [];

/** The baseline: count of question words (minus stop words, crude plural/-ing stripping) found in each passage. */
export class KeywordReranker implements Reranker {
  readonly enabled = true;
  async rank(query: string, passages: string[]): Promise<RerankResult> {
    const q = new Set(words(query));
    const scores = passages.map((p) => words(p).filter((w) => q.has(w)).length);
    return { order: identity(passages.length).sort((a, b) => scores[b] - scores[a] || a - b), scores, model: "keyword-overlap", provider: "code", latency_ms: 0, fallback: false };
  }
}

interface RerankRecording { v: 1; key: string; recorded_at: string; query: string; passages: string[]; result: RerankResult }
export const rerankKey = (model: string, query: string, passages: string[]) => createHash("sha256").update(JSON.stringify([model, query, passages])).digest("hex");

/** Appends every live rerank call to `file` so the eval can be replayed with no key. */
export class RecordingReranker implements Reranker {
  constructor(private inner: NemotronReranker, readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }
  get enabled() { return this.inner.enabled; }
  async rank(query: string, passages: string[]): Promise<RerankResult> {
    const result = await this.inner.rank(query, passages);
    const rec: RerankRecording = { v: 1, key: rerankKey(this.inner.model, query, passages), recorded_at: new Date().toISOString(), query, passages, result };
    appendFileSync(this.file, JSON.stringify(rec) + "\n");
    return result;
  }
}

export class ReplayReranker implements Reranker {
  private byKey = new Map<string, RerankRecording>();
  constructor(readonly file: string, readonly model = config.nvidia.rerankModel) {
    if (!existsSync(file)) return;
    for (const l of readFileSync(file, "utf8").split("\n")) if (l.trim()) {
      const r = JSON.parse(l) as RerankRecording;
      if (!r.result.fallback) this.byKey.set(r.key, r);
    }
  }
  get enabled() { return this.byKey.size > 0; }
  get size() { return this.byKey.size; }
  get recordedAt() { return [...this.byKey.values()][0]?.recorded_at; }
  async rank(query: string, passages: string[]): Promise<RerankResult> {
    const r = this.byKey.get(rerankKey(this.model, query, passages));
    if (!r) return unranked(passages.length, this.model, "nvidia", Date.now(), "replay: no recorded rerank for this query");
    return { ...r.result, replayed_from: r.recorded_at };
  }
}
