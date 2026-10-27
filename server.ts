import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { config } from "./app/config.js";
import { Tracer } from "./app/tracing.js";
import { buildRuntime, memoryPaths, openMemory } from "./app/runtime.js";
import { runDecide } from "./app/orchestration/graph.js";
import { reopenFor } from "./app/watcher.js";
import type { Deps } from "./app/orchestration/state.js";
import type { DataGateway, Decision, RowRef, RunRequest, TraceEvent } from "./app/types.js";
import { changeCatalog, type ChangeFile } from "./app/changes.js";
import { loadBaseTables } from "./app/adapters/sample_data.js";
import { WHATIF_KINDS, buildWhatIfs, type WhatIfKind } from "./app/whatif.js";

const rt = await buildRuntime();
const app = new Hono();

// Keep the last few traces in memory for the UI; full traces are in logs/trace-<run_id>.jsonl.
const traces = new Map<string, TraceEvent[]>();
function remember(t: Tracer) {
  traces.set(t.run_id, [...t.all()]);
  while (traces.size > 50) traces.delete(traces.keys().next().value!);
}
/** A tracer whose events are readable at GET /trace/:id while the run is still going, so the UI can show live progress.
 *  The client may pick the run id (short, alphanumeric) so it can poll before the response arrives. */
function liveTracer(wanted?: unknown) {
  const id = typeof wanted === "string" && /^[a-z0-9]{6,24}$/i.test(wanted) && !traces.has(wanted) ? wanted : undefined;
  const t = new Tracer(id);
  traces.set(t.run_id, t.all() as TraceEvent[]);
  return t;
}
const depsFor = (tracer: Tracer): Deps => ({ gateway: rt.gateway, model: rt.model, memory: rt.memory, reranker: rt.reranker, tracer });

/** The bundled CSVs with no changes applied: the "before" of the demo changes and what a reset restores. */
const BASE = loadBaseTables(rt.sample.sampleDir);
const SIC = new Map(BASE.supplier_financials.map((r) => [String(r.cik), String(r.sic ?? "")]));

type LiveChanges = DataGateway & {
  applyChange?: (f: string) => Promise<RowRef[]>;
  applyChangeRows?: (c: ChangeFile[]) => Promise<RowRef[]>;
  restoreTables?: (base: typeof BASE) => Promise<RowRef[]>;
};

/** Apply a bundled change file to whichever data layer is live (sample files or Zetaris tables). */
async function applyChangeFile(file: string) {
  if (rt.gateway === rt.sample) return rt.sample.applyChange(file);
  const live = rt.gateway as LiveChanges;
  if (!live.applyChange) throw new Error(`data layer ${rt.gateway.name} cannot apply change files`);
  return live.applyChange(file);
}

/** Apply changes built in code (what-ifs) to the live data layer. */
async function applyChangeRows(changes: ChangeFile[], source: string) {
  if (rt.gateway === rt.sample) return rt.sample.applyChangeRows(changes, source);
  const live = rt.gateway as LiveChanges;
  if (!live.applyChangeRows) throw new Error(`data layer ${rt.gateway.name} cannot apply changes`);
  return live.applyChangeRows(changes);
}

/** Put the supplier tables back to the bundled CSVs; returns the rows that changed. */
async function restoreBase() {
  if (rt.gateway === rt.sample) return rt.sample.restoreBase();
  const live = rt.gateway as LiveChanges;
  if (!live.restoreTables) throw new Error(`data layer ${rt.gateway.name} cannot restore tables`);
  return live.restoreTables(BASE);
}

/** One data change at a time: a second one while a run is rewriting tables would race it. */
let changing = false;
async function exclusive<T>(fn: () => Promise<T>): Promise<T | null> {
  if (changing) return null;
  changing = true;
  try {
    return await fn();
  } finally {
    changing = false;
  }
}
const BUSY = { error: "busy", detail: "Another data change is still running. Try again when it finishes." };

/** Trace the data write itself, so the run shows what changed before the Watcher starts. */
function traceWrite(tracer: Tracer, action: string, rows: RowRef[], what: string) {
  tracer.emit({
    agent_name: "Server", action, event: "tool_call", status: "success", data: { rows },
    ...(rt.gateway.name === "zetaris" ? { sponsor: "zetaris" } : {}),
    output_summary: `${what} in the ${rt.gateway.name} data: ${rows.length ? rows.map((r) => `${r.table} ${r.key}`).join(", ") : "no rows differed"}`,
  });
}

async function reopenAll(tracer: Tracer, rows: RowRef[]) {
  const deps = depsFor(tracer);
  const reports = [];
  for (const r of rows) reports.push(await withTimeout(reopenFor(deps, rt.store, r), config.limits.runTimeoutMs));
  return reports;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`run exceeded ${ms} ms`)), ms))]);
}

