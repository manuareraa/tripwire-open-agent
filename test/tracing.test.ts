import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Tracer", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tripwire-trace-"));
    process.env.LOG_DIR = tempDir;
    process.env.TRACE_STDOUT = "false";
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.LOG_DIR;
    delete process.env.TRACE_STDOUT;
  });

  it("writes one JSON line per emit with timestamp and run_id", async () => {
    const { Tracer } = await import("../app/tracing.js");
    const runId = "testrun1";
    const tracer = new Tracer(runId);

    const ev1 = tracer.emit({
      agent_name: "planner",
      action: "plan",
      event: "message",
      status: "success",
    });
    const ev2 = tracer.emit({
      agent_name: "analyst",
      action: "query",
      event: "tool_call",
      status: "partial",
      input_summary: "supplier_spend_row",
    });

    expect(ev1.run_id).toBe(runId);
    expect(ev2.run_id).toBe(runId);
    expect(ev1.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ev2.timestamp).toBeTruthy();

    const filePath = join(tempDir, `trace-${runId}.jsonl`);
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(2);

    const parsed1 = JSON.parse(lines[0]!) as Record<string, unknown>;
    const parsed2 = JSON.parse(lines[1]!) as Record<string, unknown>;

    expect(parsed1).toMatchObject({
      run_id: runId,
      agent_name: "planner",
      action: "plan",
      event: "message",
      status: "success",
    });
    expect(parsed2).toMatchObject({
      run_id: runId,
      agent_name: "analyst",
      event: "tool_call",
    });
    expect(typeof parsed1.timestamp).toBe("string");
    expect(typeof parsed2.timestamp).toBe("string");

    expect(tracer.all()).toHaveLength(2);
  });
});
