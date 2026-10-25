// Per-source freshness: each fragment is measured against its own policy line, on the sample data's own clock.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SampleDataGateway } from "../app/adapters/sample_data.js";
import { assessFreshness } from "../app/freshness.js";
import { parseCsv } from "../scripts/fetch_sources.js";
import { FakeMemory, ScriptedModel } from "./fakes.js";
import type { Deps } from "../app/orchestration/state.js";
import type { QueryResult } from "../app/types.js";

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

const result = (rows: Record<string, unknown>[]): QueryResult => ({ rows, evidence: {} as never }) as unknown as QueryResult;
const csv = (name: string) => {
  const [h, ...rows] = parseCsv(readFileSync(join(REPO_ROOT, "data/sample", name), "utf8"));
  return rows.map((r) => Object.fromEntries(h.map((c, i) => [c, r[i]])));
};

describe("assessFreshness", () => {
  const now = new Date("2026-10-25T23:59:59Z");

  it("measures each source from its own governing date", () => {
    const f = assessFreshness(
      {
        supplier_spend_row: result([{ updated_at: "2026-10-01T09:00:00Z" }]),
        supplier_financials_latest: result([{ period_end: "2026-04-04" }]),
        supplier_events_recent: result([]),
        sanctions_screen_row: result([{ list_as_of: "2026-10-21", screened_on: "2026-10-10" }]),
        source_status: result([{ source: "supplier_events", fetched_on: "2026-10-25" }]),
      },
      now,
    );
    const by = Object.fromEntries(f.map((x) => [x.table, x]));
    expect(by.supplier_spend).toMatchObject({ status: "fresh", age_days: 24 });
    expect(by.supplier_financials).toMatchObject({ status: "stale", age_days: 204, as_of: "2026-04-04" });
    expect(by.supplier_events).toMatchObject({ status: "fresh", age_days: 0, as_of: "2026-10-25" });
    // The list date is shown, but the age runs from the last screen.
    expect(by.sanctions_screen).toMatchObject({ status: "stale", age_days: 15, as_of: "2026-10-21" });
  });

  it("calls a source missing rather than guessing", () => {
    const f = assessFreshness({ supplier_events_recent: result([]) }, now);
    expect(f.every((x) => x.status === "missing")).toBe(true);
    expect(f.find((x) => x.table === "supplier_events")!.note).toMatch(/no pull date/);
  });
});

describe("freshness across the real portfolio", () => {
  it("flags exactly the suppliers whose latest SEC quarter is past the line, and clears VSH when its 10-Q arrives", async () => {
    const gateway = new SampleDataGateway({ ledgerDir: tmp("tw-ledger-"), sampleDir: tmp("tw-sample-", join(REPO_ROOT, "data/sample")) });
    expect(gateway.clock().toISOString()).toBe("2026-10-25T23:59:59.000Z"); // the newest fetch in source_status.csv
    const d: Deps = { gateway, model: new ScriptedModel(), memory: new FakeMemory(), tracer: new Tracer() };
    const ticker = new Map(csv("supplier_financials.csv").map((r) => [r.cik, r.ticker]));
    const spend = csv("supplier_spend.csv");

    const stale: string[] = [];
    for (const r of spend) {
      const { decision } = await runDecide(d, r.supplier_id, "Review");
      const bySource = Object.fromEntries((decision.sources ?? []).map((x) => [x.table, x.status]));
      expect(bySource).toMatchObject({ supplier_spend: "fresh", supplier_events: "fresh", sanctions_screen: "fresh" });
      if (bySource.supplier_financials === "stale") {
        stale.push(ticker.get(r.cik)!);
        expect(decision.limitations.some((l) => /Source freshness: STALE SEC financials/.test(l))).toBe(true);
      }
    }
    expect(stale.sort()).toEqual(["DOW", "HUN", "SON", "VSH", "WOLF"]);

    await gateway.applyChange("01_new_quarter.json"); // VSH's real quarter ending 2026-07-04
    const vsh = spend.find((r) => ticker.get(r.cik) === "VSH")!;
    const { decision } = await runDecide(d, vsh.supplier_id, "Review");
    expect(decision.sources!.find((x) => x.table === "supplier_financials")).toMatchObject({ status: "fresh", as_of: "2026-07-04" });
  });
});
