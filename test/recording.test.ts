// Record a live run, then replay it with no provider: same decisions, every replayed call labelled, nothing guessed.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SampleDataGateway } from "../app/adapters/sample_data.js";
import { RecordingModelClient, ReplayModelClient, readRecordings, recordingKey } from "../app/adapters/recording.js";
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

/** Stands in for Nightshift: answers every agent, and (like the real router can) serves a different reasoning model. */
class FakeNightshift implements ModelClient {
  readonly enabled = true;
  calls = 0;
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls++;
    const text = {
      Planner: '{"steps": [], "focus": "liquidity"}',
      Analyst: "The supplier looks steady on the figures given.",
      Decider: '{"decision": "keep", "confidence": 0.7, "rationale": "Steady.", "tripwires": [{"metric": "current_ratio", "op": "<", "threshold": 0.5}, {"metric": "risk_events_12m", "op": ">", "threshold": 0}], "limitations": []}',
      RiskOfficer: "User Safety: safe",
    }[req.agent_name] ?? "ok";
    const requested = `nvidia/${req.tier}`;
    return {
      text, model: req.tier === "reasoning" ? "nvidia/served-instead" : requested, requested_model: requested,
      thinking: !!req.thinking, tokens_in: 100, tokens_out: 20, latency_ms: 5, fallback: false, provider: "meterless-nightshift",
      receipt: { receipt_id: `r${this.calls}`, routed_model: requested },
    };
  }
}

const sampleGateway = () => new SampleDataGateway({ ledgerDir: tmp("tw-ledger-"), sampleDir: tmp("tw-sample-", join(REPO_ROOT, "data/sample")) });

describe("record and replay of live model calls", () => {
  it("blanks decision ids out of the match key", () => {
    const req = (user: string): ModelRequest => ({ tier: "reasoning", agent_name: "Decider", system: "s", user });
    expect(recordingKey(req("This reopens decision DEC-SUP-05-20261025T101010"))).toBe(recordingKey(req("This reopens decision DEC-SUP-05-20261026T090000")));
    expect(recordingKey(req("a"))).not.toBe(recordingKey({ ...req("a"), thinking: true }));
  });

  it("replays a recorded run to the same decisions, labels every replayed call, and never guesses a missing one", async () => {
    const file = join(tmp("tw-rec-"), "nightshift.jsonl");
    const live = new FakeNightshift();
    const subjects = ["SUP-01", "SUP-05"];

    const liveDeps: Deps = { gateway: sampleGateway(), model: new RecordingModelClient(live, file), memory: new FakeMemory(), tracer: new Tracer() };
    const liveDecisions = [];
    for (const id of subjects) liveDecisions.push((await runDecide(liveDeps, id, "Review")).decision);
    const recs = readRecordings(file);
    expect(recs).toHaveLength(live.calls);
    expect(new Set(recs.map((r) => r.agent_name))).toEqual(new Set(["Planner", "Analyst", "Decider", "RiskOfficer", "PreMortem"]));

    const replay = new ReplayModelClient(file);
    const tracer = new Tracer();
    const replayDeps: Deps = { gateway: sampleGateway(), model: replay, memory: new FakeMemory(), tracer };
    for (const [i, id] of subjects.entries()) {
      const { decision } = await runDecide(replayDeps, id, "Review");
      expect({ d: decision.decision, c: decision.confidence }).toEqual({ d: liveDecisions[i].decision, c: liveDecisions[i].confidence });
    }
    const calls = tracer.all().filter((e) => e.action.startsWith("model_call_"));
    expect(calls).toHaveLength(recs.length);
    expect(calls.every((e) => /\[replay of a live call recorded \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]/.test(e.output_summary ?? ""))).toBe(true);
    expect(calls.every((e) => e.sponsor === "meterless-nightshift")).toBe(true);
    // The served model is shown, and the requested one beside it when they differ.
    expect(calls.find((e) => e.agent_name === "Decider")!.output_summary).toMatch(/^nvidia\/served-instead \(asked for nvidia\/reasoning\) via Meterless Nightshift/);
    expect(tracer.all().some((e) => e.event === "fallback")).toBe(false);

    // A supplier that was never recorded runs on rules, and says why.
    const t2 = new Tracer();
    await runDecide({ ...replayDeps, tracer: t2 }, "SUP-09", "Review");
    expect(t2.all().filter((e) => e.action.startsWith("model_call_"))).toHaveLength(0);
    expect(t2.all().some((e) => /no recorded live answer/.test(e.output_summary ?? ""))).toBe(true);
  });

  it("never writes credential-like receipt fields to a recording", async () => {
    const file = join(tmp("tw-rec-"), "r.jsonl");
    const inner: ModelClient = { enabled: true, complete: async () => ({ text: "ok", model: "m", thinking: false, tokens_in: 1, tokens_out: 1, latency_ms: 1, fallback: false, receipt: { receipt_id: "r1", runtime_token: "t0p", "header.meterless-auth": "Bearer x", note: "nvapi-abc" } }) };
    await new RecordingModelClient(inner, file).complete({ tier: "small", agent_name: "Planner", system: "", user: "" });
    expect(readRecordings(file)[0].response.receipt).toEqual({ receipt_id: "r1" });
  });

  it("skips calls the live provider could not answer", () => {
    const file = join(tmp("tw-rec-"), "r.jsonl");
    const rec = (fallback: boolean) => JSON.stringify({ v: 1, key: "k", recorded_at: "2026-10-25T00:00:00Z", agent_name: "Planner", tier: "small", thinking: false, system: "", user: "", response: { text: "", model: "m", thinking: false, tokens_in: 0, tokens_out: 0, latency_ms: 0, fallback } });
    writeFileSync(file, rec(true) + "\n");
    expect(new ReplayModelClient(file).size).toBe(0);
    expect(readFileSync(file, "utf8")).toContain('"fallback":true');
  });
});
