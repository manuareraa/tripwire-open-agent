// SAMPLE_MODE DataGateway: serves the SQL templates from bundled CSVs in data/sample/, no keys needed.
// Each template is evaluated in JS with the same filter/order/limit as its SQL. Results are flagged sample: true.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROW_KEY, TABLES, TEMPLATES, getTemplate, renderTemplate } from "../sql/templates.js";
import type { DataGateway, Decision, Evidence, QueryResult, RowRef, TemplateSpec } from "../types.js";
import { IDENTITY, NUMERIC, diffTables, normaliseRow, readChangeFile, validateChange, type ChangeFile, type Row } from "../changes.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export type { ChangeFile };

interface AppliedChange extends ChangeFile {
  seq: number;
  file: string;
  applied_at: string;
}

export interface SampleOptions {
  /** Folder with supplier_financials.csv, supplier_spend.csv and changes/. */
  sampleDir?: string;
  /** Folder for the append-only ledger and the applied-changes log (gitignored). */
  ledgerDir?: string;
}

export { canonicalRows, resultHash } from "../hash.js";
import { resultHash } from "../hash.js";

// ---------- CSV ----------

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), out.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell !== "" || row.length) row.push(cell), out.push(row);
  return out.filter((r) => r.length > 1 || r[0] !== "");
}

function loadTable(path: string, table: string): Row[] {
  const [header, ...lines] = parseCsv(readFileSync(path, "utf8"));
  const numeric = NUMERIC[table] ?? new Set<string>();
  return lines.map((cells) => {
    const r: Row = {};
    header.forEach((h, i) => {
      const s = cells[i] ?? "";
      r[h] = s === "" ? null : numeric.has(h) ? Number(s) : s;
    });
    return r;
  });
}

/** Source tables that a sample folder may leave out (older fixtures have only financials and spend). */
const OPTIONAL_TABLES: string[] = [TABLES.events, TABLES.sanctions, TABLES.status];

/** The bundled base tables (no changes applied), keyed by table name. */
export function loadBaseTables(sampleDir: string): Record<string, Row[]> {
  const out: Record<string, Row[]> = {
    [TABLES.financials]: loadTable(join(sampleDir, `${TABLES.financials}.csv`), TABLES.financials),
    [TABLES.spend]: loadTable(join(sampleDir, `${TABLES.spend}.csv`), TABLES.spend),
  };
  for (const t of OPTIONAL_TABLES) {
    const path = join(sampleDir, `${t}.csv`);
    out[t] = existsSync(path) ? loadTable(path, t) : [];
  }
  return out;
}

// ---------- helpers mirroring the SQL ----------

const project = (rows: Row[], cols: string[]) =>
  rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));

const byDesc = (col: string) => (a: Row, b: Row) => String(b[col] ?? "").localeCompare(String(a[col] ?? ""));
const byNumDesc = (col: string) => (a: Row, b: Row) => Number(b[col] ?? -Infinity) - Number(a[col] ?? -Infinity);

/** Selected columns of each template, parsed from its SQL so the JS projection never drifts from it. */
function selectColumns(t: TemplateSpec): string[] {
  const m = /^SELECT (.+?) FROM /.exec(t.sql);
  if (!m) throw new Error(`cannot parse columns of ${t.id}`);
  return m[1].split(",").map((s) => s.trim());
}

/** The ledger table row for a decision (tripwire_decisions columns; JSON fields stored as text). */
export function decisionToLedgerRow(d: Decision): Row {
  return {
    decision_id: d.decision_id,
    supplier_id: d.subject_id,
    decision: d.decision,
    confidence: d.confidence,
    status: d.status,
    tripwires: JSON.stringify(d.tripwires),
    evidence: JSON.stringify(d.evidence),
    supersedes: d.supersedes ?? null,
    created_at: d.created_at,
    approved_by_reason: d.approved_by_reason ?? null,
  };
}

export class SampleDataGateway implements DataGateway {
  readonly name = "sample" as const;
  readonly sampleDir: string;
  readonly ledgerDir: string;
  private tables: Record<string, Row[]> = {};

  constructor(opts: SampleOptions = {}) {
    this.sampleDir = opts.sampleDir ?? join(REPO_ROOT, "data/sample");
    this.ledgerDir = opts.ledgerDir ?? join(REPO_ROOT, "data/ledger");
    this.reload();
  }

  private get ledgerPath() {
    return join(this.ledgerDir, `${TABLES.decisions}.jsonl`);
  }
  private get changesLogPath() {
    return join(this.ledgerDir, "applied_changes.jsonl");
  }

  /** Base CSVs plus every change in the applied-changes log, replayed in order. */
  reload(): void {
    this.tables = loadBaseTables(this.sampleDir);
    for (const c of this.appliedChanges()) this.upsert(c);
  }

