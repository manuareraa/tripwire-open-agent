import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGateway, FakeMemory, ScriptedModel } from "./fakes.js";
import type { Deps } from "../app/orchestration/state.js";

let runDecide: typeof import("../app/orchestration/graph.js").runDecide;
let reopenFor: typeof import("../app/watcher.js").reopenFor;
let Tracer: typeof import("../app/tracing.js").Tracer;
let DecisionStore: typeof import("../app/store.js").DecisionStore;

beforeAll(async () => {
  process.env.LOG_DIR = mkdtempSync(join(tmpdir(), "tw-"));
  process.env.TRACE_STDOUT = "false";
  ({ runDecide } = await import("../app/orchestration/graph.js"));
  ({ reopenFor } = await import("../app/watcher.js"));
  ({ Tracer } = await import("../app/tracing.js"));
  ({ DecisionStore } = await import("../app/store.js"));
});

function deps(model = new ScriptedModel(), gateway = new FakeGateway(), memory = new FakeMemory()): Deps {
  return { gateway, model, memory, tracer: new Tracer() };
}

describe("decision graph (rule-based path, no keys)", () => {
  it("keeps a healthy supplier and dual-sources / exits a distressed one", async () => {
    const d = deps();
    const healthy = await runDecide(d, "SUP-01", "Keep, dual-source or exit?");
    expect(healthy.decision.decision).toBe("keep");
    expect(healthy.decision.tripwires.length).toBeGreaterThanOrEqual(2);
    expect(healthy.decision.evidence.every((e) => e.result_hash.length === 64)).toBe(true);

    const risky = await runDecide(d, "SUP-02", "Keep, dual-source or exit?");
    expect(risky.state.risk.level).toBe("high");
    expect(risky.state.risk.thinking).toBe(true);
    expect(["dual_source", "exit"]).toContain(risky.decision.decision);
    expect(risky.decision.escalated).toBe(true);
  });

  it("critic rejects a draft with an invented number and an already-tripped tripwire, then accepts the fix", async () => {
    const bad = JSON.stringify({ decision: "dual_source", confidence: 0.7, rationale: "Current ratio is 0.55 so we should hedge.", tripwires: [{ metric: "current_ratio", op: "<", threshold: 1.0 }, { metric: "spend_share", op: ">", threshold: 0.6 }], limitations: [] });
    const good = JSON.stringify({ decision: "dual_source", confidence: 0.7, rationale: "Current ratio is 0.85 and debt to equity is 2.6.", tripwires: [{ metric: "current_ratio", op: "<", threshold: 0.7 }, { metric: "spend_share", op: ">", threshold: 0.6 }], limitations: [] });
    const model = new ScriptedModel({ Decider: [bad, good] });
    const d = deps(model);
    const { decision, state } = await runDecide(d, "SUP-02", "Keep, dual-source or exit?");
    expect(state.rounds).toBe(2);
    expect(decision.rationale).toContain("0.85");
    const rejects = d.tracer.all().filter((e) => e.action === "review_decision" && e.status === "needs_revision");
    expect(rejects).toHaveLength(1);
    expect(rejects[0].output_summary).toMatch(/0\.55/);
    expect(rejects[0].output_summary).toMatch(/already true/);
    // thinking was switched on for the high-risk Decider call only
    const decider = model.calls.filter((c) => c.agent_name === "Decider");
    expect(decider.every((c) => c.thinking)).toBe(true);
  });

  it("falls back to rules after 3 failed rounds", async () => {
    const bad = JSON.stringify({ decision: "keep", confidence: 0.9, rationale: "Revenue grew 77%.", tripwires: [], limitations: [] });
    const d = deps(new ScriptedModel({ Decider: [bad, bad, bad] }));
    const { decision } = await runDecide(d, "SUP-01", "Review");
    expect(decision.limitations.join(" ")).toMatch(/rule-based decision used/);
  });

  it("reopens only decisions that depend on a changed row, and only if a tripwire fires", async () => {
    const gateway = new FakeGateway();
    const memory = new FakeMemory();
    const d = deps(new ScriptedModel(), gateway, memory);
    const store = new DecisionStore();
    for (const id of ["SUP-01", "SUP-02", "SUP-03", "SUP-04", "SUP-05"]) store.put((await runDecide(d, id, "Review")).decision);

    // SUP-01's supplier publishes a bad new quarter.
    gateway.tables.fin.push({ cik: "100", ticker: "T100", name: "Co 100", sic: "3674", period_end: "2026-09-30", revenue: 950, gross_margin: 0.3, current_ratio: 0.7, debt_to_equity: 0.9, source_url: "x" });
    const report = await reopenFor(d, store, { table: "supplier_financials", key: "100" });
    expect(report.dependents).toHaveLength(1);
    expect(report.reopened).toHaveLength(1);
    expect(report.reopened[0].new.supersedes).toBe(report.reopened[0].old);
    expect(report.work_saved).toBe(4);
    expect(store.active()).toHaveLength(5);
    expect(store.get(report.reopened[0].old)!.status).toBe("superseded");
    // The Critic caught the remembered claims built on the old filing and sent them back to the Memory Keeper.
    const memReject = d.tracer.all().find((e) => e.action === "review_memory" && e.status === "needs_revision");
    expect(memReject?.target_agent).toBe("MemoryKeeper");
    expect(d.tracer.all().some((e) => e.action === "drop_stale")).toBe(true);
  });
});
