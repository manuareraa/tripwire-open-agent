import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGateway, FakeMemory, ScriptedModel } from "./fakes.js";
import type { DecisionDraft, Deps, RunState } from "../app/orchestration/state.js";
import type { MetricValue } from "../app/metrics.js";

let premortem: typeof import("../app/proving/premortem.js").premortem;
let newState: typeof import("../app/orchestration/graph.js").newState;
let runDecide: typeof import("../app/orchestration/graph.js").runDecide;
let Tracer: typeof import("../app/tracing.js").Tracer;

beforeAll(async () => {
  process.env.LOG_DIR = mkdtempSync(join(tmpdir(), "tw-imagine-"));
  process.env.TRACE_STDOUT = "false";
  ({ premortem } = await import("../app/proving/premortem.js"));
  ({ newState, runDecide } = await import("../app/orchestration/graph.js"));
  ({ Tracer } = await import("../app/tracing.js"));
});

const ev = { template_id: "t", params: {}, sql: "", table: "supplier_financials", result_hash: "h", depends_on: [] };
const mv = (metric: string, value: number): MetricValue => ({ metric, value, evidence: ev });

function setup(replies: string[] = [], decision_id = "DEC-SUP-02-a") {
  const model = new ScriptedModel({ PreMortem: replies });
  const deps: Deps = { gateway: new FakeGateway(), model, memory: new FakeMemory(), tracer: new Tracer() };
  const s: RunState = { ...newState("run-x", "SUP-02", "Keep, dual-source or exit?"), decision_id };
  s.metrics = [mv("current_ratio", 0.85), mv("debt_to_equity", 2.6), mv("spend_share", 0.45), mv("risk_events_12m", 1)];
  s.proving.filings = [{
    id: "fil-1", supplier_id: "SUP-02", accession: "0000-test", filed: "2026-09-01", items: ["2.04"],
    headline: "Test filing: a loan covenant default was triggered.", severity: "high", source_url: "https://example.test", parsed_by: "test", text_hash: "x",
  }];
  const draft: DecisionDraft = {
    decision: "dual_source", confidence: 0.7, rationale: "Weak liquidity.", rules: true, limitations: [],
    tripwires: [{ metric: "debt_to_equity", op: ">", threshold: 3.12 }],
  };
  return { model, deps, s, draft };
}

const story = (metric: string, op: string, threshold: unknown, grounded_in: string[] = [metric], text = `If ${metric} moves, the plan fails.`) =>
  ({ story: text, metric, op, threshold, grounded_in });
const reply = (...stories: unknown[]) => JSON.stringify({ stories });

