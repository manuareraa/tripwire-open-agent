// Names for suppliers, decisions and data rows. Holds the supplier list once it is loaded.
import { LABEL, METRIC, TABLE, TEMPLATE } from "./labels";
import type { Supplier } from "./types";

let suppliers: Supplier[] = [];
export const setSuppliers = (list: Supplier[]) => { suppliers = list; };
export const getSuppliers = () => suppliers;

export const sup = (id: string) => suppliers.find((s) => s.supplier_id === id);
export const supName = (id: string) => sup(id)?.short || id;
export const initials = (id: string) => (supName(id) || id).replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
export const supByCik = (k: unknown) => suppliers.find((s) => s.cik != null && String(s.cik) === String(k));

export const tplName = (t: unknown) => TEMPLATE[String(t)] ?? String(t || "").replace(/_/g, " ");
export const metricName = (m: unknown) => METRIC[String(m)]?.[0] ?? String(m || "").replace(/_/g, " ");
export const verdictName = (v: unknown) => LABEL[String(v)] ?? String(v || "").replace(/_/g, " ");

/** DEC-SUP-06-jozqki → "Kemet's decision". */
export function decName(id: unknown) { const m = String(id || "").match(/^DEC-(SUP-\d+)-/); return m ? `${supName(m[1])}'s decision` : String(id || ""); }
/** One data row in words: supplier_financials:898293 → "Jabil's SEC filings". */
export function rowName(table: string, key: string) {
  if (table === "supplier_financials") { const s = supByCik(key); return s ? `${s.short}'s SEC filings` : `SEC filings of company ${key}`; }
  if (table === "supplier_spend") return `${supName(key)}'s spend record`;
  if (table === "tripwire_decisions") return decName(key);
  return `${String(table).replace(/_/g, " ")} row ${key}`;
}
export const rowTip = (table: string, key: string) => table === "supplier_financials" ? `SEC company ID (CIK) ${key}, in the ${TABLE[table]}` : `Row ${key} in the ${TABLE[table] ?? table}`;
