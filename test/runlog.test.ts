// Numbered run logs and resuming a live recording that stopped part-way.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecordingModelClient, readRecordings } from "../app/adapters/recording.js";
import { nextRun, redact, resumeArg } from "../scripts/runlog.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../app/types.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "tw-runlog-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Answers every prompt with its own text, except prompts listed in `fail`. Counts what it was really asked. */
class Live implements ModelClient {
  readonly enabled = true;
  asked: string[] = [];
  constructor(private fail: string[] = []) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.asked.push(req.user);
    const failed = this.fail.includes(req.user);
    return { text: failed ? "" : `answer to ${req.user}`, model: "m", thinking: false, tokens_in: 1, tokens_out: 1, latency_ms: 5, fallback: failed, ...(failed ? { error: "HTTP 503" } : {}) };
  }
}
const req = (user: string): ModelRequest => ({ tier: "small", agent_name: "Planner", system: "s", user });

describe("resume", () => {
  it("reuses answers the run already got and asks only for the missing or failed ones", async () => {
    const file = join(tmp(), "rec.jsonl");
    const first = new RecordingModelClient(new Live(["p2"]), file, undefined, { run: 1 });
    await first.complete(req("p1"));
    await first.complete(req("p2")); // failed; the run then stopped

    const live = new Live();
    const again = new RecordingModelClient(live, file, undefined, { run: 1, resumeRun: 1 });
    expect(again.reusable).toBe(1);
    expect((await again.complete(req("p1"))).text).toBe("answer to p1");
    await again.complete(req("p2"));
    await again.complete(req("p3"));
    expect(live.asked).toEqual(["p2", "p3"]);
    expect(again.reused).toBe(1);
    // A reused answer is not written twice; new calls carry the run number.
    expect(readRecordings(file).map((r) => [r.user, r.run, !!r.response.fallback])).toEqual([["p1", 1, false], ["p2", 1, true], ["p2", 1, false], ["p3", 1, false]]);
  });

  it("never reuses another run's answer, or one a newer record has replaced", async () => {
    const file = join(tmp(), "rec.jsonl");
    await new RecordingModelClient(new Live(), file, undefined, { run: 1 }).complete(req("p1"));
    await new RecordingModelClient(new Live(["p1"]), file, undefined, { run: 2 }).complete(req("p1"));
    expect(new RecordingModelClient(new Live(), file, undefined, { resumeRun: 1 }).reusable).toBe(0);
    expect(new RecordingModelClient(new Live(), file, undefined, { resumeRun: 2 }).reusable).toBe(0);
  });

  it("writes one log line per call, ok or failed", async () => {
    const d = tmp();
    const log = join(d, "run.log");
    const c = new RecordingModelClient(new Live(["p2"]), join(d, "rec.jsonl"), undefined, { run: 3, log });
    await c.complete(req("p1"));
    await c.complete(req("p2"));
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines[0]).toMatch(/call 1 Planner \(small\) -> m, 5 ms, 1\/1 tokens: ok$/);
    expect(lines[1]).toMatch(/call 2 .*FAILED: HTTP 503$/);
  });
});

describe("run numbers", () => {
  it("counts up from the highest run in the logs folder or the recordings", () => {
    const d = tmp();
    const logs = join(d, "runs");
    expect(nextRun(logs)).toBe(1);
    mkdirSync(logs);
    writeFileSync(join(logs, "run-0004-backtest.log"), "");
    writeFileSync(join(d, "rec.jsonl"), JSON.stringify({ key: "k", run: 6, response: {} }) + "\n");
    expect(nextRun(logs)).toBe(5);
    expect(nextRun(logs, join(d, "rec.jsonl"))).toBe(7);
  });
  it("resumes the run named, or the newest one recorded", () => {
    const f = join(tmp(), "rec.jsonl");
    writeFileSync(f, [2, 5, 3].map((run) => JSON.stringify({ key: `k${run}`, run, response: {} })).join("\n") + "\n");
    expect(resumeArg(["node", "x", "--resume", "2"], f)).toBe(2);
    expect(resumeArg(["node", "x", "--resume", "--max-cases", "40"], f)).toBe(5);
    expect(resumeArg(["node", "x"], f)).toBeUndefined();
    expect(() => resumeArg(["node", "x", "--resume"], join(tmp(), "none.jsonl"))).toThrow(/no numbered run/);
  });
  it("blanks out keys and tokens before anything is logged", () => {
    const env = { METERLESS_RUNTIME_TOKEN: "mtk_supersecret123", HOME: "/home/x" };
    expect(redact("auth Bearer abc.def nvapi-XYZ123 tok mtk_supersecret123 in /home/x", env))
      .toBe("auth Bearer [redacted] nvapi-[redacted] tok [redacted] in /home/x");
  });
});