function toResponse(run_id: string, d: Decision, extra: Record<string, unknown> = {}) {
  return {
    run_id, decision_id: d.decision_id, decision: d.decision, confidence: d.confidence, status: d.status,
    evidence: d.evidence, tripwires: d.tripwires, escalated: d.escalated, escalation_reasons: d.escalation_reasons,
    limitations: d.limitations, rationale: d.rationale, risk: d.risk, findings: d.findings, supersedes: d.supersedes, proving: d.proving, ...extra,
  };
}

app.get("/health", async (c) => {
  const data = await rt.gateway.health().catch((e: Error) => ({ ok: false, detail: e.message }));
  return c.json({ ok: true, sample_mode: config.sampleMode, modes: rt.modes, data });
});

app.post("/run", async (c) => {
  let body: RunRequest;
  try {
    body = await c.req.json<RunRequest>();
  } catch {
    return c.json({ error: "invalid_json", detail: "Body must be JSON: {mode, subject_id, ...}" }, 400);
  }
  if (!["decide", "reopen"].includes(body?.mode) || !/^SUP-\d{2,3}$/.test(body?.subject_id ?? "")) {
    return c.json({ error: "invalid_input", detail: 'mode must be "decide" or "reopen"; subject_id like "SUP-01"' }, 400);
  }
  const tracer = liveTracer(body.run_id);
  const deps = depsFor(tracer);
  try {
    if (body.mode === "decide") {
      const prior = rt.store.active().find((d) => d.subject_id === body.subject_id);
      const question = body.question ?? "Keep, dual-source or exit this supplier?";
      const { decision } = await withTimeout(runDecide(deps, body.subject_id, question, prior), config.limits.runTimeoutMs);
      if (prior) rt.store.put({ ...prior, status: "superseded" });
      rt.store.put(decision);
      remember(tracer);
      return c.json(toResponse(tracer.run_id, decision, { trace_file: tracer.file }));
    }
    if (body.change_file && !rt.sample.listChangeFiles().includes(body.change_file)) {
      return c.json({ error: "not_found", detail: `no change file ${body.change_file}` }, 404);
    }
    // A reopen needs a decision to reopen: on a fresh server, make the baseline decision first (it is traced).
    let baseline: Decision | undefined;
    if (!rt.store.active().some((d) => d.subject_id === body.subject_id)) {
      baseline = (await withTimeout(runDecide(deps, body.subject_id, body.question ?? "Baseline decision before the change"), config.limits.runTimeoutMs)).decision;
      rt.store.put(baseline);
    }
    let changedRows = body.changed ? [body.changed] : [{ table: "supplier_spend", key: body.subject_id }];
    if (body.change_file) {
      const rows = await exclusive(() => applyChangeFile(body.change_file!));
      if (!rows) return c.json(BUSY, 409);
      traceWrite(tracer, "write_change", rows, `applied ${body.change_file}`);
      if (!body.changed) changedRows = rows;
    }
    const reports = [];
    for (const changed of changedRows) reports.push(await withTimeout(reopenFor(deps, rt.store, changed), config.limits.runTimeoutMs));
    remember(tracer);
    const baselineOut = baseline ? { decision_id: baseline.decision_id, decision: baseline.decision, confidence: baseline.confidence } : undefined;
    return c.json({ run_id: tracer.run_id, trace_file: tracer.file, baseline: baselineOut, ...reports[0], reports: reports.length > 1 ? reports : undefined });
  } catch (e) {
    tracer.emit({ agent_name: "Server", action: "run_failed", event: "error", status: "failed", output_summary: (e as Error).message });
    remember(tracer);
    return c.json({ error: "run_failed", detail: (e as Error).message, run_id: tracer.run_id }, 500);
  }
});

app.get("/decisions", (c) => c.json(rt.store.list()));
app.get("/decisions/:id", (c) => {
  const d = rt.store.get(c.req.param("id"));
  return d ? c.json(d) : c.json({ error: "not_found" }, 404);
});

// Human approval: the only path that writes a decision back to the data layer.
app.post("/decisions/:id/approve", async (c) => {
  const d = rt.store.get(c.req.param("id"));
  if (!d) return c.json({ error: "not_found" }, 404);
  if (d.status !== "proposed") return c.json({ error: "not_proposed", detail: `status is ${d.status}` }, 409);
  const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
  const reason = body.reason?.trim();
  if (d.escalated && !reason) return c.json({ error: "reason_required", detail: "Escalated decisions need an approval reason" }, 400);
  const approved: Decision = { ...d, status: "approved", approved_by_reason: reason || undefined };
  const write = await rt.gateway.writeDecision(approved).catch((e: Error) => ({ written: false, method: "none", detail: e.message }));
  rt.store.put(approved);
  const tracer = new Tracer();
  tracer.emit({
    decision_id: d.decision_id, agent_name: "Human", action: "approve", event: "decision", status: write.written ? "success" : "partial",
    sponsor: rt.gateway.name, output_summary: write.written ? `written via ${write.method}` : `approved but NOT written: ${write.detail}`,
  });
  remember(tracer);
  return c.json({ decision: approved, write, run_id: tracer.run_id });
});

