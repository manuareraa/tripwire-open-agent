// Fallback MemoryStore used when H-MEM is not available: a JSON-file lineage index with the same contract
// (claims carry derivedFrom rows, supersede keeps history). It is named honestly in traces as "local-lineage".
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryClaim, MemoryStore, RowRef } from "../types.js";

type NewClaim = Omit<MemoryClaim, "id" | "created_at">;

export class LocalMemory implements MemoryStore {
  readonly name = "local-lineage";
  private claims: MemoryClaim[] = [];

  constructor(private file?: string) {
    if (file && existsSync(file)) this.claims = JSON.parse(readFileSync(file, "utf8")) as MemoryClaim[];
  }

  async remember(c: NewClaim): Promise<MemoryClaim> {
    const claim: MemoryClaim = { ...c, id: `mem-${this.claims.length + 1}-${Date.now().toString(36)}`, created_at: new Date().toISOString() };
    this.claims.push(claim);
    this.save();
    return claim;
  }

  /** Current (non-superseded) claims for a subject; newest first. The query is ignored: there is no ranking here. */
  async recall(subject_id: string, _query: string, limit = 20): Promise<MemoryClaim[]> {
    return this.current().filter((c) => c.subject_id === subject_id).reverse().slice(0, limit);
  }

  async dependentsOf(row: RowRef): Promise<string[]> {
    const ids = this.current()
      .filter((c) => c.decision_id && c.derivedFrom.some((d) => d.row.table === row.table && d.row.key === row.key))
      .map((c) => c.decision_id!);
    return [...new Set(ids)];
  }

  async supersede(oldId: string, c: NewClaim): Promise<MemoryClaim> {
    return this.remember({ ...c, supersedes: oldId });
  }

  private current(): MemoryClaim[] {
    const replaced = new Set(this.claims.map((c) => c.supersedes).filter(Boolean));
    return this.claims.filter((c) => !replaced.has(c.id));
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.claims));
  }
}
