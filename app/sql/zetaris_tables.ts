// Zetaris-specific SQL: table layout, DDL, and the RUN EXPORT statements that write files through Zetaris.
// Tables are Parquet "filestore" tables under the local customer-data volume of the Zetaris stack.
// Every string literal is base64-wrapped (CAST(unbase64("...") AS STRING)): the Lightning parser rejects
// doubled single quotes inside RUN EXPORT's query string, and base64 cannot break out of a literal.
import { TABLES } from "./templates.js";

export const ZETARIS_DB = "tripwire";
export const TABLE_PREFIX = `${ZETARIS_DB}.`;
export const STORAGE_ROOT = process.env.ZETARIS_STORAGE_ROOT ?? "/home/zetaris/customer-data/shared/tripwire";

export type ColType = "STRING" | "DOUBLE";

/** Column order and types. Types are explicit so every appended file has the same Parquet schema. */
export const SCHEMAS: Record<string, [string, ColType][]> = {
  [TABLES.financials]: [
    ["cik", "STRING"],
    ["ticker", "STRING"],
    ["name", "STRING"],
    ["sic", "STRING"],
    ["period_end", "STRING"],
    ["revenue", "DOUBLE"],
    ["gross_margin", "DOUBLE"],
    ["current_ratio", "DOUBLE"],
    ["debt_to_equity", "DOUBLE"],
    ["source_url", "STRING"],
  ],
  [TABLES.spend]: [
    ["supplier_id", "STRING"],
    ["cik", "STRING"],
    ["category", "STRING"],
    ["spend_share", "DOUBLE"],
    ["lead_time_weeks", "DOUBLE"],
    ["open_po_value", "DOUBLE"],
    ["contract_end", "STRING"],
    ["updated_at", "STRING"],
  ],
  // BUILD-PACK columns, plus `payload` (full Decision JSON) and `written_at` (ledger order).
  [TABLES.decisions]: [
    ["decision_id", "STRING"],
    ["supplier_id", "STRING"],
    ["decision", "STRING"],
    ["confidence", "DOUBLE"],
    ["status", "STRING"],
    ["tripwires", "STRING"],
    ["evidence", "STRING"],
    ["supersedes", "STRING"],
    ["created_at", "STRING"],
    ["approved_by_reason", "STRING"],
    ["payload", "STRING"],
    ["written_at", "STRING"],
  ],
};

export function tablePath(table: string): string {
  return `${STORAGE_ROOT}/${table}`;
}

function literal(v: unknown, type: ColType): string {
  if (v === null || v === undefined || v === "") return `CAST(NULL AS ${type})`;
  if (type === "DOUBLE") {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`not a number: ${String(v)}`);
    return `CAST(${n} AS DOUBLE)`;
  }
  return `CAST(unbase64("${Buffer.from(String(v), "utf8").toString("base64")}") AS STRING)`;
}

/** SELECT producing the given rows with the table's exact column types. Zero rows -> typed empty result. */
export function rowsSelect(table: string, rows: Record<string, unknown>[]): string {
  const cols = SCHEMAS[table];
  if (!cols) throw new Error(`no schema for ${table}`);
  if (rows.length === 0) {
    return `SELECT ${cols.map(([c, t]) => `CAST(NULL AS ${t}) AS ${c}`).join(", ")} WHERE 1 = 0`;
  }
  return rows.map((r) => `SELECT ${cols.map(([c, t]) => `${literal(r[c], t)} AS ${c}`).join(", ")}`).join(" UNION ALL ");
}

export type SaveMode = "append" | "overwrite";

export function exportSql(table: string, select: string, saveMode: SaveMode): string {
  if (select.includes("'")) throw new Error("export query must not contain single quotes");
  return `RUN EXPORT TO STORAGE (query = '${select}', path = '${tablePath(table)}', format = 'parquet', saveMode = '${saveMode}')`;
}

export const createDatabaseSql = () => `CREATE LIGHTNING DATABASE ${ZETARIS_DB} DESCRIBE BY "Tripwire supplier decisions"`;
export const showDatabasesSql = () => `SHOW LIGHTNING DATABASES`;
export const registerTableSql = (table: string) =>
  `CREATE LIGHTNING FILESTORE TABLE ${table} FROM ${ZETARIS_DB} FORMAT PARQUET OPTIONS (path "${tablePath(table)}")`;
export const dropTableSql = (table: string) => `DROP LIGHTNING DATABASE TABLE ${ZETARIS_DB}.${table}`;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DECISION_ID = /^[A-Za-z0-9_-]{1,80}$/;

export const ledgerReadSql = () =>
  `SELECT decision_id, supplier_id, decision, confidence, status, tripwires, evidence, supersedes, created_at, approved_by_reason, payload, written_at FROM ${TABLE_PREFIX}${TABLES.decisions}`;

export function ledgerCountSql(decisionId: string, writtenAt: string): string {
  if (!DECISION_ID.test(decisionId) || !ISO.test(writtenAt)) throw new Error("invalid decision id or timestamp");
  return `SELECT COUNT(*) AS n FROM ${TABLE_PREFIX}${TABLES.decisions} WHERE decision_id = '${decisionId}' AND written_at = '${writtenAt}'`;
}

export function spendChangesSql(marker: string): string {
  if (!ISO.test(marker)) throw new Error("invalid marker");
  return `SELECT supplier_id, updated_at FROM ${TABLE_PREFIX}${TABLES.spend} WHERE updated_at > '${marker}'`;
}

export const spendMaxUpdatedSql = () => `SELECT MAX(updated_at) AS m FROM ${TABLE_PREFIX}${TABLES.spend}`;

export const financialsSnapshotSql = () =>
  `SELECT cik, period_end, revenue, gross_margin, current_ratio, debt_to_equity FROM ${TABLE_PREFIX}${TABLES.financials}`;

export const selectAllSql = (table: string) => `SELECT * FROM ${TABLE_PREFIX}${table}`;
