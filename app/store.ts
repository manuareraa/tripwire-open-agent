// Working set of decisions for the API and the Watcher. Approved decisions are also written to the
// data layer's ledger (Zetaris tripwire_decisions, or the sample JSONL ledger).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision } from "./types.js";

export class DecisionStore {
  private byId = new Map<string, Decision>();

  constructor(private file?: string) {
    if (file && existsSync(file)) {
      for (const d of JSON.parse(readFileSync(file, "utf8")) as Decision[]) this.byId.set(d.decision_id, d);
    }
  }

  put(d: Decision): void {
    this.byId.set(d.decision_id, d);
    this.save();
  }

  get(id: string): Decision | undefined {
    return this.byId.get(id);
  }

  list(): Decision[] {
    return [...this.byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /** Decisions still in force (not superseded or rejected). */
  active(): Decision[] {
    return this.list().filter((d) => d.status === "proposed" || d.status === "approved");
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.list(), null, 2));
  }
}
