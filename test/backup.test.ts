import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGateway, FakeMemory, ScriptedModel, fixtureTables } from "./fakes.js";
import { isHealthy, rankCandidates, type Candidate } from "../app/agents/backup.js";
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

const deps = (gateway = new FakeGateway(), memory = new FakeMemory()): Deps => ({ gateway, model: new ScriptedModel(), memory, tracer: new Tracer() });
const cand = (supplier_id: string, lead_time_weeks?: number, current_ratio?: number, debt_to_equity?: number): Candidate =>
  ({ supplier_id, lead_time_weeks, current_ratio, debt_to_equity, metrics: [] });

describe("backup ranking", () => {
  it("puts healthy suppliers first, then shorter lead time, then the stronger current ratio", () => {
    const list = [cand("A", 3, 0.9, 1), cand("B", 10, 1.5, 1), cand("C", 6, 1.2, 2.5), cand("D", 6, 1.4, 2.9), cand("E")];
    expect(rankCandidates(list).map((c) => c.supplier_id)).toEqual(["D", "C", "B", "A", "E"]);
  });

  it("uses the Risk Officer's lines, inclusive at the edge", () => {
    expect(isHealthy({ current_ratio: 1, debt_to_equity: 3 })).toBe(true);
    expect(isHealthy({ current_ratio: 0.99, debt_to_equity: 1 })).toBe(false);
    expect(isHealthy({ current_ratio: 2, debt_to_equity: 3.01 })).toBe(false);
    expect(isHealthy({ current_ratio: 2 })).toBe(false);
  });
});

describe("dual-source backup in the decision graph", () => {
  it("names a healthy backup with its own evidence and tripwires; keep names none", async () => {
    const d = deps();
    const keep = await runDecide(d, "SUP-01", "Review");
    expect(keep.decision.decision).toBe("keep");
    expect(keep.decision.backup).toBeUndefined();
    expect(keep.decision.tripwires.some((t) => t.metric.startsWith("backup_"))).toBe(false);

    const { decision, state } = await runDecide(d, "SUP-02", "Review");
    expect(["dual_source", "exit"]).toContain(decision.decision);
    // SUP-01 and SUP-03 are both healthy; SUP-03 has the shorter lead time (6 vs 8 weeks).
    expect(decision.backup).toMatchObject({ supplier_id: "SUP-03", name: "Co 300", healthy: true });
    expect(decision.backup!.reason).toMatch(/best of 2 other suppliers/);
    expect(decision.backup!.findings.map((f) => [f.metric, f.value])).toEqual([
      ["backup_lead_time_weeks", 6], ["backup_current_ratio", 1.3], ["backup_debt_to_equity", 1.1],
    ]);
    const bw = decision.tripwires.filter((t) => t.metric.startsWith("backup_"));
    expect(bw.map((t) => `${t.metric} ${t.op} ${t.threshold}`)).toEqual(["backup_current_ratio < 1", "backup_debt_to_equity > 3"]);
    expect(bw.every((t) => t.depends_on.some((r) => r.table === "supplier_financials" && r.key === "300"))).toBe(true);
    // The backup's evidence is part of the decision, but its numbers never feed the risk grade.
    expect(decision.evidence.some((e) => e.depends_on.some((r) => r.key === "300"))).toBe(true);
    expect(state.metrics.some((m) => m.metric.startsWith("backup_"))).toBe(false);
    expect(d.tracer.all().find((e) => e.action === "pick_backup")?.output_summary).toMatch(/^backup SUP-03 \(Co 300\), healthy; ranked 2 candidates: SUP-03 > SUP-01/);
  });

  it("reopens a dual-source decision when its backup weakens, and picks a new backup", async () => {
    const gateway = new FakeGateway();
    const d = deps(gateway);
    const store = new DecisionStore();
    const first = (await runDecide(d, "SUP-02", "Review")).decision;
    store.put(first);
    store.put((await runDecide(d, "SUP-04", "Review")).decision);

    // The backup's company files a weak quarter: current ratio below 1.
    gateway.tables.fin.push({ cik: "300", ticker: "T300", name: "Co 300", sic: "3674", period_end: "2026-09-30", revenue: 500, gross_margin: 0.3, current_ratio: 0.8, debt_to_equity: 1.2, source_url: "x" });
    const report = await reopenFor(d, store, { table: "supplier_financials", key: "300" });
    expect(report.dependents).toEqual([first.decision_id]);
    expect(report.reopened).toHaveLength(1);
    expect(report.reopened[0].fired.join(" ")).toMatch(/backup_current_ratio < 1 \(now 0\.8, was 1\.3\)/);
    expect(report.reopened[0].new.backup?.supplier_id).toBe("SUP-01");
  });

  it("leaves a still-healthy backup alone", async () => {
    const gateway = new FakeGateway();
    const d = deps(gateway);
    const store = new DecisionStore();
    const first = (await runDecide(d, "SUP-02", "Review")).decision;
    store.put(first);
    gateway.tables.fin.push({ cik: "300", ticker: "T300", name: "Co 300", sic: "3674", period_end: "2026-09-30", revenue: 510, gross_margin: 0.3, current_ratio: 1.2, debt_to_equity: 1.3, source_url: "x" });
    const report = await reopenFor(d, store, { table: "supplier_financials", key: "300" });
    expect(report.reopened).toHaveLength(0);
    expect(report.still_valid[0].checked.join(" ")).toMatch(/backup_current_ratio < 1 \(now 1\.2, was 1\.3\)/);
  });

  it("says so when no other supplier is healthy, and adds no backup tripwire", async () => {
    const tables = fixtureTables();
    for (const r of tables.fin) if (r.cik === "100" || r.cik === "300") r.current_ratio = 0.9;
    const { decision } = await runDecide(deps(new FakeGateway(tables)), "SUP-02", "Review");
    expect(decision.backup).toMatchObject({ healthy: false });
    expect(decision.backup!.reason).toMatch(/none passes the policy lines/);
    expect(decision.limitations.join(" ")).toMatch(/No backup in the category passes/);
    expect(decision.tripwires.some((t) => t.metric.startsWith("backup_"))).toBe(false);
  });

  it("names no backup when the category has no other supplier", async () => {
    const tables = fixtureTables();
    tables.spend = tables.spend.filter((r) => r.supplier_id === "SUP-02");
    const { decision } = await runDecide(deps(new FakeGateway(tables)), "SUP-02", "Review");
    expect(decision.decision).not.toBe("keep");
    expect(decision.backup).toBeUndefined();
    expect(decision.limitations).toContain("No other supplier in the category to name as a backup");
  });
});
