import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGateway, FakeMemory } from "./fakes.js";
import type { Deps, DecisionDraft, RunState } from "../app/orchestration/state.js";
import type { TripwireDraft } from "../app/tripwires.js";
import type { DecisionKind, Evidence, ModelClient, ModelRequest, ModelResponse } from "../app/types.js";

let crash: typeof import("../app/proving/crashtest.js");
let newState: typeof import("../app/orchestration/graph.js").newState;
let runDecide: typeof import("../app/orchestration/graph.js").runDecide;
let Tracer: typeof import("../app/tracing.js").Tracer;

beforeAll(async () => {
  process.env.LOG_DIR = mkdtempSync(join(tmpdir(), "tw-crash-"));
  process.env.TRACE_STDOUT = "false";
  crash = await import("../app/proving/crashtest.js");
  ({ newState, runDecide } = await import("../app/orchestration/graph.js"));
  ({ Tracer } = await import("../app/tracing.js"));
});

/** Fake Lightning: reads the moved number out of the prompt and re-decides with `rule`. Other agents get no answer. */
class FakeLightning implements ModelClient {
  readonly enabled = true;
  calls: ModelRequest[] = [];
  constructor(private rule: (metric: string, value: number, decided: DecisionKind) => DecisionKind) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const none: ModelResponse = { text: "", model: "none", thinking: false, tokens_in: 0, tokens_out: 0, latency_ms: 0, fallback: true, error: "fake: none" };
    if (req.agent_name !== "CrashTester") return none;
    this.calls.push(req);
    const m = /Now one number moves: (\w+) is ([-\d.]+)/.exec(req.user)!;
    const decided = /We decided (\w+)/.exec(req.user)![1] as DecisionKind;
    const decision = this.rule(m[1], Number(m[2]), decided);
    const text = JSON.stringify({ decision, still_holds: decision === decided, why: `${m[1]} at ${m[2]} gives ${decision}.` });
    return { text, model: "fake-lightning", thinking: false, tokens_in: 10, tokens_out: 10, latency_ms: 1, fallback: false };
  }
}

const ev = { template_id: "t", params: {}, sql: "", table: "x", result_hash: "h", depends_on: [] } as Evidence;
function setup(model: ModelClient, metrics: Record<string, number>, decision: DecisionKind = "keep"): { deps: Deps; s: RunState; draft: DecisionDraft } {
  const deps: Deps = { gateway: new FakeGateway(), model, memory: new FakeMemory(), tracer: new Tracer() };
  const s = newState(deps.tracer.run_id, "SUP-X", "Keep, dual-source or exit?");
  s.metrics = Object.entries(metrics).map(([metric, value]) => ({ metric, value, evidence: ev }));
  return { deps, s, draft: { decision, confidence: 0.8, rationale: "", tripwires: [], limitations: [], rules: false } };
}
const tw = (metric: string, op: TripwireDraft["op"], threshold: number | undefined, origin: TripwireDraft["origin"] = "decider"): TripwireDraft => ({ metric, op, threshold, origin });