app.post("/decisions/:id/reject", (c) => {
  const d = rt.store.get(c.req.param("id"));
  if (!d) return c.json({ error: "not_found" }, 404);
  rt.store.put({ ...d, status: "rejected" });
  return c.json({ ok: true });
});

// Demo change feed: apply a change to the live data layer, then the Watcher decides what to reopen.
app.get("/changes", (c) => c.json(rt.sample.listChangeFiles()));
app.get("/changes/catalog", async (c) => {
  try {
    return c.json(await changeCatalog(rt.gateway, rt.sample.changeFiles(), BASE));
  } catch (e) {
    return c.json({ error: "catalog_failed", detail: (e as Error).message }, 500);
  }
});

// The supplier directory (names from the bundled data), with spend share and lead time read live per category.
app.get("/suppliers", async (c) => {
  const dir = rt.sample.suppliers();
  const live = new Map<string, Record<string, unknown>>();
  for (const category of new Set(dir.map((s) => s.category))) {
    try {
      for (const r of (await rt.gateway.runTemplate("category_concentration", { category })).rows) live.set(String(r.supplier_id), r);
    } catch {
      // keep the bundled values for this category
    }
  }
  return c.json(dir.map((s) => {
    const r = live.get(s.supplier_id);
    const num = (v: unknown, fallback: number) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? fallback : Number(v));
    return r ? { ...s, spend_share: num(r.spend_share, s.spend_share), lead_time_weeks: num(r.lead_time_weeks, s.lead_time_weeks) } : s;
  }));
});

app.post("/changes/:file/apply", async (c) => {
  const file = c.req.param("file");
  if (!rt.sample.listChangeFiles().includes(file)) return c.json({ error: "not_found" }, 404);
  const tracer = liveTracer(c.req.query("run_id"));
  try {
    const out = await exclusive(async () => {
      const rows = await applyChangeFile(file);
      traceWrite(tracer, "write_change", rows, `applied ${file}`);
      return { rows, reports: await reopenAll(tracer, rows) };
    });
    remember(tracer);
    if (!out) return c.json(BUSY, 409);
    return c.json({ run_id: tracer.run_id, file, ...out });
  } catch (e) {
    tracer.emit({ agent_name: "Server", action: "run_failed", event: "error", status: "failed", output_summary: (e as Error).message });
    remember(tracer);
    return c.json({ error: "run_failed", detail: (e as Error).message, run_id: tracer.run_id }, 500);
  }
});

// What-if changes for one supplier, computed from its current values (so each can be applied again and again).
const SUPPLIER_ID = /^SUP-\d{2,3}$/;
app.get("/changes/whatif", async (c) => {
  const supplier = c.req.query("supplier") ?? "";
  if (!SUPPLIER_ID.test(supplier)) return c.json({ error: "invalid_input", detail: 'supplier like "SUP-06"' }, 400);
  try {
    const list = await buildWhatIfs(rt.gateway, supplier, { sicByCik: SIC });
    return c.json(list.map(({ changes: _changes, ...w }) => w));
  } catch (e) {
    return c.json({ error: "whatif_failed", detail: (e as Error).message }, 500);
  }
});

app.post("/changes/whatif", async (c) => {
  const body = await c.req.json<{ supplier_id?: string; kind?: string; run_id?: string }>().catch(() => null);
  if (!body || !SUPPLIER_ID.test(body.supplier_id ?? "") || !WHATIF_KINDS.includes(body.kind as WhatIfKind)) {
    return c.json({ error: "invalid_input", detail: `{supplier_id: "SUP-06", kind: one of ${WHATIF_KINDS.join(", ")}}` }, 400);
  }
  const tracer = liveTracer(body.run_id);
  try {
    const out = await exclusive(async () => {
      // Rebuilt inside the lock from the data as it is now, never from what the page last saw.
      const w = (await buildWhatIfs(rt.gateway, body.supplier_id!, { sicByCik: SIC })).find((x) => x.kind === body.kind)!;
      if (!w.available) return { unavailable: w.reason ?? "not available" };
      const rows = await applyChangeRows(w.changes, w.id);
      traceWrite(tracer, "write_whatif", rows, w.title);
      return { kind: w.kind, title: w.title, fields: w.fields, rows, reports: await reopenAll(tracer, rows) };
    });
    remember(tracer);
    if (!out) return c.json(BUSY, 409);
    if ("unavailable" in out) return c.json({ error: "unavailable", detail: out.unavailable }, 409);
    return c.json({ run_id: tracer.run_id, ...out });
  } catch (e) {
    tracer.emit({ agent_name: "Server", action: "run_failed", event: "error", status: "failed", output_summary: (e as Error).message });
    remember(tracer);
    return c.json({ error: "run_failed", detail: (e as Error).message, run_id: tracer.run_id }, 500);
  }
});

