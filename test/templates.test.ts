import { describe, it, expect } from "vitest";
import { TEMPLATES, renderTemplate } from "../app/sql/templates.js";

describe("renderTemplate", () => {
  it("renders every template id with valid params", () => {
    const cases: { id: string; params: Record<string, string | number>; expectInSql: string[] }[] = [
      {
        id: "supplier_spend_row",
        params: { supplier_id: "SUP-07" },
        expectInSql: ["FROM supplier_spend", "supplier_id = 'SUP-07'"],
      },
      {
        id: "supplier_financials_latest",
        params: { cik: "320193" },
        expectInSql: ["FROM supplier_financials", "cik = '320193'", "LIMIT 1"],
      },
      {
        id: "supplier_financials_history",
        params: { cik: "320193", periods: 6 },
        expectInSql: ["FROM supplier_financials", "cik = '320193'", "LIMIT 6"],
      },
      {
        id: "category_concentration",
        params: { category: "semiconductors" },
        expectInSql: ["FROM supplier_spend", "category = 'semiconductors'"],
      },
      {
        id: "decisions_for_supplier",
        params: { supplier_id: "SUP-99" },
        expectInSql: ["FROM tripwire_decisions", "supplier_id = 'SUP-99'"],
      },
      {
        id: "supplier_events_recent",
        params: { cik: "1751788" },
        expectInSql: ["FROM supplier_events", "cik = '1751788'", "ORDER BY filed_date DESC"],
      },
      {
        id: "sanctions_screen_row",
        params: { cik: "1751788" },
        expectInSql: ["FROM sanctions_screen", "cik = '1751788'"],
      },
      {
        id: "source_status",
        params: {},
        expectInSql: ["FROM source_status", "ORDER BY source"],
      },
    ];

    expect(cases.map((c) => c.id).sort()).toEqual(TEMPLATES.map((t) => t.id).sort());

    for (const { id, params, expectInSql } of cases) {
      const sql = renderTemplate(id, params);
      for (const fragment of expectInSql) {
        expect(sql).toContain(fragment);
      }
    }
  });

  it("rejects missing params", () => {
    expect(() => renderTemplate("supplier_spend_row", {})).toThrow(
      "template supplier_spend_row: missing param supplier_id",
    );
    expect(() => renderTemplate("supplier_financials_history", { cik: "1" })).toThrow(
      "template supplier_financials_history: missing param periods",
    );
  });

  it("rejects SQL injection attempts in string params", () => {
    expect(() =>
      renderTemplate("supplier_spend_row", { supplier_id: "SUP-07' OR 1=1" }),
    ).toThrow("template supplier_spend_row: invalid supplier_id");
    expect(() => renderTemplate("category_concentration", { category: "x'; DROP TABLE--" })).toThrow(
      "template category_concentration: invalid category",
    );
  });

  it("rejects unknown template ids", () => {
    expect(() => renderTemplate("not_a_template", { supplier_id: "SUP-01" })).toThrow(
      "unknown template: not_a_template",
    );
  });

  it("applies table prefix to spend, financials, and decisions placeholders", () => {
    const sql = renderTemplate("supplier_spend_row", { supplier_id: "SUP-07" }, "tripwire.");
    expect(sql).toContain("FROM tripwire.supplier_spend");
    expect(sql).not.toContain("FROM supplier_spend WHERE");

    const decisionsSql = renderTemplate("decisions_for_supplier", { supplier_id: "SUP-01" }, "dw.");
    expect(decisionsSql).toContain("FROM dw.tripwire_decisions");
  });
});
