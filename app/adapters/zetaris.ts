// Zetaris gateway: runs template SQL through the Zetaris REST API (SQL Editor endpoint) and keeps the
// decision ledger as an append-only Parquet table written with RUN EXPORT ... saveMode 'append'.
// Zetaris has no row-level INSERT/UPDATE; this append-and-read-back path is what was proven on Oct 22
// (docs/log/zetaris-gateway.md).
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DataGateway, Decision, Evidence, QueryResult, RowRef, TemplateSpec } from "../types.js";
import { ROW_KEY, TABLES, TEMPLATES, getTemplate, renderTemplate } from "../sql/templates.js";
import {
  SCHEMAS,
  TABLE_PREFIX,
  dropTableSql,
  exportSql,
  financialsSnapshotSql,
  ledgerCountSql,
  ledgerReadSql,
  registerTableSql,
  rowsSelect,
  selectAllSql,
  spendChangesSql,
  spendMaxUpdatedSql,
  tablePath,
} from "../sql/zetaris_tables.js";
import type { Tracer } from "../tracing.js";
import { IDENTITY, diffTables, mergeRows, readChangeFile, validateChange, type ChangeFile, type Row } from "../changes.js";

export type ZetarisErrorKind = "config" | "network" | "timeout" | "auth" | "http" | "sql";

/** Thrown by every gateway call so callers can fall back (e.g. to SAMPLE_MODE) on a known kind. */
export class ZetarisError extends Error {
  constructor(
    readonly kind: ZetarisErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ZetarisError";
  }
}

export interface ZetarisClientOptions {
  baseUrl: string;
  orgId?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface SqlResult {
  rows: Record<string, string | null>[];
  raw: unknown;
}

/** Thin REST client: one SQL statement per call, fresh UUID X-Request-ID, timeout on every request. */
export class ZetarisClient {
  private token: string;
  private orgId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ZetarisClientOptions) {
    this.token = opts.apiKey ?? "";
    this.orgId = opts.orgId ?? "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  static fromEnv(env = process.env, fetchImpl?: typeof fetch): ZetarisClient {
    return new ZetarisClient({
      baseUrl: (env.ZETARIS_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
      orgId: env.ZETARIS_ORG_ID,
      apiKey: env.ZETARIS_API_KEY,
      username: env.ZETARIS_USERNAME,
      password: env.ZETARIS_PASSWORD,
      timeoutMs: Number(env.ZETARIS_TIMEOUT_MS ?? 30000),
      fetchImpl,
    });
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new ZetarisError("timeout", `${path} timed out after ${this.opts.timeoutMs} ms`);
      }
      const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
      const why = cause ? ` (${cause.code ?? cause.message ?? "unknown cause"})` : "";
      throw new ZetarisError("network", `cannot reach ${this.opts.baseUrl}: ${err.message}${why}`);
    }
  }

  async login(): Promise<void> {
    if (this.token && this.orgId) return;
    if (!this.opts.username || !this.opts.password) {
      throw new ZetarisError("config", "set ZETARIS_API_KEY + ZETARIS_ORG_ID, or ZETARIS_USERNAME + ZETARIS_PASSWORD");
    }
    const res = await this.call("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": randomUUID() },
      body: JSON.stringify({ username: this.opts.username, password: this.opts.password }),
    });
    if (!res.ok) throw new ZetarisError("auth", `login failed: HTTP ${res.status}`, res.status);
    const body = (await res.json()) as { idToken?: string; orgId?: number | string };
    if (!body.idToken) throw new ZetarisError("auth", "login returned no idToken");
    this.token = body.idToken;
    if (!this.orgId && body.orgId !== undefined) this.orgId = String(body.orgId);
    if (!this.orgId) throw new ZetarisError("config", "no org id (set ZETARIS_ORG_ID)");
  }

  /**
   * Run exactly one statement. Values come back as strings (or null).
   * A read (SELECT/SHOW) is retried once on a network error, e.g. a stale keep-alive socket;
   * writes are never retried here, so an append cannot land twice.
   */
  async sql(statement: string, limit = 1000): Promise<SqlResult> {
    try {
      return await this.sqlOnce(statement, limit);
    } catch (e) {
      if (e instanceof ZetarisError && e.kind === "network" && /^\s*(SELECT|SHOW)\b/i.test(statement)) {
        return await this.sqlOnce(statement, limit);
      }
      throw e;
    }
  }

  private async sqlOnce(statement: string, limit: number): Promise<SqlResult> {
    await this.login();
    const res = await this.call("/api/proxy/sql-editor/sqls/run-query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        "X-Org-ID": this.orgId,
        "X-Request-ID": randomUUID(),
      },
      body: JSON.stringify({ sql: statement, limit }),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      // Drop a password-login token so the next call logs in again; an API key stays.
      if (this.opts.username) this.token = "";
      throw new ZetarisError("auth", `HTTP ${res.status}`, res.status);
    }
    if (!res.ok) {
      const kind = res.status === 400 ? "sql" : "http";
      throw new ZetarisError(kind, `HTTP ${res.status}: ${sqlErrorMessage(text)}`, res.status);
    }
    let raw: { headers?: string[]; data?: (string | null)[][] };
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ZetarisError("http", `non-JSON response: ${text.slice(0, 200)}`);
    }
    const headers = raw.headers ?? [];
    const rows = (raw.data ?? []).map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? null])));
    return { rows, raw };
  }
}

