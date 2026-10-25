import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SampleDataGateway, loadBaseTables } from "../app/adapters/sample_data.js";
import { changeCatalog, diffTables, mergeRows, sameValue, validateChange } from "../app/changes.js";
import { TABLES } from "../app/sql/templates.js";
import { addMonths, buildWhatIfs, type WhatIf, type WhatIfKind } from "../app/whatif.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_SAMPLE = join(REPO_ROOT, "data/sample");
const NOW = new Date("2026-10-25T08:30:00.123Z");

const tmpDirs: string[] = [];
const tmp = (prefix: string, from?: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (from) cpSync(from, dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function gateway() {
  return new SampleDataGateway({ ledgerDir: tmp("tripwire-ledger-"), sampleDir: tmp("tripwire-sample-", BUNDLED_SAMPLE) });
}
const spendRow = async (gw: SampleDataGateway, supplier_id: string) => (await gw.runTemplate("supplier_spend_row", { supplier_id })).rows[0];
const whatIf = async (gw: SampleDataGateway, supplier_id: string, kind: WhatIfKind): Promise<WhatIf> =>
  (await buildWhatIfs(gw, supplier_id, { now: NOW, sicByCik: new Map([["1306830", "2820"]]) })).find((w) => w.kind === kind)!;
const apply = (gw: SampleDataGateway, w: WhatIf) => gw.applyChangeRows(w.changes, w.id);

describe("change helpers", () => {
  it("validates and normalises a change", () => {
    const c = validateChange({ table: TABLES.spend, key: "SUP-06", row: { supplier_id: "SUP-06", spend_share: "0.5", contract_end: "" } });
    expect(c.row).toEqual({ supplier_id: "SUP-06", spend_share: 0.5, contract_end: null });
    expect(() => validateChange({ table: "nope", key: "x", row: {} })).toThrow(/unknown table/);
    expect(() => validateChange({ table: TABLES.spend, key: "SUP-07", row: { supplier_id: "SUP-06" } })).toThrow(/key/);
    expect(() => validateChange({ table: TABLES.spend, key: "SUP-06", row: { supplier_id: "SUP-06", bogus: 1 } })).toThrow(/unknown column/);
    expect(() => validateChange({ table: TABLES.spend, key: "SUP-06", row: { supplier_id: "SUP-06", spend_share: "lots" } })).toThrow(/not a number/);
    expect(() => validateChange({ table: TABLES.financials, key: "1", row: { cik: "1" } })).toThrow(/period_end/);
  });

  it("compares table values loosely and merges by identity", () => {
    expect(sameValue(null, "")).toBe(true);
    expect(sameValue(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameValue("7", 7)).toBe(true);
    expect(sameValue(0, null)).toBe(false);
    const rows = [{ cik: "1", period_end: "2026-03-31", revenue: 10 }];
    const merged = mergeRows(TABLES.financials, rows, [
      { table: TABLES.financials, key: "1", row: { cik: "1", period_end: "2026-03-31", revenue: 11 } },
      { table: TABLES.financials, key: "1", row: { cik: "1", period_end: "2026-06-30", revenue: 12 } },
    ]);
    expect(merged.replaced).toBe(true);
    expect(merged.added).toHaveLength(1);
    expect(merged.rows.map((r) => r.revenue)).toEqual([11, 12]);
    expect(rows[0].revenue).toBe(10);
    expect(diffTables(TABLES.financials, rows, merged.rows)).toEqual([{ table: TABLES.financials, key: "1" }]);
    expect(diffTables(TABLES.financials, rows, [{ ...rows[0] }])).toEqual([]);
  });

  it("keeps month ends when adding months", () => {
    expect(addMonths("2026-06-30", 3)).toBe("2026-09-30");
    expect(addMonths("2026-09-30", 3)).toBe("2026-12-31");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-01-30", 1)).toBe("2026-02-28");
    expect(addMonths("2026-07-04", 3)).toBe("2026-10-04");
    expect(addMonths("2027-06-30", 12)).toBe("2028-06-30");
    expect(() => addMonths("June", 1)).toThrow();
  });
});

describe("what-ifs", () => {
  it("shifts spend from the biggest other supplier in the category, scaling open orders", async () => {
    const gw = gateway();
    const w = await whatIf(gw, "SUP-06", "spend_shift");
    expect(w.available).toBe(true);
    expect(w.id).toBe("whatif:SUP-06:spend_shift");
    expect(w.changes.map((c) => c.key)).toEqual(["SUP-06", "SUP-05"]);
    expect(w.changes[0].row).toMatchObject({ spend_share: 0.55, open_po_value: 2950000, updated_at: "2026-10-25T08:30:00Z" });
    expect(w.changes[1].row).toMatchObject({ spend_share: 0.1, open_po_value: 540000 });
    expect(w.fields).toContainEqual({ table: TABLES.spend, key: "SUP-05", supplier_id: "SUP-05", field: "spend_share", before: 0.3, after: 0.1 });

    const refs = await apply(gw, w);
    expect(refs).toEqual([{ table: TABLES.spend, key: "SUP-06" }, { table: TABLES.spend, key: "SUP-05" }]);
    expect((await spendRow(gw, "SUP-06")).spend_share).toBe(0.55);
    const total = (await gw.runTemplate("category_concentration", { category: "chemicals" })).rows.reduce((n, r) => n + Number(r.spend_share), 0);
    expect(total).toBeCloseTo(1, 9);
  });

  it("moves the numbers again on every apply, stopping at 95% of the category", async () => {
    const gw = gateway();
    const shares: number[] = [];
    for (let i = 0; i < 4; i++) {
      await apply(gw, await whatIf(gw, "SUP-06", "spend_shift"));
      shares.push(Number((await spendRow(gw, "SUP-06")).spend_share));
    }
    expect(shares).toEqual([0.55, 0.75, 0.9, 0.95]);
    const done = await whatIf(gw, "SUP-06", "spend_shift");
    expect(done.available).toBe(false);
    expect(done.reason).toMatch(/95%/);
    expect(done.changes).toEqual([]);
  });

  it("lengthens lead time, capped at a year", async () => {
    const gw = gateway();
    const w = await whatIf(gw, "SUP-06", "lead_time");
    expect(w.changes[0].row.lead_time_weeks).toBe(11);
    await apply(gw, w);
    expect((await whatIf(gw, "SUP-06", "lead_time")).changes[0].row.lead_time_weeks).toBe(17);
    for (let i = 0; i < 10; i++) {
      const next = await whatIf(gw, "SUP-06", "lead_time");
      if (!next.available) break;
      await apply(gw, next);
    }
    expect((await spendRow(gw, "SUP-06")).lead_time_weeks).toBe(52);
    expect((await whatIf(gw, "SUP-06", "lead_time")).reason).toMatch(/52 weeks/);
  });

  it("renews the contract for a year with a bigger order book", async () => {
    const w = await whatIf(gateway(), "SUP-06", "contract_renewal");
    expect(w.changes[0].row).toMatchObject({ contract_end: "2028-06-30", open_po_value: 2350000, spend_share: 0.35 });
    expect(w.fields.map((f) => f.field)).toEqual(["contract_end", "open_po_value"]);
  });

  it("adds a new, weaker quarter after the latest filing", async () => {
    const gw = gateway();
    const w = await whatIf(gw, "SUP-06", "weak_quarter");
    const row = w.changes[0].row;
    expect(w.changes[0]).toMatchObject({ table: TABLES.financials, key: "1306830", synthetic: true });
    expect(row).toMatchObject({ cik: "1306830", ticker: "CE", sic: "2820", period_end: "2026-09-30", revenue: 2421760000, source_url: "synthetic what-if" });
    expect(row.gross_margin).toBeCloseTo(0.1909, 4);
    expect(row.current_ratio).toBeCloseTo(1.2296, 4);
    expect(row.debt_to_equity).toBeCloseTo(4.965, 4);

    await apply(gw, w);
    const latest = (await gw.runTemplate("supplier_financials_latest", { cik: "1306830" })).rows[0];
    expect(latest.period_end).toBe("2026-09-30");
    const down = await whatIf(gw, "SUP-06", "downturn");
    expect(down.changes[0].row.period_end).toBe("2026-12-31");
    expect(down.changes[0].row.revenue).toBe(Math.round(2421760000 * 0.7));
  });

  it("refuses an unknown supplier", async () => {
    await expect(buildWhatIfs(gateway(), "SUP-99")).rejects.toThrow(/no spend row/);
  });
});

describe("live catalog and reset", () => {
  it("reports whether each bundled change is in the data, from the data itself", async () => {
    const gw = gateway();
    const base = loadBaseTables(gw.sampleDir);
    const catalog = async () => Object.fromEntries((await changeCatalog(gw, gw.changeFiles(), base)).map((e) => [e.file, e]));

    let cat = await catalog();
    expect(Object.values(cat).every((e) => !e.in_data)).toBe(true);
    expect(cat["02_spend_share_jump.json"]).toMatchObject({ supplier_id: "SUP-06", supplier_name: "CELANESE CORPORATION" });
    expect(cat["02_spend_share_jump.json"].fields).toContainEqual({ field: "spend_share", before: 0.35, after: 0.58 });
    expect(cat["03_lead_time_slip.json"].fields).toEqual([{ field: "lead_time_weeks", before: 3, after: 9 }]);
    const quarter = cat["01_new_quarter.json"];
    expect(quarter.supplier_id).toBeDefined();
    expect(quarter.fields.find((f) => f.field === "current_ratio")?.after).toBe(1.8022);

    await gw.applyChange("02_spend_share_jump.json");
    await gw.applyChange("01_new_quarter.json");
    cat = await catalog();
    expect(cat["02_spend_share_jump.json"].in_data).toBe(true);
    expect(cat["02_spend_share_jump.json"].fields).toContainEqual({ field: "spend_share", before: 0.35, after: 0.58 });
    expect(cat["01_new_quarter.json"].in_data).toBe(true);

    // A what-if on the same row takes it out of the data again: the state is read, not remembered.
    await apply(gw, await whatIf(gw, "SUP-06", "lead_time"));
    expect((await catalog())["02_spend_share_jump.json"].in_data).toBe(false);
  });

  it("restores the bundled tables and names exactly the rows that changed", async () => {
    const gw = gateway();
    const base = loadBaseTables(gw.sampleDir);
    await gw.applyChange("02_spend_share_jump.json");
    await apply(gw, await whatIf(gw, "SUP-08", "spend_shift"));
    await apply(gw, await whatIf(gw, "SUP-06", "weak_quarter"));

    const refs = await gw.restoreBase();
    const keys = refs.map((r) => `${r.table}:${r.key}`).sort();
    expect(keys).toEqual([`${TABLES.financials}:1306830`, `${TABLES.spend}:SUP-06`, `${TABLES.spend}:SUP-08`].sort());
    expect(gw.snapshot()).toEqual(base);
    expect(await gw.restoreBase()).toEqual([]);
    expect((await gw.changesSince("0")).changes).toEqual([]);
  });
});
