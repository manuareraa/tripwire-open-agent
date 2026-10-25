// Row changes shared by both data layers: parsing and validating change files, merging changes into a table,
// diffing two versions of a table, and the catalog of bundled demo changes read from whichever data layer is live.
import { readFileSync } from "node:fs";
import { ROW_KEY, TABLES } from "./sql/templates.js";
import type { DataGateway, RowRef } from "./types.js";

export type Row = Record<string, unknown>;

/** A row change: a bundled file in data/sample/changes/*.json holds one or an array; what-ifs build them in code. */
export interface ChangeFile {
  description?: string;
  synthetic?: boolean;
  table: string;
  key: string;
  row: Row;
}

/** Columns that identify a row (financials have one row per filing period). */
export const IDENTITY: Record<string, string[]> = {
  [TABLES.spend]: ["supplier_id"],
  [TABLES.financials]: ["cik", "period_end"],
  [TABLES.events]: ["cik", "accession"],
  [TABLES.sanctions]: ["cik"],
};

/** Numeric columns per table; everything else is a string. Empty cells are null. */
export const NUMERIC: Record<string, Set<string>> = {
  [TABLES.financials]: new Set(["revenue", "gross_margin", "current_ratio", "debt_to_equity"]),
  [TABLES.spend]: new Set(["spend_share", "lead_time_weeks", "open_po_value"]),
  [TABLES.events]: new Set(),
  [TABLES.sanctions]: new Set(["list_entries", "match_count"]),
};

/** Every column of each changeable table, in table order. */
export const COLUMNS: Record<string, string[]> = {
  [TABLES.financials]: ["cik", "ticker", "name", "sic", "period_end", "revenue", "gross_margin", "current_ratio", "debt_to_equity", "source_url"],
  [TABLES.spend]: ["supplier_id", "cik", "category", "spend_share", "lead_time_weeks", "open_po_value", "contract_end", "updated_at"],
  [TABLES.events]: ["cik", "filed_date", "form", "items", "accession", "url"],
  [TABLES.sanctions]: ["cik", "name", "list", "list_as_of", "list_entries", "match_count", "matches", "screened_on", "source_url"],
};

/** Numbers stay numbers, "" and null become null, everything else a string. */
export function normaliseRow(table: string, row: Row): Row {
  const numeric = NUMERIC[table] ?? new Set<string>();
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v === null || v === undefined || v === "" ? null : numeric.has(k) ? Number(v) : String(v);
  }
  return out;
}

/** Check one change and return it normalised; throws with a readable reason. */
export function validateChange(c: unknown): ChangeFile {
  const ch = c as Partial<ChangeFile>;
  if (!ch || typeof ch !== "object" || typeof ch.table !== "string" || !ch.row || typeof ch.row !== "object") {
    throw new Error("change needs a table and a row");
  }
  const ids = IDENTITY[ch.table];
  if (!ids) throw new Error(`change targets unknown table ${ch.table}`);
  const keyCol = ROW_KEY[ch.table];
  if (String(ch.row[keyCol]) !== String(ch.key)) throw new Error(`change key ${String(ch.key)} != row.${keyCol}`);
  for (const id of ids) {
    if (ch.row[id] === undefined || ch.row[id] === null || ch.row[id] === "") throw new Error(`change row has no ${id}`);
  }
  for (const col of Object.keys(ch.row)) {
    if (!COLUMNS[ch.table].includes(col)) throw new Error(`change row has unknown column ${ch.table}.${col}`);
  }
  for (const col of NUMERIC[ch.table]) {
    const v = ch.row[col];
    if (v !== undefined && v !== null && v !== "" && !Number.isFinite(Number(v))) throw new Error(`${ch.table}.${col} is not a number`);
  }
  return { ...ch, key: String(ch.key), table: ch.table, row: normaliseRow(ch.table, ch.row) } as ChangeFile;
}

export function parseChanges(parsed: unknown): ChangeFile[] {
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0) throw new Error("change file is empty");
  return list.map(validateChange);
}

export function readChangeFile(path: string): ChangeFile[] {
  return parseChanges(JSON.parse(readFileSync(path, "utf8")));
}

/** Equal as table values: null and "" are the same, numbers compare with a tiny tolerance (Parquet doubles). */
export function sameValue(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v === null || v === undefined || v === "";
  if (empty(a) || empty(b)) return empty(a) && empty(b);
  if (typeof a === "number" || typeof b === "number") {
    const x = Number(a);
    const y = Number(b);
    return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  }
  return String(a) === String(b);
}

const identityOf = (table: string, r: Row) => IDENTITY[table].map((c) => String(r[c] ?? "")).join("\u0000");

/** True when `row` has the given values in every column the change sets. */
export function rowHas(row: Row | undefined, values: Row): boolean {
  return !!row && Object.entries(values).every(([k, v]) => sameValue(row[k], v));
}

