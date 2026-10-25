// Per-source freshness: each fragment a decision reads comes from a different system that updates at its own
// speed. For each one, work out how old the data is and whether that is still within its policy line.
// Computed in code from the rows the Analyst already gathered; nothing is estimated.
import { TABLES } from "./sql/templates.js";
import type { QueryResult } from "./types.js";

export type FreshnessStatus = "fresh" | "stale" | "missing";

export interface SourceFreshness {
  table: string;
  label: string;
  system: string;
  /** The date the contents are current to (latest quarter, list date, last row update). */
  as_of?: string;
  /** The date Tripwire last read the source system, when the source records it. */
  checked_on?: string;
  /** Days from the date that governs freshness (see `basis`) to the clock. */
  age_days?: number;
  max_age_days: number;
  basis: string;
  status: FreshnessStatus;
  note: string;
  /** Template whose evidence this assessment came from. */
  template_id: string;
}

interface Policy {
  label: string;
  system: string;
  template: string;
  maxAgeDays: number;
  basis: string;
}

/** Policy lines: how old each source may be before a decision built on it should be re-checked. */
export const SOURCE_POLICY: Record<string, Policy> = {
  [TABLES.spend]: { label: "Spend record", system: "ERP (synthetic)", template: "supplier_spend_row", maxAgeDays: 30, basis: "last update of the spend row" },
  [TABLES.financials]: {
    label: "SEC financials", system: "SEC EDGAR XBRL", template: "supplier_financials_latest", maxAgeDays: 151,
    basis: "end of the latest quarter on file (a 91-day quarter plus the 60-day 10-K filing window, the longest a large filer has)",
  },
  [TABLES.events]: { label: "SEC 8-K events", system: "SEC EDGAR filings feed", template: "supplier_events_recent", maxAgeDays: 7, basis: "last pull of the 8-K feed" },
  [TABLES.sanctions]: { label: "OFAC sanctions screen", system: "US Treasury OFAC SDN list", template: "sanctions_screen_row", maxAgeDays: 7, basis: "last screen against the list" },
};

const DAY = 86_400_000;
const isoDay = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined);
const ageDays = (day: string, now: Date) => Math.max(0, Math.floor((now.getTime() - Date.parse(`${day}T00:00:00Z`)) / DAY));

/** Assess every source a decision reads. `results` are the Analyst's query results, keyed by template id. */
export function assessFreshness(results: Record<string, QueryResult>, now: Date): SourceFreshness[] {
  const status = new Map((results.source_status?.rows ?? []).map((r) => [String(r.source), r]));
  const out: SourceFreshness[] = [];
  for (const [table, p] of Object.entries(SOURCE_POLICY)) {
    const res = results[p.template];
    const base = { table, label: p.label, system: p.system, max_age_days: p.maxAgeDays, basis: p.basis, template_id: p.template };
    const checked_on = isoDay(status.get(table)?.fetched_on);
    let as_of: string | undefined;
    let governing: string | undefined;
    switch (table) {
      case TABLES.spend:
        as_of = governing = isoDay(res?.rows[0]?.updated_at);
        break;
      case TABLES.financials:
        as_of = governing = isoDay(res?.rows[0]?.period_end);
        break;
      case TABLES.events:
        // No filings in the window is a real answer; the feed's own pull date says how current it is.
        as_of = governing = res ? checked_on : undefined;
        break;
      case TABLES.sanctions:
        as_of = isoDay(res?.rows[0]?.list_as_of);
        governing = isoDay(res?.rows[0]?.screened_on);
        break;
    }
    if (!res || !governing) {
      const why = !res ? "not read in this run" : table === TABLES.events ? "the 8-K feed has no pull date on record" : "no row for this supplier";
      out.push({ ...base, as_of, checked_on, max_age_days: p.maxAgeDays, status: "missing", note: `${p.label}: ${why}` });
      continue;
    }
    const age = ageDays(governing, now);
    const fresh = age <= p.maxAgeDays;
    out.push({
      ...base, as_of, checked_on, age_days: age, status: fresh ? "fresh" : "stale",
      note: `${p.label}: ${age} day${age === 1 ? "" : "s"} since ${p.basis} (${governing}); policy line ${p.maxAgeDays} days`,
    });
  }
  return out;
}
