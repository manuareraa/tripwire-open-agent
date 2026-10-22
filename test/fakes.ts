// Test doubles for the adapters other streams build. They follow the same contracts in app/types.ts.
import { canonicalHash } from "../app/hash.js";
import { ROW_KEY, getTemplate, renderTemplate } from "../app/sql/templates.js";
import type {
  DataGateway, Decision, MemoryClaim, MemoryStore, ModelClient, ModelRequest, ModelResponse, QueryResult, RowRef,
} from "../app/types.js";

type Row = Record<string, string | number>;

export function fixtureTables() {
  const spend: Row[] = [
    { supplier_id: "SUP-01", cik: "100", category: "chips", spend_share: 0.2, lead_time_weeks: 8, open_po_value: 1e6, contract_end: "2027-06-30", updated_at: "2026-10-01" },
    { supplier_id: "SUP-02", cik: "200", category: "chips", spend_share: 0.45, lead_time_weeks: 14, open_po_value: 3e6, contract_end: "2027-01-31", updated_at: "2026-10-01" },
    { supplier_id: "SUP-03", cik: "300", category: "chips", spend_share: 0.35, lead_time_weeks: 6, open_po_value: 2e6, contract_end: "2028-01-31", updated_at: "2026-10-01" },
    { supplier_id: "SUP-04", cik: "400", category: "resin", spend_share: 0.6, lead_time_weeks: 4, open_po_value: 5e5, contract_end: "2027-03-31", updated_at: "2026-10-01" },
    { supplier_id: "SUP-05", cik: "500", category: "resin", spend_share: 0.4, lead_time_weeks: 5, open_po_value: 4e5, contract_end: "2027-09-30", updated_at: "2026-10-01" },
  ];
  const fin: Row[] = [];
  const add = (cik: string, rows: [string, number, number, number, number][]) =>
    rows.forEach(([period_end, revenue, gross_margin, current_ratio, debt_to_equity]) =>
      fin.push({ cik, ticker: `T${cik}`, name: `Co ${cik}`, sic: "3674", period_end, revenue, gross_margin, current_ratio, debt_to_equity, source_url: `https://data.sec.gov/x/${cik}` }));
  add("100", [["2025-06-30", 900, 0.4, 1.8, 0.5], ["2026-06-30", 1000, 0.42, 1.9, 0.45]]);
  add("200", [["2025-06-30", 1000, 0.2, 1.1, 1.8], ["2026-06-30", 800, 0.12, 0.85, 2.6]]);
  add("300", [["2025-06-30", 500, 0.3, 1.4, 1.0], ["2026-06-30", 520, 0.31, 1.3, 1.1]]);
  add("400", [["2025-06-30", 300, 0.25, 1.5, 0.8], ["2026-06-30", 310, 0.26, 1.6, 0.7]]);
  add("500", [["2025-06-30", 200, 0.22, 1.2, 1.2], ["2026-06-30", 205, 0.23, 1.25, 1.1]]);
  return { spend, fin };
}

export class FakeGateway implements DataGateway {
  readonly name = "sample" as const;
  decisions: Decision[] = [];
  constructor(public tables = fixtureTables()) {}
  async health() { return { ok: true, detail: "fake" }; }
  listTemplates() { return []; }
  async runTemplate(id: string, params: Record<string, string | number>): Promise<QueryResult> {
    const t = getTemplate(id);
    const sql = renderTemplate(id, params);
    let rows: Row[] = [];
    const { spend, fin } = this.tables;
    const byPeriod = (a: Row, b: Row) => String(b.period_end).localeCompare(String(a.period_end));
    if (id === "supplier_spend_row") rows = spend.filter((r) => r.supplier_id === params.supplier_id);
    if (id === "supplier_financials_latest") rows = fin.filter((r) => r.cik === params.cik).sort(byPeriod).slice(0, 1);
    if (id === "supplier_financials_history") rows = fin.filter((r) => r.cik === params.cik).sort(byPeriod).slice(0, Number(params.periods));
    if (id === "category_concentration") rows = spend.filter((r) => r.category === params.category).map(({ supplier_id, spend_share, lead_time_weeks }) => ({ supplier_id, spend_share, lead_time_weeks }));
    const key = ROW_KEY[t.table];
    const depends_on: RowRef[] = [...new Set(rows.map((r) => String(r[key])))].map((k) => ({ table: t.table, key: k }));
    return { rows, sample: true, evidence: { template_id: id, params, sql, table: t.table, result_hash: canonicalHash(rows), depends_on } };
  }
  async writeDecision(d: Decision) { this.decisions.push(d); return { written: true, method: "fake", detail: "" }; }
  async readDecisions() { return this.decisions; }
  async changesSince(marker: string) { return { changes: [], marker }; }
}

export class FakeMemory implements MemoryStore {
  claims: MemoryClaim[] = [];
  private n = 0;
  async remember(c: Omit<MemoryClaim, "id" | "created_at">) {
    const claim = { ...c, id: `m${++this.n}`, created_at: new Date().toISOString() };
    this.claims.push(claim);
    return claim;
  }
  async recall(subject_id: string) { return this.claims.filter((c) => c.subject_id === subject_id && !this.isSuperseded(c.id)); }
  async dependentsOf(row: RowRef) {
    const ids = this.claims.filter((c) => !this.isSuperseded(c.id) && c.derivedFrom.some((d) => d.row.table === row.table && d.row.key === row.key)).map((c) => c.decision_id!);
    return [...new Set(ids)];
  }
  async supersede(oldId: string, c: Omit<MemoryClaim, "id" | "created_at">) { return this.remember({ ...c, supersedes: oldId }); }
  private isSuperseded(id: string) { return this.claims.some((c) => c.supersedes === id); }
}

/** Scripted model: returns queued replies per agent, else reports fallback. */
export class ScriptedModel implements ModelClient {
  calls: ModelRequest[] = [];
  constructor(private replies: Record<string, string[]> = {}) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const q = this.replies[req.agent_name];
    const text = q?.shift();
    if (text === undefined) return { text: "", model: "none", thinking: false, tokens_in: 0, tokens_out: 0, latency_ms: 0, fallback: true, error: "scripted: none" };
    return { text, model: `fake-${req.tier}`, thinking: !!req.thinking, tokens_in: 10, tokens_out: 10, latency_ms: 1, fallback: false };
  }
}