  /** The sample is a snapshot: ages are measured from the day it was fetched (SAMPLE_CLOCK overrides). */
  clock(): Date {
    const override = process.env.SAMPLE_CLOCK;
    if (override && !Number.isNaN(Date.parse(override))) return new Date(override);
    const fetched = this.tables[TABLES.status].map((r) => String(r.fetched_on ?? "")).filter(Boolean).sort().at(-1);
    return fetched ? new Date(`${fetched}T23:59:59Z`) : new Date();
  }

  async health() {
    const f = this.tables[TABLES.financials].length;
    const s = this.tables[TABLES.spend].length;
    const e = this.tables[TABLES.events].length;
    const x = this.tables[TABLES.sanctions].length;
    return { ok: f > 0 && s > 0, detail: `sample data: ${f} financial rows, ${s} spend rows, ${e} SEC 8-K events, ${x} sanctions screens (SAMPLE_MODE, no keys)` };
  }

  listTemplates(): TemplateSpec[] {
    return TEMPLATES;
  }

  async runTemplate(templateId: string, params: Record<string, string | number>): Promise<QueryResult> {
    const sql = renderTemplate(templateId, params); // validates params exactly as the live gateway does
    const t = getTemplate(templateId);
    const cols = selectColumns(t);
    const p = (k: string) => String(params[k]);
    let rows: Row[];
    switch (templateId) {
      case "supplier_spend_row":
        rows = this.tables[TABLES.spend].filter((r) => r.supplier_id === p("supplier_id"));
        break;
      case "supplier_financials_latest":
        rows = this.financials(p("cik")).slice(0, 1);
        break;
      case "supplier_financials_history":
        rows = this.financials(p("cik")).slice(0, Number(params.periods));
        break;
      case "category_concentration":
        rows = this.tables[TABLES.spend]
          .filter((r) => r.category === p("category"))
          .sort(byNumDesc("spend_share"));
        break;
      case "supplier_events_recent":
        rows = this.tables[TABLES.events].filter((r) => r.cik === p("cik")).sort(byDesc("filed_date")).slice(0, 25);
        break;
      case "sanctions_screen_row":
        rows = this.tables[TABLES.sanctions].filter((r) => r.cik === p("cik"));
        break;
      case "source_status":
        rows = [...this.tables[TABLES.status]].sort((a, b) => String(a.source).localeCompare(String(b.source)));
        break;
      case "decisions_for_supplier":
        rows = this.ledgerRows()
          .filter((r) => r.supplier_id === p("supplier_id"))
          .sort(byDesc("created_at"));
        break;
      default:
        throw new Error(`sample gateway has no evaluator for template ${templateId}`);
    }
    // Keep the key column for lineage even if a template ever stops selecting it.
    const keyCol = ROW_KEY[t.table];
    const out = project(rows, cols);
    const keys = rows.map((r) => String(r[keyCol]));
    if (keys.length === 0 && params[keyCol] !== undefined) keys.push(String(params[keyCol]));
    const depends_on: RowRef[] = [...new Set(keys)].map((key) => ({ table: t.table, key }));
    const evidence: Evidence = {
      template_id: templateId,
      params: { ...params },
      sql,
      table: t.table,
      result_hash: resultHash(out),
      depends_on,
    };
    if (t.table === TABLES.financials && out[0]?.period_end) evidence.period = String(out[0].period_end);
    return { rows: out, evidence, sample: true };
  }

  private financials(cik: string): Row[] {
    return this.tables[TABLES.financials].filter((r) => r.cik === cik).sort(byDesc("period_end"));
  }

  // ---------- ledger (append-only JSONL) ----------

  private ledgerRows(): Row[] {
    if (!existsSync(this.ledgerPath)) return [];
    return readFileSync(this.ledgerPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => decisionToLedgerRow(JSON.parse(l) as Decision));
  }

  async writeDecision(d: Decision) {
    mkdirSync(this.ledgerDir, { recursive: true });
    appendFileSync(this.ledgerPath, JSON.stringify(d) + "\n");
    return {
      written: true,
      method: "sample-jsonl-append",
      detail: `appended ${d.decision_id} (${d.status}) to ${this.ledgerPath}; SAMPLE_MODE, not Zetaris`,
    };
  }

  /** Latest ledger entry per decision_id (later lines are status updates), in first-written order. */
  async readDecisions(): Promise<Decision[]> {
    if (!existsSync(this.ledgerPath)) return [];
    const latest = new Map<string, Decision>();
    for (const line of readFileSync(this.ledgerPath, "utf8").split("\n")) {
      if (!line) continue;
      const d = JSON.parse(line) as Decision;
      latest.set(d.decision_id, d);
    }
    return [...latest.values()];
  }