function sqlErrorMessage(text: string): string {
  try {
    const msg = (JSON.parse(text) as { msg?: string }).msg ?? text;
    return msg.replace(/^.*?Exception: /, "").slice(0, 400);
  } catch {
    return text.slice(0, 400);
  }
}

// ---------- hashing (shared with the sample gateway) ----------

import { canonicalHash } from "../hash.js";
export { canonicalHash };

// ---------- typing of returned rows ----------

const COLUMN_TYPES: Record<string, "STRING" | "DOUBLE"> = Object.fromEntries(
  Object.values(SCHEMAS).flatMap((cols) => cols),
);

/** Zetaris returns every value as a string; turn DOUBLE columns back into numbers. */
export function typeRow(row: Record<string, string | null>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, COLUMN_TYPES[k] === "DOUBLE" && v !== null ? Number(v) : v]),
  );
}

function dependsOn(table: string, rows: Record<string, unknown>[]): RowRef[] {
  const keyCol = ROW_KEY[table];
  const keys = new Set<string>();
  for (const r of rows) if (keyCol && r[keyCol] != null) keys.add(String(r[keyCol]));
  return [...keys].map((key) => ({ table, key }));
}

// ---------- the gateway ----------

export interface ZetarisGatewayOptions {
  client?: ZetarisClient;
  tracer?: Tracer;
  /** Clock for written_at / markers; injectable for tests. */
  now?: () => Date;
}

/** Rows per RUN EXPORT statement when rewriting a table (keeps each statement a sane size). */
const WRITE_CHUNK = 25;
/** Row cap when reading a whole table to rewrite it; hitting it means the read may be truncated, so the write stops. */
const READ_LIMIT = 100000;

export class ZetarisGateway implements DataGateway {
  readonly name = "zetaris" as const;
  readonly client: ZetarisClient;
  private readonly tracer?: Tracer;
  private readonly now: () => Date;
  /** Per-CIK hash of financial rows, for detecting new or edited filings (financials have no updated_at). */
  private finSnapshot: Map<string, string> | null = null;

  constructor(opts: ZetarisGatewayOptions = {}) {
    this.client = opts.client ?? ZetarisClient.fromEnv();
    this.tracer = opts.tracer;
    this.now = opts.now ?? (() => new Date());
  }

