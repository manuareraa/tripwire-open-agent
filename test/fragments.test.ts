// The real-time fragments: SEC 8-K events and the OFAC sanctions screen, from name matching to a selective reopen.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SampleDataGateway } from "../app/adapters/sample_data.js";
import { riskItemsOf, type MetricValue } from "../app/metrics.js";
import { defaultTripwires } from "../app/tripwires.js";
import { namesMatch } from "../scripts/fetch_sources.js";
import { FakeMemory, ScriptedModel } from "./fakes.js";
import type { Deps } from "../app/orchestration/state.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let runDecide: typeof import("../app/orchestration/graph.js").runDecide;
let reopenFor: typeof import("../app/watcher.js").reopenFor;
let Tracer: typeof import("../app/tracing.js").Tracer;
let DecisionStore: typeof import("../app/store.js").DecisionStore;

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
  ({ reopenFor } = await import("../app/watcher.js"));
  ({ Tracer } = await import("../app/tracing.js"));
  ({ DecisionStore } = await import("../app/store.js"));
});
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const metric = (name: string, value: number): MetricValue => ({ metric: name, value, evidence: { template_id: "x", params: {}, sql: "", result_hash: "h".repeat(64), row_count: 1, depends_on: [], source: "sample", ran_at: "" } as never });

describe("sanctions name screen", () => {
  it("matches cleaned names, and one-word names only exactly", () => {
    expect(namesMatch("Jabil Inc.", "JABIL INC")).toBe(true);
    expect(namesMatch("Dow Inc.", "DOW CHEMICAL TRADING LLC")).toBe(false);
    expect(namesMatch("Dow Inc.", "DOW")).toBe(true);
    expect(namesMatch("Texas Instruments Inc", "TEXAS INSTRUMENTS EXPORT CO")).toBe(true);
    expect(namesMatch("Texas Instruments Inc", "INSTRUMENTS OF TEXAS")).toBe(false);
  });
});

describe("8-K risk items", () => {
  it("keeps only the serious item numbers", () => {
    expect(riskItemsOf("2.05 8.01")).toEqual(["2.05"]);
    expect(riskItemsOf("2.02,9.01")).toEqual([]);
    expect(riskItemsOf(null)).toEqual([]);
  });

  it("gives every decision an 8-K and a sanctions tripwire", () => {
    const tws = defaultTripwires([metric("current_ratio", 1.4), metric("risk_events_12m", 0), metric("sanctions_matches", 0), metric("spend_share", 0.3)]);
    expect(tws).toContainEqual(expect.objectContaining({ metric: "risk_events_12m", op: ">", threshold: 0 }));
    expect(tws).toContainEqual(expect.objectContaining({ metric: "sanctions_matches", op: ">", threshold: 0 }));
    expect(tws.length).toBeLessThanOrEqual(4);
  });

  it("keeps one financial line so the spend share still gets a tripwire", () => {
    const tws = defaultTripwires([metric("current_ratio", 1.4), metric("debt_to_equity", 2), metric("risk_events_12m", 0), metric("sanctions_matches", 0), metric("spend_share", 0.35)]);
    expect(tws.map((t) => t.metric)).toEqual(["current_ratio", "risk_events_12m", "sanctions_matches", "spend_share"]);
  });
});

describe("a real 8-K arriving", () => {
  it("reopens only the supplier that filed it, out of the whole portfolio", async () => {
    const gateway = new SampleDataGateway({ ledgerDir: tmp("tw-ledger-"), sampleDir: tmp("tw-sample-", join(REPO_ROOT, "data/sample")) });
    const d: Deps = { gateway, model: new ScriptedModel(), memory: new FakeMemory(), tracer: new Tracer() };
    const store = new DecisionStore();
    const all = readFileSync(join(REPO_ROOT, "data/sample/supplier_spend.csv"), "utf8").trim().split("\n").slice(1).map((l) => l.split(",")[0]);
    expect(all).toHaveLength(20);
    for (const id of all) store.put((await runDecide(d, id, "Review")).decision);
    const dow = store.list().find((x) => x.subject_id === "SUP-05")!;
    expect(dow.tripwires.some((t) => t.metric === "risk_events_12m")).toBe(true);

    // Dow Inc.'s real 8-K of 2026-01-29 (item 2.05, restructuring), held back from the base data.
    const applied = await gateway.applyChange("04_new_8k.json");
    expect(applied).toEqual([{ table: "supplier_events", key: "1751788" }]);
    const { changes } = await gateway.changesSince("0");
    const report = await reopenFor(d, store, changes[0]);

    expect(report.reopened.map((r) => r.old)).toEqual([dow.decision_id]);
    expect(report.reopened[0].fired.join(" ")).toMatch(/risk_events_12m > 0 \(now 1, was 0\)/);
    expect(report.reopened[0].new.findings.some((f) => f.metric === "risk_events_12m" && f.value === 1)).toBe(true);
    expect(report.work_saved).toBe(19); // the other 19 decisions are left alone
    expect(store.active()).toHaveLength(20);
  });
});