/** Upsert changes into a copy of `rows` by identity ({...old, ...new}); `replaced` says whether any existing row changed. */
export function mergeRows(table: string, rows: Row[], changes: ChangeFile[]): { rows: Row[]; replaced: boolean; added: Row[] } {
  const out = rows.map((r) => ({ ...r }));
  const index = new Map(out.map((r, i) => [identityOf(table, r), i]));
  const added: Row[] = [];
  let replaced = false;
  for (const c of changes) {
    if (c.table !== table) continue;
    const id = identityOf(table, c.row);
    const i = index.get(id);
    if (i !== undefined) {
      out[i] = { ...out[i], ...c.row };
      replaced = true;
    } else {
      const row = { ...c.row };
      index.set(id, out.length);
      out.push(row);
      added.push(row);
    }
  }
  return { rows: out, replaced, added };
}

/** Rows (by lineage key) that were added, removed or changed between two versions of a table. */
export function diffTables(table: string, before: Row[], after: Row[]): RowRef[] {
  const cols = COLUMNS[table];
  const a = new Map(before.map((r) => [identityOf(table, r), r]));
  const b = new Map(after.map((r) => [identityOf(table, r), r]));
  const keys = new Set<string>();
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id);
    const y = b.get(id);
    if (!x || !y || cols.some((c) => !sameValue(x[c], y[c]))) keys.add(String((x ?? y)![ROW_KEY[table]]));
  }
  return [...keys].map((key) => ({ table, key }));
}

export interface CatalogEntry {
  file: string;
  description: string;
  synthetic: boolean;
  table: string;
  key: string;
  supplier_id?: string;
  supplier_name?: string;
  /** Every row in the file already has these values in the live data (applying again changes nothing). */
  in_data: boolean;
  fields: { field: string; before: number | null; after: number }[];
}

/**
 * The bundled demo changes, checked against the live data layer: whether each is already in the data, and which
 * numbers it moves. "before" is the value the change replaces (for a new quarter, the latest earlier quarter);
 * once a spend change is in the data, the bundled base value is shown instead so the delta stays readable.
 */
export async function changeCatalog(
  gw: DataGateway,
  files: { file: string; changes: ChangeFile[] }[],
  base: Record<string, Row[]>,
): Promise<CatalogEntry[]> {
  const out: CatalogEntry[] = [];
  for (const { file, changes } of files) {
    const first = changes[0];
    let in_data = true;
    let before: Row | undefined;
    for (const c of changes) {
      const current = await currentRow(gw, c);
      // Compare the values the template returns (history has no name/ticker/source), ignoring the updated_at stamp.
      const values = Object.fromEntries(Object.entries(c.row).filter(([k]) => k !== "updated_at" && (!current || k in current)));
      if (!rowHas(current, values)) in_data = false;
      if (c === first) {
        if (c.table === TABLES.spend) {
          before = in_data ? base[TABLES.spend].find((r) => r.supplier_id === c.key) ?? current : current;
        } else if (c.table === TABLES.sanctions) {
          before = in_data ? (base[TABLES.sanctions] ?? []).find((r) => String(r.cik) === c.key) ?? current : current;
        } else if (c.table === TABLES.events) {
          before = undefined;
        } else {
          const hist = (await gw.runTemplate("supplier_financials_history", { cik: c.key, periods: 12 })).rows;
          before = hist.find((r) => String(r.period_end) < String(c.row.period_end));
        }
      }
    }
    const isSpend = first.table === TABLES.spend;
    const supplier_id = isSpend ? first.key : base[TABLES.spend].find((r) => String(r.cik) === first.key)?.supplier_id;
    const cik = isSpend ? String(first.row.cik ?? "") : first.key;
    const name = base[TABLES.financials].find((r) => String(r.cik) === cik)?.name;
    const fields = [...NUMERIC[first.table]]
      .filter((f) => typeof first.row[f] === "number" && !sameValue(before?.[f], first.row[f]))
      .map((f) => ({ field: f, before: before?.[f] == null ? null : Number(before[f]), after: Number(first.row[f]) }));
    out.push({
      file, description: first.description ?? file, synthetic: first.synthetic ?? false, table: first.table, key: first.key,
      supplier_id: supplier_id == null ? undefined : String(supplier_id), supplier_name: name == null ? undefined : String(name),
      in_data, fields,
    });
  }
  return out;
}

/** The live row a change would replace, read through the data layer's own templates. */
async function currentRow(gw: DataGateway, c: ChangeFile): Promise<Row | undefined> {
  if (c.table === TABLES.spend) return (await gw.runTemplate("supplier_spend_row", { supplier_id: c.key })).rows[0];
  if (c.table === TABLES.sanctions) return (await gw.runTemplate("sanctions_screen_row", { cik: c.key })).rows[0];
  if (c.table === TABLES.events) {
    return (await gw.runTemplate("supplier_events_recent", { cik: c.key })).rows.find((r) => String(r.accession) === String(c.row.accession));
  }
  const hist = (await gw.runTemplate("supplier_financials_history", { cik: c.key, periods: 12 })).rows;
  return hist.find((r) => String(r.period_end) === String(c.row.period_end));
}
