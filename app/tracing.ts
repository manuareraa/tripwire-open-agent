import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TraceEvent } from "./types.js";

const LOG_DIR = process.env.LOG_DIR ?? "logs";

export class Tracer {
  readonly run_id: string;
  readonly file: string;
  private events: TraceEvent[] = [];

  constructor(run_id: string = randomUUID().slice(0, 8)) {
    this.run_id = run_id;
    mkdirSync(LOG_DIR, { recursive: true });
    this.file = join(LOG_DIR, `trace-${run_id}.jsonl`);
  }

  emit(e: Omit<TraceEvent, "timestamp" | "run_id">): TraceEvent {
    const ev: TraceEvent = { timestamp: new Date().toISOString(), run_id: this.run_id, ...e };
    this.events.push(ev);
    const line = JSON.stringify(ev);
    appendFileSync(this.file, line + "\n");
    if (process.env.TRACE_STDOUT !== "false") console.log(line);
    return ev;
  }

  all(): readonly TraceEvent[] {
    return this.events;
  }
}