// Put the supplier tables back to the bundled data; decisions that read a restored row are re-checked like any change.
app.post("/changes/reset", async (c) => {
  const body = await c.req.json<{ run_id?: string }>().catch(() => ({} as { run_id?: string }));
  const tracer = liveTracer(body.run_id);
  try {
    const out = await exclusive(async () => {
      const rows = await restoreBase();
      traceWrite(tracer, "restore_data", rows, "restored the bundled data");
      return { rows, reports: await reopenAll(tracer, rows) };
    });
    remember(tracer);
    if (!out) return c.json(BUSY, 409);
    return c.json({ run_id: tracer.run_id, ...out });
  } catch (e) {
    tracer.emit({ agent_name: "Server", action: "run_failed", event: "error", status: "failed", output_summary: (e as Error).message });
    remember(tracer);
    return c.json({ error: "run_failed", detail: (e as Error).message, run_id: tracer.run_id }, 500);
  }
});

// Fresh start: forget every decision and everything remembered, and put the bundled sample data back. A decision made
// again on top of an earlier one asks the model a different question, so with no live model only a fresh start gets
// the recorded Nemotron answers again. Shared Zetaris tables are never rewritten here.
app.post("/demo/fresh-start", async (c) => {
  const ledgerDir = join(config.dataDir, "ledger");
  const paths = memoryPaths(ledgerDir);
  const outside = paths.find((p) => relative(resolve(ledgerDir), resolve(p)).startsWith(".."));
  if (outside) return c.json({ error: "memory_outside_ledger", detail: `Memory is kept at ${outside}, outside ${ledgerDir}, so it is left alone. Unset HMEM_DIR to use a fresh start.` }, 409);
  try {
    const out = await exclusive(async () => {
      const decisions = rt.store.list().length;
      const rows = rt.gateway === rt.sample ? await rt.sample.restoreBase() : [];
      rt.store.clear();
      for (const p of paths) rmSync(p, { recursive: true, force: true });
      rt.memory = await openMemory(ledgerDir);
      traces.clear();
      return { decisions_cleared: decisions, rows_restored: rows.length, data_restored: rt.gateway === rt.sample };
    });
    if (!out) return c.json(BUSY, 409);
    return c.json(out);
  } catch (e) {
    return c.json({ error: "fresh_start_failed", detail: (e as Error).message }, 500);
  }
});

// Proving Ground time-lapse: one supplier's backtest, quarter by quarter (written by scripts/backtest.ts).
app.get("/proving/timeline/:subject_id", (c) => {
  const file = "eval/backtest_timeline.json";
  if (!existsSync(file)) return c.json({ error: "not_found", detail: "No backtest timeline yet. Run scripts/backtest.ts." }, 404);
  const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const id = c.req.param("subject_id");
  const t = Object.hasOwn(all, id) ? all[id] : undefined;
  return t ? c.json(t) : c.json({ error: "not_found", detail: "No backtest timeline for this supplier." }, 404);
});

// The whole backtest scorecard (written by scripts/backtest.ts), for the overall score.
app.get("/proving/backtest", (c) => {
  const file = "eval/backtest_results.json";
  if (!existsSync(file)) return c.json({ error: "not_found", detail: "No backtest results yet. Run scripts/backtest.ts." }, 404);
  return c.json(JSON.parse(readFileSync(file, "utf8")));
});

app.get("/trace/:run_id", (c) => {
  const t = traces.get(c.req.param("run_id"));
  return t ? c.json(t) : c.json({ error: "not_found" }, 404);
});

// The console is a React build in web-dist/ (`npm run build:web`), served at /console; web/ stays as the fallback for the other pages.
app.get("/app.html", (c) => c.redirect(`/console${new URL(c.req.url).search}`, 301));
app.get("/console", serveStatic({ path: "./web-dist/app.html" }));
app.get("/console", (c) => c.text("Console not built. Run npm run build:web", 503));
app.use("/*", serveStatic({ root: "./web-dist" }));
app.use("/*", serveStatic({ root: "./web" }));

serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" });
console.log(`tripwire listening on 0.0.0.0:${config.port} | data=${rt.modes.data} model=${rt.modes.model} memory=${rt.modes.memory}`);
for (const n of rt.modes.notes) console.log(`  note: ${n}`);
