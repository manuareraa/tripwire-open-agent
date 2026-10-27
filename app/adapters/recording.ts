// Record and replay of live model calls. A live run (Nightshift) can write every call, with the receipt that names
// the model that really answered, to a JSONL file. Sample mode can then replay those exact answers with no keys and
// no network, and every replayed call is labelled as a replay with the date it was recorded. A prompt with no
// recording is never guessed: it falls back to the rule-based path like any other missing model.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { ModelClient, ModelRequest, ModelResponse } from "../types.js";

export interface Recording {
  v: 1;
  key: string;
  recorded_at: string;
  agent_name: string;
  tier: ModelRequest["tier"];
  thinking: boolean;
  system: string;
  user: string;
  response: ModelResponse;
  /** The numbered run that made this call (scripts/runlog.ts). Older recordings have none. */
  run?: number;
}

export interface RecordingOptions {
  /** Tags every new record with this run number. */
  run?: number;
  /** Resume run N: a prompt whose newest record is an answer from run N is reused, not asked again. */
  resumeRun?: number;
  /** One line per call (agent, model, time, ok or failed) is appended here, for debugging. */
  log?: string;
}

/** Decision ids carry a timestamp, so they are blanked out before the prompt is matched. */
const normalise = (text: string) => text.replace(/DEC-[A-Za-z0-9_-]+/g, "DEC-*");

export function recordingKey(req: ModelRequest): string {
  return createHash("sha256").update(JSON.stringify([req.agent_name, req.tier, !!req.thinking, !!req.json, normalise(req.system), normalise(req.user)])).digest("hex");
}

/** Receipt fields that could carry a credential are never written to a recording (the file is meant to be committed). */
const SECRET = /token|secret|auth|password|api[_-]?key|cookie/i;
const scrub = (res: ModelResponse): ModelResponse =>
  res.receipt ? { ...res, receipt: Object.fromEntries(Object.entries(res.receipt).filter(([k, v]) => !SECRET.test(k) && !/^(nvapi-|Bearer )/.test(String(v)))) } : res;

/**
 * Wraps a live client and appends every call it makes, answered or not, to `file`.
 * When resuming a run that stopped part-way, calls that run already got an answer for are reused instead of asked
 * again. Prompts are deterministic, so the reused answers lead back to the same next prompts. A reused answer is
 * only taken when it is also the newest record for that prompt, so replay later sees exactly what this run saw.
 */
export class RecordingModelClient implements ModelClient {
  private reuse = new Map<string, Recording>();
  private calls = 0;
  reused = 0;

  constructor(private inner: ModelClient, readonly file: string, private now = () => new Date(), private opts: RecordingOptions = {}) {
    mkdirSync(dirname(file), { recursive: true });
    if (opts.resumeRun !== undefined) {
      const newest = new Map<string, Recording>();
      for (const r of readRecordings(file)) newest.set(r.key, r);
      for (const [k, r] of newest) if (r.run === opts.resumeRun && !r.response.fallback) this.reuse.set(k, r);
    }
    if (opts.log) mkdirSync(dirname(opts.log), { recursive: true });
  }

  /** Answers from the resumed run that are available for reuse. */
  get reusable(): number {
    return this.reuse.size;
  }

  private note(line: string) {
    if (this.opts.log) appendFileSync(this.opts.log, `[${this.now().toISOString()}] ${line}\n`);
  }

  get enabled(): boolean {
    return !!this.inner.enabled;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const n = ++this.calls;
    const key = recordingKey(req);
    const old = this.reuse.get(key);
    if (old) {
      this.reused++;
      this.note(`call ${n} ${req.agent_name} (${req.tier}): reused answer recorded ${old.recorded_at} in run ${old.run}`);
      return old.response;
    }
    const res = await this.inner.complete(req);
    const rec: Recording = {
      v: 1, key, recorded_at: this.now().toISOString(), agent_name: req.agent_name, tier: req.tier,
      thinking: !!req.thinking, system: req.system, user: req.user, response: scrub(res),
      ...(this.opts.run !== undefined ? { run: this.opts.run } : {}),
    };
    appendFileSync(this.file, JSON.stringify(rec) + "\n");
    this.note(`call ${n} ${req.agent_name} (${req.tier}) -> ${res.model}, ${res.latency_ms} ms, ${res.tokens_in}/${res.tokens_out} tokens: ${res.fallback ? `FAILED: ${res.error ?? "fallback"}` : "ok"}`);
    return res;
  }
}

export function readRecordings(file: string): Recording[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Recording);
}

/** Answers from recordings of live calls. Only calls a model really answered are replayed. */
export class ReplayModelClient implements ModelClient {
  readonly enabled: boolean;
  private byKey = new Map<string, Recording>();

  constructor(readonly file: string) {
    // The newest record for a prompt wins, so a re-recorded run replaces an older one. That includes a newest call
    // that failed: replay then falls back too, rather than mixing in an older run's answer and its different chain.
    for (const r of readRecordings(file)) this.byKey.set(r.key, r);
    this.answered = [...this.byKey.values()].filter((r) => !r.response.fallback).length;
    this.enabled = this.answered > 0;
  }

  private readonly answered: number;

  get size(): number {
    return this.answered;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const rec = this.byKey.get(recordingKey(req));
    if (rec?.response.fallback) {
      return { ...rec.response, text: "", error: `replay: this prompt failed when recorded (${rec.response.error ?? "fallback"})` };
    }
    if (!rec) {
      return {
        text: "", model: req.tier, thinking: false, tokens_in: 0, tokens_out: 0, latency_ms: 0, fallback: true,
        error: "replay: no recorded live answer for this prompt",
      };
    }
    return { ...rec.response, replayed_from: rec.recorded_at };
  }
}
