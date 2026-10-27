import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultTripwires } from "../app/tripwires.js";
import {
  asOfDates, bestArm, ceoCfoDeparture, firstFiring, metricsAsOf, qIndex, qLabel, scoreArm, trackRecord, troubleEvents,
  type BacktestResults, type Period, type SupplierHistory,
} from "../app/proving/backtest.js";

const period = (end: string, known: string, cr: number, de = 1, extra: Partial<Period> = {}): Period => ({
  end, known, current_ratio: cr, debt_to_equity: de, gross_margin: 0.3, revenue: 1000, accession: `acc-${end}`, ...extra,
});

const hist = (over: Partial<SupplierHistory> = {}): SupplierHistory => ({
  supplier_id: "SUP-01", ticker: "TST", cik: "1", category: "x",
  periods: [
    period("2020-12-31", "2021-02-10", 1.5),
    period("2021-03-31", "2021-05-05", 1.4),
    period("2021-06-30", "2021-08-04", 0.9), // covenant break starts, known 2021Q3
    period("2021-09-30", "2021-11-03", 0.8),
  ],
  filings: [],
  ...over,
});

describe("quarters", () => {
  it("indexes and labels calendar quarters", () => {
    expect(qLabel(qIndex("2021-05-05"))).toBe("2021Q2");
    expect(qIndex("2021-12-31") - qIndex("2021-01-01")).toBe(3);
  });
  it("only uses as-of dates whose window and follow-up have passed", () => {
    const d = asOfDates("2026-10-27");
    expect(d[0]).toBe("2021-03-31");
    expect(d.at(-1)).toBe("2025-09-30");
    expect(d).toHaveLength(10);
  });
});

describe("pre-registered trouble", () => {
  it("counts trouble 8-K items and a covenant break when it starts", () => {
    const h = hist({ filings: [
      { filed: "2021-04-01", accession: "a", items: ["2.02", "9.01"], url: "u1" },
      { filed: "2021-04-02", accession: "b", items: ["2.06"], url: "u2" },
      { filed: "2021-04-03", accession: "c", items: ["5.02"], ceo_cfo_departure: false, url: "u3" },
      { filed: "2021-04-04", accession: "d", items: ["5.02"], ceo_cfo_departure: true, url: "u4" },
    ] });
    const ev = troubleEvents(h);
    expect(ev.map((e) => e.source)).toEqual(["u2", "u4", "acc-2021-06-30"]);
    expect(ev[2]).toMatchObject({ kind: "covenant", date: "2021-08-04", quarter: "2021Q3" });
  });
  it("reads a CEO or CFO departure from the Item 5.02 text only", () => {
    expect(ceoCfoDeparture("<p>Item 5.02 Departure of Directors</p><p>On May 1, Jane Doe notified the Company that she will resign as Chief Financial Officer.</p><p>Item 9.01 Exhibits</p>")).toBe(true);
    expect(ceoCfoDeparture("Item 5.02 The board elected John Roe as a director. Item 9.01 Exhibits")).toBe(false);
    expect(ceoCfoDeparture("Item 2.02 Results. The CEO will retire.")).toBe(false);
  });
});

describe("as-of discipline", () => {
  it("uses only filings filed by the as-of date", () => {
    const m = new Map(metricsAsOf(hist(), "2021-06-30", { spend_share: 0.4 }).map((x) => [x.metric, x.value]));
    expect(m.get("current_ratio")).toBe(1.4); // the 2021-06-30 quarter was not filed until August
    expect(m.get("spend_share")).toBe(0.4);
  });
  it("fires the rule tripwire on the first filing that crosses the line", () => {
    const h = hist();
    const tw = defaultTripwires(metricsAsOf(h, "2021-03-31", {}));
    expect(tw[0]).toMatchObject({ metric: "current_ratio", op: "<", threshold: 1 });
    expect(firstFiring(tw, h, "2021-03-31", "2021-09-30", {})).toMatchObject({ date: "2021-08-04", metric: "current_ratio", value: 0.9 });
  });
});