describe("Imagine: pre-mortem stories become candidate tripwires", () => {
  it("keeps valid stories, tags them premortem with a story id, and traces each", async () => {
    const { model, deps, s, draft } = setup([reply(
      story("current_ratio", "<", 0.7, ["current_ratio", "fil-1"], "The covenant default drains cash and the current ratio slides."),
      story("spend_share", ">", 0.55),
      story("risk_events_12m", ">", 1, ["fil-1"]),
    )]);
    const out = await premortem(deps, s, draft);

    expect(out).toEqual([
      { metric: "current_ratio", op: "<", threshold: 0.7, origin: "premortem", story_id: "DEC-SUP-02-a-s1" },
      { metric: "spend_share", op: ">", threshold: 0.55, origin: "premortem", story_id: "DEC-SUP-02-a-s2" },
      { metric: "risk_events_12m", op: ">", threshold: 1, origin: "premortem", story_id: "DEC-SUP-02-a-s3" },
    ]);
    expect(s.proving.stories?.map((x) => x.id)).toEqual(["DEC-SUP-02-a-s1", "DEC-SUP-02-a-s2", "DEC-SUP-02-a-s3"]);
    expect(s.proving.stories?.[0].grounded_in).toEqual(["current_ratio", "fil-1"]);
    expect(s.proving.skipped).toBeUndefined();

    const req = model.calls[0];
    expect(req).toMatchObject({ tier: "reasoning", thinking: true, json: true, agent_name: "PreMortem" });
    expect(req.user).toContain("It is six months from now. We made this decision (dual-source for SUP-02) and it went badly.");
    expect(req.user).toContain("- current_ratio = 0.85");
    expect(req.user).toContain("fil-1 (2026-09-01");

    const events = deps.tracer.all().filter((e) => e.agent_name === "PreMortem" && e.action === "failure_story");
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.status === "success")).toBe(true);
    expect(events[0].output_summary).toContain("Watch: current_ratio < 0.7");
    expect(s.modelCalls.map((c) => c.agent)).toEqual(["PreMortem"]);
  });

  it("drops bad stories in code and says why", async () => {
    const { deps, s, draft } = setup([reply(
      story("cash_burn", "<", 1),                                       // unknown metric
      story("current_ratio", "<", 1.0),                                 // already crossed (0.85 < 1.0)
      story("gross_margin", "<", 0.1),                                  // no number today
      story("spend_share", ">", 0.6, ["fil-99"]),                       // invented filing
      story("debt_to_equity", ">", 3.12),                               // same line as the Decider's
      story("spend_share", "rises", 0.6),                               // not a direction
      story("spend_share", ">", "soon"),                                // no numeric line
      "not an object",
      story("spend_share", ">", 0.6, ["spend_share"]),                  // the one good story
    )]);
    const out = await premortem(deps, s, draft);

    expect(out).toEqual([{ metric: "spend_share", op: ">", threshold: 0.6, origin: "premortem", story_id: "DEC-SUP-02-a-s9" }]);
    expect(s.proving.stories?.map((x) => x.id)).toEqual(["DEC-SUP-02-a-s9"]);
    const dropped = s.limitations.filter((l) => l.startsWith("Pre-mortem story"));
    expect(dropped).toHaveLength(8);
    expect(dropped[0]).toMatch(/s1 dropped: unknown metric "cash_burn"/);
    expect(dropped[1]).toMatch(/s2 dropped: current_ratio < 1 is already true today/);
    expect(dropped[2]).toMatch(/s3 dropped: no data for metric "gross_margin"/);
    expect(dropped[3]).toMatch(/s4 dropped: cites "fil-99"/);
    expect(dropped[4]).toMatch(/s5 dropped: same line as a tripwire already set/);
    expect(dropped[5]).toMatch(/s6 dropped: direction "rises"/);
    expect(dropped[6]).toMatch(/s7 dropped: spend_share: no numeric line/);
    expect(dropped[7]).toMatch(/s8 dropped: not a story object/);
    const events = deps.tracer.all().filter((e) => e.action === "failure_story");
    expect(events.filter((e) => e.status === "failed")).toHaveLength(8);
    expect(dropped.join(" ")).not.toContain("need 2-4");
  });

  it("caps at four stories and drops duplicates between stories", async () => {
    const { deps, s, draft } = setup([reply(
      story("spend_share", ">", 0.6), story("spend_share", ">", 0.6), story("current_ratio", "<", 0.7),
      story("risk_events_12m", ">", 2), story("spend_share", ">", 0.7), story("current_ratio", "<", 0.5),
    )]);
    const out = await premortem(deps, s, draft);
    expect(out.map((t) => t.story_id)).toEqual(["DEC-SUP-02-a-s1", "DEC-SUP-02-a-s3", "DEC-SUP-02-a-s4", "DEC-SUP-02-a-s5"]);
    expect(s.limitations.some((l) => /s2 dropped: same line/.test(l))).toBe(true);
    expect(s.limitations.some((l) => /s6 dropped: more than 4 stories/.test(l))).toBe(true);
  });

  it("checks backup_* stories against the backup's values when they are passed", async () => {
    const { deps, s, draft } = setup([reply(story("backup_lead_time_weeks", ">", 8), story("backup_current_ratio", "<", 1.5))]);
    const out = await premortem(deps, s, draft, [mv("backup_lead_time_weeks", 6), mv("backup_current_ratio", 1.3)]);
    expect(out.map((t) => t.metric)).toEqual(["backup_lead_time_weeks"]);
    expect(s.limitations.some((l) => /backup_current_ratio < 1.5 is already true today \(value 1.3\)/.test(l))).toBe(true);

    const none = setup([reply(story("backup_lead_time_weeks", ">", 8), story("spend_share", ">", 0.6))]);
    const out2 = await premortem(none.deps, none.s, none.draft);
    expect(out2.map((t) => t.metric)).toEqual(["spend_share"]);
    expect(none.s.limitations.some((l) => /no data for metric "backup_lead_time_weeks"/.test(l))).toBe(true);
  });

  it("with no model answer it records why and invents nothing", async () => {
    const { deps, s, draft } = setup([]);
    const out = await premortem(deps, s, draft);
    expect(out).toEqual([]);
    expect(s.proving.stories).toBeUndefined();
    expect(s.proving.skipped).toEqual(["imagine: no model answered (scripted: none)"]);
    expect(deps.tracer.all().some((e) => e.action === "failure_story")).toBe(false);
  });

  it("with a reply that is not JSON it records why and invents nothing", async () => {
    const { deps, s, draft } = setup(["I think the supplier might fail."]);
    expect(await premortem(deps, s, draft)).toEqual([]);
    expect(s.proving.stories).toBeUndefined();
    expect(s.proving.skipped?.[0]).toMatch(/^imagine: the model's reply was not valid JSON/);
  });

  it("builds the same prompt for different decision and run ids, so recordings replay", async () => {
    const a = setup([reply()], "DEC-SUP-02-aaaa");
    const b = setup([reply()], "DEC-SUP-02-bbbb");
    await premortem(a.deps, a.s, a.draft);
    await premortem(b.deps, b.s, b.draft);
    expect(a.model.calls[0].system).toBe(b.model.calls[0].system);
    expect(a.model.calls[0].user).toBe(b.model.calls[0].user);
    expect(a.model.calls[0].user).not.toMatch(/DEC-|run-x/);
  });

  it("runs inside the decision graph: stories reach the compiled tripwires with origin and story_id", async () => {
    const model = new ScriptedModel({ PreMortem: [reply(story("spend_share", ">", 0.6, ["spend_share"]))] });
    const deps: Deps = { gateway: new FakeGateway(), model, memory: new FakeMemory(), tracer: new Tracer() };
    const { decision } = await runDecide(deps, "SUP-02", "Keep, dual-source or exit?");
    const tw = decision.tripwires.find((t) => t.origin === "premortem");
    expect(tw).toMatchObject({ metric: "spend_share", op: ">", threshold: 0.6 });
    expect(tw?.story_id).toBe(decision.proving?.stories?.[0].id);
    expect(tw?.depends_on.length).toBeGreaterThan(0);
  });
});
