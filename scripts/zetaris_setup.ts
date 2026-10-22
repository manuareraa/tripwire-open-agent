// Set up Tripwire's tables in a local Zetaris, using only Zetaris SQL over REST.
//   tsx scripts/zetaris_setup.ts init [--data data/sample] [--reset-ledger]
//   tsx scripts/zetaris_setup.ts apply <change.json>     (a data/sample/changes/*.json file)
//   tsx scripts/zetaris_setup.ts status
// Source rows are written with RUN EXPORT TO STORAGE (Parquet) and registered as filestore tables in
// database `tripwire`. Credentials come from the environment only; nothing secret is printed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ZetarisClient, ZetarisError } from "../app/adapters/zetaris.js";
import { TABLES } from "../app/sql/templates.js";
import {
  SCHEMAS,
  createDatabaseSql,
  dropTableSql,
  exportSql,
  registerTableSql,
  rowsSelect,
  selectAllSql,
  showDatabasesSql,
  ZETARIS_DB,
} from "../app/sql/zetaris_tables.js";

const GAP_MS = Number(process.env.ZETARIS_SETUP_GAP_MS ?? 1500);
const CHUNK = 25;
const client = ZetarisClient.fromEnv();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function sql(statement: string) {
  await sleep(GAP_MS);
  const res = await client.sql(statement);
  console.log(`ok  ${statement.length > 140 ? statement.slice(0, 140) + "…" : statement}  -> ${res.rows.length} rows`);
  return res;
}

/** Minimal CSV parser (RFC 4180 quotes, no embedded newlines needed for our data). */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const split = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") out.push(cur), (cur = "");
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const [head, ...rest] = lines;
  const cols = split(head!);
  return rest.map((l) => {
    const cells = split(l);
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

// Throwaway rows used only when no data directory exists yet (clearly synthetic).
const FALLBACK: Record<string, Record<string, string>[]> = {
  [TABLES.financials]: [
    { cik: "1000001", ticker: "TST", name: "SYNTHETIC TEST CO", sic: "3674", period_end: "2026-06-30", revenue: "1000000", gross_margin: "0.4", current_ratio: "1.5", debt_to_equity: "0.8", source_url: "synthetic" },
  ],
  [TABLES.spend]: [
    { supplier_id: "SUP-01", cik: "1000001", category: "semiconductors", spend_share: "0.4", lead_time_weeks: "8", open_po_value: "100000", contract_end: "2027-06-30", updated_at: "2026-10-01T09:00:00Z" },
  ],
};

function loadRows(dataDir: string, table: string): Record<string, unknown>[] {
  const file = join(dataDir, `${table}.csv`);
  if (existsSync(file)) return parseCsv(readFileSync(file, "utf8"));
  console.log(`(no ${file}; using ${FALLBACK[table]!.length} synthetic throwaway rows)`);
  return FALLBACK[table]!;
}

async function ignoreSql(statement: string, okIf: RegExp) {
  try {
    await sql(statement);
  } catch (e) {
    if (e instanceof ZetarisError && okIf.test(e.message)) console.log(`skip ${statement.slice(0, 80)} (${e.message.slice(0, 120)})`);
    else throw e;
  }
}

/** Overwrite a table's files with `rows` (chunked), then re-register it so its schema is current. */
async function writeTable(table: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) {
    await sql(exportSql(table, rowsSelect(table, []), "overwrite"));
  }
  for (let i = 0; i < rows.length; i += CHUNK) {
    await sql(exportSql(table, rowsSelect(table, rows.slice(i, i + CHUNK)), i === 0 ? "overwrite" : "append"));
  }
  await ignoreSql(dropTableSql(table), /not (exist|found)|does(n't| not) exist|no such|unknown/i);
  await sql(registerTableSql(table));
}

async function readTable(table: string): Promise<Record<string, unknown>[]> {
  return (await client.sql(selectAllSql(table), 100000)).rows;
}

async function init(dataDir: string, resetLedger: boolean) {
  const dbs = await sql(showDatabasesSql());
  if (!dbs.rows.some((r) => r.name?.toLowerCase() === ZETARIS_DB)) await sql(createDatabaseSql());
  for (const table of [TABLES.financials, TABLES.spend]) await writeTable(table, loadRows(dataDir, table));

  let ledgerOk = false;
  try {
    await sql(`SELECT COUNT(*) AS n FROM ${ZETARIS_DB}.${TABLES.decisions}`);
    ledgerOk = true;
  } catch {
    ledgerOk = false;
  }
  if (resetLedger || !ledgerOk) {
    // A typed empty result writes a schema-only Parquet file, so the table can be registered before any decision exists.
    await writeTable(TABLES.decisions, []);
  }
  await status();
}

const IDENTITY: Record<string, string[]> = {
  [TABLES.spend]: ["supplier_id"],
  [TABLES.financials]: ["cik", "period_end"],
};

/** Apply a change file: a new row is appended; a row with the same identity replaces the old one (table rewritten). */
async function apply(file: string) {
  const change = JSON.parse(readFileSync(file, "utf8")) as { table: string; key: string; row: Record<string, unknown> };
  const ids = IDENTITY[change.table];
  if (!ids || !SCHEMAS[change.table]) throw new Error(`unsupported table ${change.table}`);
  const current = await readTable(change.table);
  const same = (r: Record<string, unknown>) => ids.every((c) => String(r[c]) === String(change.row[c]));
  if (current.some(same)) {
    await writeTable(change.table, current.map((r) => (same(r) ? change.row : r)));
    console.log(`replaced ${change.table} ${change.key}`);
  } else {
    await sql(exportSql(change.table, rowsSelect(change.table, [change.row]), "append"));
    console.log(`appended ${change.table} ${change.key}`);
  }
}

async function status() {
  for (const t of Object.values(TABLES)) {
    try {
      const r = await sql(`SELECT COUNT(*) AS n FROM ${ZETARIS_DB}.${t}`);
      console.log(`${ZETARIS_DB}.${t}: ${r.rows[0]?.n} rows`);
    } catch (e) {
      console.log(`${ZETARIS_DB}.${t}: unavailable (${(e as Error).message.slice(0, 120)})`);
    }
  }
}

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
try {
  if (cmd === "init") await init(flag("--data") ?? "data/sample", args.includes("--reset-ledger"));
  else if (cmd === "apply" && args[0]) await apply(args[0]);
  else if (cmd === "status") await status();
  else {
    console.error("usage: zetaris_setup.ts init [--data dir] [--reset-ledger] | apply <change.json> | status");
    process.exit(2);
  }
} catch (e) {
  const err = e as ZetarisError;
  console.error(`failed: ${err.kind ?? "error"}: ${err.message}`);
  process.exit(1);
}
