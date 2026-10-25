// The Critic sends a source past its line back to the Planner; if it is still past the line, the decision is capped,
// carries a tripwire that reopens it when the source updates, and a stale sanctions screen goes to compliance.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SampleDataGateway } from "../app/adapters/sample_data.js";
import { RulesOnlyClient } from "../app/adapters/model.js";
import { STALE_CONFIDENCE_CAP } from "../app/agents/critic.js";
import { DecisionStore } from "../app/store.js";
import { FakeMemory } from "./fakes.js";
import type { Deps } from "../app/orchestration/state.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let runDecide: typeof import("../app/orchestration/graph.js").runDecide;
let reopenFor: typeof import("../app/watcher.js").reopenFor;
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
  ({ reopenFor } = await import("../app/watcher.js"));
  ({ Tracer } = await import("../app/tracing.js"));
});
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const deps = (): Deps & { gateway: SampleDataGateway } => ({
  gateway: new SampleDataGateway({ ledgerDir: tmp("tw-ledger-"), sampleDir: tmp("tw-sample-", join(REPO_ROOT, "data/sample")) }),
  model: new RulesOnlyClient(), memory: new FakeMemory(), tracer: new Tracer(),
});

describe("stale sources: re-plan, hold, reopen", () => {
  it("re-reads VSH's stale financials, caps the decision, and reopens it when the new quarter arrives", async () => {
    const d = deps();
    const store = new DecisionStore();
    const { decision } = await runDecide(d, "SUP-20", "Review");
    const actions = d.tracer.all().filter((e) => e.decision_id === decision.decision_id).map((e) => `${e.agent_name}:${e.action}`);
    expect(actions).toContain("EvidenceCritic:send_back_stale");
    expect(actions.indexOf("Planner:replan")).toBeGreaterThan(actions.indexOf("EvidenceCritic:send_back_stale"));
    expect(actions).toContain("EvidenceCritic:hold_for_stale");
    expect(decision.confidence).toBeLessThanOrEqual(STALE_CONFIDENCE_CAP);
    expect(decision.limitations.filter((l) => l.startsWith("Source freshness: STALE SEC financials"))).toHaveLength(1);
    expect(decision.tripwires.find((t) => t.metric === "source_as_of:supplier_financials")).toMatchObject({ op: "changed" });
    store.put(decision);

    // Nothing VSH's number tripwires watch crosses a line in this filing; only the source update reopens it.
    const reports = [];
    for (const row of await d.gateway.applyChange("01_new_quarter.json")) reports.push(await reopenFor(d, store, row));
    const reopened = reports.flatMap((r) => r.reopened);
    expect(reopened).toHaveLength(1);
    expect(reopened[0].fired).toEqual([expect.stringMatching(/^supplier_financials as-of date changed\? \(now 2026-07-04, was 2026-04-04\)/)]);
    expect(reopened[0].new.sources!.find((f) => f.table === "supplier_financials")!.status).toBe("fresh");
    expect(reopened[0].new.tripwires.some((t) => t.metric.startsWith("source_as_of:"))).toBe(false);
  });

  it("leaves a supplier with every source in line untouched", async () => {
    const d = deps();
    const { decision } = await runDecide(d, "SUP-08", "Review");
    expect(d.tracer.all().some((e) => e.action === "send_back_stale" || e.action === "hold_for_stale")).toBe(false);
    expect(decision.tripwires.some((t) => t.metric.startsWith("source_as_of:"))).toBe(false);
  });

  it("sends a decision on a stale sanctions screen to compliance", async () => {
    const d = deps();
    await d.gateway.applyChangeRows([{
      table: "sanctions_screen", key: "915389",
      row: { cik: "915389", name: "EASTMAN CHEMICAL CO", list: "OFAC SDN", list_as_of: "2026-09-01", list_entries: 19472, match_count: 0, matches: "", screened_on: "2026-09-01", source_url: "https://www.treasury.gov/ofac/downloads/sdn.csv" },
    }], "test");
    const { decision } = await runDecide(d, "SUP-08", "Review");
    expect(decision.sources!.find((f) => f.table === "sanctions_screen")!.status).toBe("stale");
    expect(decision.escalated).toBe(true);
    expect(decision.escalation_reasons).toContain("the sanctions screen is stale; compliance must re-screen before any new order");
  });
});