describe("scoring", () => {
  it("counts an early catch, the warning, and a false alarm", () => {
    const h = hist();
    const quiet: SupplierHistory = { ...hist({ supplier_id: "SUP-02" }), periods: [period("2020-12-31", "2021-02-10", 1.2), period("2021-03-31", "2021-05-05", 0.95), period("2021-06-30", "2021-08-04", 1.3)] };
    const cases = [
      { supplier_id: "SUP-01", as_of: "2021-03-31", tripwires: [{ metric: "current_ratio", op: "<" as const, threshold: 1.45 }] },
      { supplier_id: "SUP-02", as_of: "2021-06-01", tripwires: [{ metric: "current_ratio", op: ">" as const, threshold: 1.25 }] },
    ];
    const r = scoreArm("rules", "Rule-based tripwires (no model)", cases, [h, quiet], {});
    expect(r.totals).toMatchObject({ decisions: 2, trouble_events: 1, caught_early: 1, firings: 2 });
    // Fired on the May filing (1.4), a quarter before the covenant break was filed in August.
    expect(r.events![0]).toMatchObject({ caught_early: true, quarters_of_warning: 1 });
    // SUP-02 had a break onset at 2021-05-05 (0.95), before its as-of, so the August firing has nothing after it.
    expect(r.cases!.find((c) => c.supplier_id === "SUP-02")!.false_alarm).toBe(true);
    expect(r.suppliers!.find((s) => s.supplier_id === "SUP-02")).toMatchObject({ false_alarms: 1, trouble_events: 0 });
  });
  it("does not count a firing on the same day the trouble was filed as early", () => {
    const r = scoreArm("x", "x", [{ supplier_id: "SUP-01", as_of: "2021-03-31", tripwires: [{ metric: "current_ratio", op: "<", threshold: 1 }] }], [hist()], {});
    expect(r.totals).toMatchObject({ trouble_events: 1, caught_early: 0, firings: 1 });
  });
  it("misses trouble when no tripwire watches it", () => {
    const r = scoreArm("x", "x", [{ supplier_id: "SUP-01", as_of: "2021-03-31", tripwires: [] }], [hist()], {});
    expect(r.totals).toMatchObject({ trouble_events: 1, caught_early: 0, false_alarms: 0, median_quarters_of_warning: null });
  });
});

describe("trackRecord", () => {
  const results: BacktestResults = {
    window: "2021Q2–2026Q1",
    arms: [
      { arm: "rules", label: "Rule-based tripwires (no model)", status: "measured", totals: { decisions: 2, trouble_events: 3, trouble_8k: 2, trouble_covenant: 1, caught_early: 1, caught_a_quarter_or_more_early: 0, median_quarters_of_warning: 0, firings: 2, false_alarms: 1 }, suppliers: [{ supplier_id: "SUP-01", ticker: "TST", trouble_events: 2, caught_early: 1, false_alarms: 0, firings: 1 }] },
      { arm: "crashed", label: "Pre-mortem + crash-tested tripwires", status: "not run yet" },
    ],
  };
  it("never picks an arm that was not run", () => {
    expect(bestArm(results)?.arm).toBe("rules");
  });
  it("returns this supplier's measured record with the arm named", () => {
    const dir = mkdtempSync(join(tmpdir(), "bt-"));
    const path = join(dir, "r.json");
    writeFileSync(path, JSON.stringify(results));
    const t = trackRecord("SUP-01", path)!;
    expect(t).toMatchObject({ window: "2021Q2–2026Q1", trouble_events: 2, caught_early: 1, false_alarms: 0 });
    expect(t.note).toContain("Rule-based tripwires (no model)");
    expect(trackRecord("SUP-99", path)).toBeUndefined();
  });
  it("is undefined with no results file", () => {
    expect(trackRecord("SUP-01", join(tmpdir(), "missing-backtest.json"))).toBeUndefined();
  });
});
