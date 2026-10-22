import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { config } from "./app/config.js";
import { Tracer } from "./app/tracing.js";
import { buildRuntime } from "./app/runtime.js";
import { runDecide } from "./app/orchestration/graph.js";
import { reopenFor } from "./app/watcher.js";
import type { Deps } from "./app/orchestration/state.js";
import type { Decision, RunRequest, TraceEvent } from "./app/types.js";

const rt = await buildRuntime();
const app = new Hono();

// Keep the last few traces in memory for the UI; full traces are in logs/trace-<run_id>.jsonl.
const traces = new Map<string, TraceEvent[]>();
function remember(t: Tracer) {
  traces.set(t.run_id, [...t.all()]);
  while (traces.size > 50) traces.delete(traces.keys().next().value!);
}
const depsFor = (tracer: Tracer): Deps => ({ gateway: rt.gateway, model: rt.model, memory: rt.memory, tracer });

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`run exceeded ${ms} ms`)), ms))]);
}

function toResponse(run_id: string, d: Decision, extra: Record<string, unknown> = {}) {
  return {
    run_id, decision_id: d.decision_id, decision: d.decision, confidence: d.confidence, status: d.status,
    evidence: d.evidence, tripwires: d.tripwires, escalated: d.escalated, escalation_reasons: d.escalation_reasons,
    limitations: d.limitations, rationale: d.rationale, risk: d.risk, findings: d.findings, supersedes: d.supersedes, ...extra,
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
  const tracer = new Tracer();
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
    const changed = body.changed ?? { table: "supplier_spend", key: body.subject_id };
    const report = await withTimeout(reopenFor(deps, rt.store, changed), config.limits.runTimeoutMs);
    remember(tracer);
    return c.json({ run_id: tracer.run_id, trace_file: tracer.file, ...report });
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

// Demo change feed (bundled sample data): apply a change file, then the Watcher decides what to reopen.
app.get("/changes", (c) => c.json(rt.sample.listChangeFiles()));
app.post("/changes/:file/apply", async (c) => {
  const file = c.req.param("file");
  if (!rt.sample.listChangeFiles().includes(file)) return c.json({ error: "not_found" }, 404);
  if (rt.gateway !== rt.sample) {
    return c.json({ error: "live_data", detail: "Change files apply to sample data only; with Zetaris, change the source table and the watcher picks it up" }, 409);
  }
  const tracer = new Tracer();
  const deps = depsFor(tracer);
  try {
    const rows = await rt.sample.applyChange(file);
    const reports = [];
    for (const r of rows) reports.push(await withTimeout(reopenFor(deps, rt.store, r), config.limits.runTimeoutMs));
    remember(tracer);
    return c.json({ run_id: tracer.run_id, file, rows, reports });
  } catch (e) {
    remember(tracer);
    return c.json({ error: "run_failed", detail: (e as Error).message, run_id: tracer.run_id }, 500);
  }
});

app.get("/trace/:run_id", (c) => {
  const t = traces.get(c.req.param("run_id"));
  return t ? c.json(t) : c.json({ error: "not_found" }, 404);
});

app.use("/*", serveStatic({ root: "./web" }));

serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" });
console.log(`tripwire listening on 0.0.0.0:${config.port} | data=${rt.modes.data} model=${rt.modes.model} memory=${rt.modes.memory}`);
for (const n of rt.modes.notes) console.log(`  note: ${n}`);