  // ---------- scripted changes (demo of selective reopen) ----------

  private appliedChanges(): AppliedChange[] {
    if (!existsSync(this.changesLogPath)) return [];
    return readFileSync(this.changesLogPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AppliedChange);
  }

  /** Supplier directory for the UI: id, company name, ticker, category, SEC company number and lead time from the bundled tables. */
  suppliers(): { supplier_id: string; name: string; ticker: string; category: string; spend_share: number; cik: string; lead_time_weeks: number }[] {
    const fin = new Map(this.tables[TABLES.financials].map((r) => [String(r.cik), r]));
    return this.tables[TABLES.spend].map((r) => {
      const f = fin.get(String(r.cik));
      return {
        supplier_id: String(r.supplier_id), name: String(f?.name ?? r.supplier_id), ticker: String(f?.ticker ?? ""),
        category: String(r.category), spend_share: Number(r.spend_share),
        cik: String(r.cik), lead_time_weeks: Number(r.lead_time_weeks),
      };
    });
  }

  /** A copy of the current tables (base CSVs plus applied changes). */
  snapshot(): Record<string, Row[]> {
    return Object.fromEntries(Object.entries(this.tables).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
  }

  /** Every bundled change file, parsed and validated. */
  changeFiles(): { file: string; changes: ChangeFile[] }[] {
    return this.listChangeFiles().map((file) => ({ file, changes: readChangeFile(join(this.sampleDir, "changes", file)) }));
  }

  /** Change files bundled for the demo, e.g. ["01_new_quarter.json", ...]. */
  listChangeFiles(): string[] {
    const dir = join(this.sampleDir, "changes");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  }

  /**
   * Apply a change file (a name in data/sample/changes/ or a path). The file holds one change or an array.
   * Recorded in the applied-changes log so it survives restarts and shows up in changesSince().
   */
  async applyChange(file: string): Promise<RowRef[]> {
    const path = existsSync(file) ? file : join(this.sampleDir, "changes", file);
    return this.applyChangeRows(readChangeFile(path), basename(path));
  }

  /** Apply changes built in code (what-ifs) or read from a file; `source` names them in the applied-changes log. */
  async applyChangeRows(changes: ChangeFile[], source: string): Promise<RowRef[]> {
    const list = changes.map(validateChange);
    let seq = this.appliedChanges().reduce((m, c) => Math.max(m, c.seq), 0);
    mkdirSync(this.ledgerDir, { recursive: true });
    const refs: RowRef[] = [];
    const seen = new Set<string>();
    for (const c of list) {
      const applied: AppliedChange = { ...c, seq: ++seq, file: source, applied_at: new Date().toISOString() };
      this.upsert(applied);
      appendFileSync(this.changesLogPath, JSON.stringify(applied) + "\n");
      const id = `${c.table}\u0000${c.key}`;
      if (!seen.has(id)) seen.add(id), refs.push({ table: c.table, key: String(c.key) });
    }
    return refs;
  }

  /** Forget applied changes (back to the bundled CSVs). Demo/test helper; the decision ledger is kept. */
  resetChanges(): void {
    if (existsSync(this.changesLogPath)) writeFileSync(this.changesLogPath, "");
    this.reload();
  }

  /** Back to the bundled CSVs, returning the rows that differ from what was live (for the Watcher). */
  async restoreBase(): Promise<RowRef[]> {
    const before = this.snapshot();
    this.resetChanges();
    return Object.keys(IDENTITY).flatMap((t) => diffTables(t, before[t] ?? [], this.tables[t] ?? []));
  }

  /** Marker = sequence number of the last applied change ("0" = none). */
  async changesSince(marker: string): Promise<{ changes: RowRef[]; marker: string }> {
    const after = Number(marker) || 0;
    const newer = this.appliedChanges().filter((c) => c.seq > after);
    const seen = new Set<string>();
    const changes: RowRef[] = [];
    for (const c of newer) {
      const id = `${c.table}\u0000${c.key}`;
      if (!seen.has(id)) seen.add(id), changes.push({ table: c.table, key: String(c.key) });
    }
    const last = newer.length ? newer[newer.length - 1].seq : after;
    return { changes, marker: String(last) };
  }

  /** Spend rows are keyed by supplier_id; financial rows by (cik, period_end) since a CIK has many periods. */
  private upsert(c: ChangeFile): void {
    const row = normaliseRow(c.table, c.row);
    const ids = IDENTITY[c.table];
    const rows = this.tables[c.table];
    const i = rows.findIndex((r) => ids.every((k) => r[k] === row[k]));
    if (i >= 0) rows[i] = { ...rows[i], ...row };
    else rows.push(row);
  }
}