describe("crash test", () => {
  it("probes just past and just short of the line, with a step per unit", () => {
    expect(crash.probeValues("spend_share", ">", 0.55)).toEqual({ past: 0.56, short: 0.54 });
    expect(crash.probeValues("current_ratio", "<", 1)).toEqual({ past: 0.95, short: 1.05 });
    expect(crash.probeValues("risk_events_12m", ">", 1)).toEqual({ past: 2, short: 1 });
    expect(crash.probeValues("category_alternatives", "<", 1)).toEqual({ past: 0, short: 1 });
    expect(crash.probeValues("revenue_change_pct", "<", -10)).toEqual({ past: -11, short: -9 });
    expect(typeof crash.probeValues("spend_share", ">", 1)).toBe("string");
  });

  it("verifies a line that changes the call only once crossed", async () => {
    const model = new FakeLightning((m, v, d) => (m === "spend_share" && v > 0.55 ? "dual_source" : d));
    const { deps, s, draft } = setup(model, { spend_share: 0.45, current_ratio: 1.6 });
    const kept = await crash.crashTest(deps, s, draft, [tw("spend_share", ">", 0.55)]);
    expect(kept).toHaveLength(1);
    expect(kept[0].crash_test).toMatchObject({ verdict: "verified", past_value: 0.56, short_value: 0.54, past_decision: "dual_source", short_decision: "keep" });
    expect(kept[0].crash_test!.why).toMatch(/0\.56/);
    expect(s.proving.crash).toEqual({ tested: 1, verified: 1, decorative: 0, mis_set: 0, dropped: [] });
    expect(model.calls.filter((c) => c.tier === "small")).toHaveLength(2);
    const ev = deps.tracer.all().find((e) => e.agent_name === "CrashTester" && e.action === "crash_test")!;
    expect(ev.output_summary).toBe("spend share 0.56 (past 0.55): dual_source instead of keep; 0.54 (short of it): still keep → verified");
  });

  it("drops a decorative line (one call: the control is not needed) and keeps a verified one", async () => {
    const model = new FakeLightning((m, v, d) => (m === "current_ratio" && v < 1 ? "dual_source" : d));
    const { deps, s, draft } = setup(model, { spend_share: 0.45, current_ratio: 1.6 });
    const kept = await crash.crashTest(deps, s, draft, [tw("spend_share", ">", 0.55), tw("current_ratio", "<", 1, "premortem")]);
    expect(kept.map((k) => k.metric)).toEqual(["current_ratio"]);
    expect(s.proving.crash).toMatchObject({ tested: 2, verified: 1, decorative: 1, dropped: ["spend share > 0.55 (decorative)"] });
    expect(model.calls).toHaveLength(3);
  });

  it("resets a mis-set line halfway to today once, and keeps it only if the reset verifies", async () => {
    const model = new FakeLightning((m, v, d) => (m === "spend_share" && v > 0.495 ? "dual_source" : d));
    const { deps, s, draft } = setup(model, { spend_share: 0.4 });
    const kept = await crash.crashTest(deps, s, draft, [tw("spend_share", ">", 0.6)]);
    expect(kept).toHaveLength(1);
    expect(kept[0].threshold).toBe(0.5);
    expect(kept[0].crash_test).toMatchObject({ verdict: "verified", past_value: 0.51, short_value: 0.49 });
    expect(kept[0].crash_test!.why).toMatch(/moved from 0.6 to 0.5/);
    expect(deps.tracer.all().some((e) => e.output_summary?.includes("→ mis-set"))).toBe(true);
  });

  it("never leaves a decision with no tripwires, and says why in limitations", async () => {
    const model = new FakeLightning((_m, _v, d) => d);
    const { deps, s, draft } = setup(model, { current_ratio: 0.8, debt_to_equity: 3.5 }, "exit");
    const kept = await crash.crashTest(deps, s, draft, [tw("current_ratio", "<", 0.7, "rules"), tw("debt_to_equity", ">", 4.2, "rules")]);
    expect(kept).toHaveLength(2);
    expect(kept.every((k) => k.crash_test?.verdict === "decorative")).toBe(true);
    expect(s.proving.crash).toMatchObject({ tested: 2, decorative: 2, dropped: [] });
    expect(s.limitations.join(" ")).toMatch(/none of the 2 candidate tripwires changed the call.*rule-based policy.*exit/);
  });

  it("with no model marks every candidate untested, keeps them all and makes no call", async () => {
    const model: ModelClient = { enabled: false, complete: async () => { throw new Error("must not be called"); } };
    const { deps, s, draft } = setup(model, { spend_share: 0.45, risk_events_12m: 0 });
    const kept = await crash.crashTest(deps, s, draft, [tw("spend_share", ">", 0.55, "rules"), tw("risk_events_12m", ">", 0, "rules")]);
    expect(kept).toHaveLength(2);
    expect(kept.every((k) => k.crash_test?.verdict === "untested" && /no model/.test(k.crash_test.reason!))).toBe(true);
    expect(s.proving.crash).toMatchObject({ tested: 0, verified: 0 });
    expect(s.proving.skipped?.join(" ")).toMatch(/crash-test: no model/);
    expect(s.modelCalls).toHaveLength(0);
  });

  it("does not test 'changed' lines, drops lines already true today, and shares calls on the same number", async () => {
    const model = new FakeLightning((m, v, d) => (m === "spend_share" && v > 0.55 ? "dual_source" : d));
    const { deps, s, draft } = setup(model, { spend_share: 0.45, lead_time_weeks: 6 });
    const kept = await crash.crashTest(deps, s, draft, [
      tw("spend_share", ">", 0.55), tw("spend_share", ">", 0.55, "premortem"), tw("lead_time_weeks", "changed", undefined), tw("spend_share", ">", 0.3, "premortem"),
    ]);
    expect(kept.map((k) => [k.metric, k.crash_test?.verdict])).toEqual([["spend_share", "verified"], ["lead_time_weeks", "untested"]]);
    expect(s.proving.crash?.dropped.join(" ")).toMatch(/already true today/);
    expect(model.calls).toHaveLength(2);
  });

  it("writes the same prompt for the same numbers, with no ids or times in it", () => {
    const today = new Map([["spend_share", 0.45], ["current_ratio", 1.6]]);
    const a = crash.redecidePrompt("keep", today, "spend_share", 0.56);
    const b = crash.redecidePrompt("keep", new Map([["current_ratio", 1.6], ["spend_share", 0.45]]), "spend_share", 0.56);
    expect(a).toEqual(b);
    expect(a.user).not.toMatch(/DEC-|SUP-|\d{4}-\d{2}-\d{2}/);
    expect(a.user).toContain("spend_share is 0.56 instead of 0.45");
  });

  it("runs inside the decision graph: every kept tripwire carries its crash test", async () => {
    const model = new FakeLightning((m, v, d) => (m === "spend_share" && v > 0.3 ? "dual_source" : m === "current_ratio" && v < 1 ? "dual_source" : d));
    const deps: Deps = { gateway: new FakeGateway(), model, memory: new FakeMemory(), tracer: new Tracer() };
    const { decision } = await runDecide(deps, "SUP-01", "Keep, dual-source or exit?");
    expect(decision.decision).toBe("keep");
    expect(decision.proving?.crash?.tested).toBeGreaterThan(0);
    const own = decision.tripwires.filter((t) => t.origin === "rules");
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((t) => t.crash_test && t.crash_test.verdict !== "untested")).toBe(true);
    expect(decision.model_calls?.some((c) => c.agent === "CrashTester" && c.tier === "small")).toBe(true);
  });
});
