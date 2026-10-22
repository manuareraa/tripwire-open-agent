import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { config } from "./app/config.js";
import { Tracer } from "./app/tracing.js";
import type { RunRequest } from "./app/types.js";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, sample_mode: config.sampleMode }));

app.post("/run", async (c) => {
  let body: RunRequest;
  try {
    body = await c.req.json<RunRequest>();
  } catch {
    return c.json({ error: "invalid_json", detail: "Body must be JSON: {mode, subject_id, ...}" }, 400);
  }
  if (!body?.mode || !body?.subject_id) {
    return c.json({ error: "invalid_input", detail: "mode and subject_id are required" }, 400);
  }
  const tracer = new Tracer();
  tracer.emit({ agent_name: "Server", action: "run_received", event: "message", status: "pending", input_summary: `${body.mode} ${body.subject_id}` });
  // Orchestration lands on the core branch; until then this is an explicit not-implemented response.
  return c.json({ error: "not_implemented", run_id: tracer.run_id, trace_file: tracer.file }, 501);
});

serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" });
console.log(`tripwire listening on 0.0.0.0:${config.port} (sample_mode=${config.sampleMode})`);
