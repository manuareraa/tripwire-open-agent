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

/** Wraps a live client and appends every call it makes, answered or not, to `file`. */
export class RecordingModelClient implements ModelClient {
  constructor(private inner: ModelClient, readonly file: string, private now = () => new Date()) {
    mkdirSync(dirname(file), { recursive: true });
  }

  get enabled(): boolean {
    return !!this.inner.enabled;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const res = await this.inner.complete(req);
    const rec: Recording = {
      v: 1, key: recordingKey(req), recorded_at: this.now().toISOString(), agent_name: req.agent_name, tier: req.tier,
      thinking: !!req.thinking, system: req.system, user: req.user, response: scrub(res),
    };
    appendFileSync(this.file, JSON.stringify(rec) + "\n");
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
    // The newest answer for a prompt wins, so a re-recorded run replaces an older one.
    for (const r of readRecordings(file)) if (!r.response.fallback) this.byKey.set(r.key, r);
    this.enabled = this.byKey.size > 0;
  }

  get size(): number {
    return this.byKey.size;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const rec = this.byKey.get(recordingKey(req));
    if (!rec) {
      return {
        text: "", model: req.tier, thinking: false, tokens_in: 0, tokens_out: 0, latency_ms: 0, fallback: true,
        error: "replay: no recorded live answer for this prompt",
      };
    }
    return { ...rec.response, replayed_from: rec.recorded_at };
  }
}