  private async run(action: string, sql: string, limit?: number): Promise<SqlResult> {
    const t0 = Date.now();
    try {
      const res = await this.client.sql(sql, limit);
      this.tracer?.emit({
        agent_name: "ZetarisGateway",
        action,
        event: "sponsor_call",
        sponsor: "zetaris",
        status: "success",
        input_summary: sql.length > 300 ? `${sql.slice(0, 300)}…` : sql,
        output_summary: `${res.rows.length} rows in ${Date.now() - t0} ms`,
      });
      return res;
    } catch (e) {
      const err = e instanceof ZetarisError ? e : new ZetarisError("http", (e as Error).message);
      this.tracer?.emit({
        agent_name: "ZetarisGateway",
        action,
        event: "sponsor_call",
        sponsor: "zetaris",
        status: "failed",
        input_summary: sql.length > 300 ? `${sql.slice(0, 300)}…` : sql,
        output_summary: `${err.kind}: ${err.message}`,
      });
      throw err;
    }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.run("health", "SELECT 1 AS one");
      const ok = res.rows[0]?.one === "1";
      return { ok, detail: ok ? "zetaris: SELECT 1 ok" : "zetaris: unexpected SELECT 1 result" };
    } catch (e) {
      const err = e as ZetarisError;
      return { ok: false, detail: `zetaris ${err.kind}: ${err.message}` };
    }
  }

  listTemplates(): TemplateSpec[] {
    return TEMPLATES;
  }

  async runTemplate(templateId: string, params: Record<string, string | number>): Promise<QueryResult> {
    const spec = getTemplate(templateId);
    const sql = renderTemplate(templateId, params, TABLE_PREFIX);
    const res = await this.run(`template:${templateId}`, sql);
    const rows = res.rows.map(typeRow);
    const evidence: Evidence = {
      template_id: templateId,
      params,
      sql,
      table: spec.table,
      result_hash: canonicalHash(rows),
      depends_on: dependsOn(spec.table, rows),
    };
    const period = rows[0]?.period_end;
    if (typeof period === "string") evidence.period = period;
    return { rows, evidence, sample: false };
  }

  async writeDecision(d: Decision): Promise<{ written: boolean; method: string; detail: string }> {
    const method = "zetaris:run_export_append_parquet";
    const writtenAt = this.now().toISOString();
    const row = {
      decision_id: d.decision_id,
      supplier_id: d.subject_id,
      decision: d.decision,
      confidence: d.confidence,
      status: d.status,
      tripwires: JSON.stringify(d.tripwires),
      evidence: JSON.stringify(d.evidence),
      supersedes: d.supersedes ?? "",
      created_at: d.created_at,
      approved_by_reason: d.approved_by_reason ?? "",
      payload: JSON.stringify(d),
      written_at: writtenAt,
    };
    const path = tablePath(TABLES.decisions);
    try {
      const exp = await this.run("write_decision", exportSql(TABLES.decisions, rowsSelect(TABLES.decisions, [row]), "append"));
      const status = exp.rows[0]?.status;
      if (status !== "SUCCESS") {
        return { written: false, method, detail: `export returned status ${String(status)} for ${path}` };
      }
      // Only claim the write once the row reads back through Zetaris SQL.
      const check = await this.run("verify_decision", ledgerCountSql(d.decision_id, writtenAt));
      const n = Number(check.rows[0]?.n ?? 0);
      return n >= 1
        ? { written: true, method, detail: `appended to ${path}; read back ${n} row via ${TABLE_PREFIX}${TABLES.decisions}` }
        : { written: false, method, detail: `export reported SUCCESS but read-back found 0 rows in ${TABLE_PREFIX}${TABLES.decisions}` };
    } catch (e) {
      const err = e as ZetarisError;
      return { written: false, method, detail: `${err.kind}: ${err.message}` };
    }
  }

  /** Append-only ledger: the latest written row per decision_id wins. */
  async readDecisions(): Promise<Decision[]> {
    const res = await this.run("read_decisions", ledgerReadSql());
    const latest = new Map<string, Record<string, string | null>>();
    for (const r of res.rows) {
      const id = r.decision_id ?? "";
      const prev = latest.get(id);
      if (!prev || String(r.written_at ?? "") >= String(prev.written_at ?? "")) latest.set(id, r);
    }
    return [...latest.values()]
      .map(rowToDecision)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /**
   * Apply a demo change file (a name in data/sample/changes/ or a path) to the Zetaris tables. See applyChangeRows.
   */
  async applyChange(file: string, changesDir = "data/sample/changes"): Promise<RowRef[]> {
    const path = existsSync(file) ? file : join(changesDir, file);
    return this.applyChangeRows(readChangeFile(path));
  }

  /**
   * Apply row changes the same way scripts/zetaris_setup.ts does. Each table is read once; if any change replaces an
   * existing row (same identity), the table is rewritten with RUN EXPORT and re-registered; if every change is a new
   * row, the new rows are appended. Returns the changed rows for the Watcher.
   */
  async applyChangeRows(input: ChangeFile[]): Promise<RowRef[]> {
    const refs: RowRef[] = [];
    const seen = new Set<string>();
    let changes: ChangeFile[];
    try { changes = input.map(validateChange); } catch (e) { throw new ZetarisError("config", (e as Error).message); }
    for (const c of changes) {
      if (!SCHEMAS[c.table]) throw new ZetarisError("config", `change targets unsupported table ${c.table}`);
    }
    for (const table of [...new Set(changes.map((c) => c.table))]) {
      const current = await this.readTable(table);
      const merged = mergeRows(table, current, changes);
      if (merged.replaced) await this.writeTable(table, merged.rows, "apply_change");
      else {
        for (let i = 0; i < merged.added.length; i += WRITE_CHUNK) {
          await this.run(`apply_change:${table}`, exportSql(table, rowsSelect(table, merged.added.slice(i, i + WRITE_CHUNK)), "append"));
        }
      }
    }
    for (const c of changes) {
      const id = `${c.table}\u0000${c.key}`;
      if (!seen.has(id)) seen.add(id), refs.push({ table: c.table, key: String(c.key) });
    }
    return refs;
  }

  /**
   * Put the supplier tables back to `base` (the bundled CSVs). Only a table that differs is rewritten.
   * Returns the rows that changed, for the Watcher.
   */
  async restoreTables(base: Record<string, Row[]>): Promise<RowRef[]> {
    const refs: RowRef[] = [];
    for (const table of Object.keys(IDENTITY)) {
      const rows = base[table];
      if (!rows) continue;
      const diff = diffTables(table, await this.readTable(table), rows);
      if (diff.length === 0) continue;
      await this.writeTable(table, rows, "restore");
      refs.push(...diff);
    }
    return refs;
  }

  /** Every row of a supplier table, typed. Refuses a read that may have been cut off at the row cap. */
  private async readTable(table: string): Promise<Row[]> {
    const res = await this.run(`read_table:${table}`, selectAllSql(table), READ_LIMIT);
    if (res.rows.length >= READ_LIMIT) throw new ZetarisError("sql", `${table} has ${READ_LIMIT}+ rows; refusing to rewrite a possibly truncated read`);
    return res.rows.map(typeRow);
  }

  /** Overwrite a table's files with `rows` (chunked), then re-register it so the new files are read. */
  private async writeTable(table: string, rows: Row[], action: string): Promise<void> {
    if (rows.length === 0) await this.run(`${action}:${table}`, exportSql(table, rowsSelect(table, []), "overwrite"));
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      await this.run(`${action}:${table}`, exportSql(table, rowsSelect(table, rows.slice(i, i + WRITE_CHUNK)), i === 0 ? "overwrite" : "append"));
    }
    await this.run(`${action}:${table}`, dropTableSql(table)).catch(() => undefined);
    await this.run(`${action}:${table}`, registerTableSql(table));
  }

  /**
   * Rows changed since a marker. The marker is the newest supplier_spend.updated_at seen.
   * An empty marker initialises: no changes, current marker returned.
   * supplier_financials has no updated_at, so new/edited filings are found by comparing a per-CIK
   * hash with the previous call on this gateway instance.
   */
  async changesSince(marker: string): Promise<{ changes: RowRef[]; marker: string }> {
    const changes: RowRef[] = [];
    let next = marker;
    if (marker) {
      const res = await this.run("changes_since:spend", spendChangesSql(marker));
      for (const r of res.rows) {
        changes.push({ table: TABLES.spend, key: String(r.supplier_id) });
        if (r.updated_at && r.updated_at > next) next = r.updated_at;
      }
    } else {
      const res = await this.run("changes_since:init", spendMaxUpdatedSql());
      next = res.rows[0]?.m ?? "";
    }

    const fin = await this.run("changes_since:financials", financialsSnapshotSql());
    const byCik = new Map<string, Record<string, unknown>[]>();
    for (const r of fin.rows.map(typeRow)) {
      const cik = String(r.cik);
      byCik.set(cik, [...(byCik.get(cik) ?? []), r]);
    }
    const snap = new Map([...byCik].map(([cik, rows]) => [cik, canonicalHash(rows)]));
    if (this.finSnapshot) {
      for (const [cik, h] of snap) if (this.finSnapshot.get(cik) !== h) changes.push({ table: TABLES.financials, key: cik });
    }
    this.finSnapshot = snap;
    return { changes, marker: next };
  }
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function rowToDecision(r: Record<string, string | null>): Decision {
  const payload = parseJson<Decision | null>(r.payload, null);
  const base: Decision = payload ?? {
    decision_id: r.decision_id ?? "",
    subject_id: r.supplier_id ?? "",
    decision: (r.decision ?? "keep") as Decision["decision"],
    confidence: Number(r.confidence ?? 0),
    status: (r.status ?? "proposed") as Decision["status"],
    findings: [],
    evidence: parseJson(r.evidence, []),
    tripwires: parseJson(r.tripwires, []),
    limitations: ["read from ledger columns; full payload missing"],
    escalated: false,
    created_at: r.created_at ?? "",
  };
  // Ledger columns win over the payload for fields a later append may have changed.
  return {
    ...base,
    status: (r.status ?? base.status) as Decision["status"],
    supersedes: r.supersedes || base.supersedes,
    approved_by_reason: r.approved_by_reason || base.approved_by_reason,
  };
}
