// The only SQL Tripwire runs. Agents pick a template id and params; they never write SQL.
// Both DataGateway implementations (zetaris, sample) must serve exactly these ids.
import type { TemplateSpec } from "../types.js";

/** Zetaris database/schema prefix for the tables, e.g. `tripwire.`; set by the zetaris adapter. */
export const TABLES = {
  financials: "supplier_financials",
  spend: "supplier_spend",
  events: "supplier_events",
  sanctions: "sanctions_screen",
  status: "source_status",
  decisions: "tripwire_decisions",
} as const;

/** Column that identifies a row of each table, used in Evidence.depends_on / RowRef.key. */
export const ROW_KEY: Record<string, string> = {
  supplier_financials: "cik",
  supplier_spend: "supplier_id",
  supplier_events: "cik",
  sanctions_screen: "cik",
  source_status: "source",
  tripwire_decisions: "decision_id",
};

export const TEMPLATES: TemplateSpec[] = [
  {
    id: "supplier_spend_row",
    description: "Our spend, lead time, open POs and contract end for one supplier",
    table: TABLES.spend,
    params: ["supplier_id"],
    sql: `SELECT supplier_id, cik, category, spend_share, lead_time_weeks, open_po_value, contract_end, updated_at FROM {{spend}} WHERE supplier_id = {{supplier_id}}`,
  },
  {
    id: "supplier_financials_latest",
    description: "Most recent reported financials for one supplier (by CIK)",
    table: TABLES.financials,
    params: ["cik"],
    sql: `SELECT cik, ticker, name, period_end, revenue, gross_margin, current_ratio, debt_to_equity, source_url FROM {{financials}} WHERE cik = {{cik}} ORDER BY period_end DESC LIMIT 1`,
  },
  {
    id: "supplier_financials_history",
    description: "Last N reported periods for one supplier, newest first",
    table: TABLES.financials,
    params: ["cik", "periods"],
    sql: `SELECT cik, period_end, revenue, gross_margin, current_ratio, debt_to_equity FROM {{financials}} WHERE cik = {{cik}} ORDER BY period_end DESC LIMIT {{periods}}`,
  },
  {
    id: "category_concentration",
    description: "All suppliers in a category with their share of our spend",
    table: TABLES.spend,
    params: ["category"],
    sql: `SELECT supplier_id, spend_share, lead_time_weeks FROM {{spend}} WHERE category = {{category}} ORDER BY spend_share DESC`,
  },
  {
    id: "supplier_events_recent",
    description: "Material-event filings (SEC 8-K) for one supplier in the last 12 months, newest first",
    table: TABLES.events,
    params: ["cik"],
    sql: `SELECT cik, filed_date, form, items, accession, url FROM {{events}} WHERE cik = {{cik}} ORDER BY filed_date DESC LIMIT 25`,
  },
  {
    id: "sanctions_screen_row",
    description: "The supplier's name screened against the US Treasury OFAC sanctions (SDN) list",
    table: TABLES.sanctions,
    params: ["cik"],
    sql: `SELECT cik, name, list, list_as_of, list_entries, match_count, matches, screened_on, source_url FROM {{sanctions}} WHERE cik = {{cik}}`,
  },
  {
    id: "source_status",
    description: "When each external source was last fetched, and the date its contents are current to",
    table: TABLES.status,
    params: [],
    sql: `SELECT source, system, fetched_on, as_of, row_count, url FROM {{status}} ORDER BY source`,
  },
  {
    id: "decisions_for_supplier",
    description: "Decision ledger entries for one supplier, newest first",
    table: TABLES.decisions,
    params: ["supplier_id"],
    sql: `SELECT decision_id, supplier_id, decision, confidence, status, tripwires, evidence, supersedes, created_at, approved_by_reason FROM {{decisions}} WHERE supplier_id = {{supplier_id}} ORDER BY created_at DESC`,
  },
];

const PARAM_RULES: Record<string, RegExp> = {
  supplier_id: /^SUP-\d{2,3}$/,
  cik: /^\d{1,10}$/,
  periods: /^([1-9]|1[0-2])$/,
  category: /^[a-z][a-z0-9_]{1,40}$/,
};

export function getTemplate(id: string): TemplateSpec {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`unknown template: ${id}`);
  return t;
}

/** Validate params against strict patterns and render SQL. Strings are single-quoted; numbers inlined. */
export function renderTemplate(id: string, params: Record<string, string | number>, prefix = ""): string {
  const t = getTemplate(id);
  for (const p of t.params) {
    const v = params[p];
    if (v === undefined) throw new Error(`template ${id}: missing param ${p}`);
    if (!PARAM_RULES[p]?.test(String(v))) throw new Error(`template ${id}: invalid ${p}`);
  }
  return t.sql.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    if (name in TABLES) return prefix + TABLES[name as keyof typeof TABLES];
    const v = String(params[name]);
    return name === "periods" ? v : `'${v}'`;
  });
}
