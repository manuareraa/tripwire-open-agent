// MemoryStore backed by the vendored Meterless H-MEM reference (vendor/hmem), run in-process.
//
// Every claim is one H-MEM record. Tripwire's lineage is written into H-MEM's own fields, so
// H-MEM's state.json is the single source of truth (no side files):
//   content     = claim text
//   chatId      = subject_id (H-MEM's native scope filter, used by recall)
//   derivedFrom = one "row:<table>/<key>#<result_hash>" ref per lineage entry (parts URI-encoded)
//   tags        = subject:<id>, decision:<id>, metric:<name>, value:<json>
//   supersedes / supersededBy = H-MEM's supersession fields
// dependentsOf() is an exact scan over derivedFrom (H-MEM has no reverse index); retrieval
// ranking, the audit ledger and confidence feedback are H-MEM's.

import { HMEM } from "../../vendor/hmem/src/index.js";
import type { LedgerEntry, MemoryRecord } from "../../vendor/hmem/src/index.js";
import type { MemoryClaim, MemoryStore, RowRef, TraceEvent } from "../types.js";

export type NewClaim = Omit<MemoryClaim, "id" | "created_at">;

export interface HmemStoreOptions {
  /** Directory for H-MEM's state.json + ledger.jsonl. null = in-memory only (tests). */
  persistDir?: string | null;
  /** Injectable clock (H-MEM is deterministic given a fixed clock). */
  clock?: () => number;
  /** Final-score threshold for recall. H-MEM's default (0.35) is tuned for chat memory; the
   *  hash embedder scores short numeric claims low, so subject-scoped recall uses a lower bar. */
  recallThreshold?: number;
}

export const DEFAULT_MEMORY_DIR = process.env.HMEM_DIR ?? "data/memory";
const SOURCE = "tripwire:memory-keeper";

const enc = encodeURIComponent;
export function rowKey(row: RowRef): string {
  return `${enc(row.table)}/${enc(row.key)}`;
}
function lineageRef(row: RowRef, result_hash: string): string {
  return `row:${rowKey(row)}#${enc(result_hash)}`;
}
function parseLineageRef(ref: string): { row: RowRef; result_hash: string } | null {
  const m = /^row:([^/#]*)\/([^/#]*)#(.*)$/.exec(ref);
  if (!m) return null;
  return { row: { table: decodeURIComponent(m[1]), key: decodeURIComponent(m[2]) }, result_hash: decodeURIComponent(m[3]) };
}
function tagValue(tags: string[], prefix: string): string | undefined {
  const t = tags.find((x) => x.startsWith(prefix + ":"));
  return t === undefined ? undefined : t.slice(prefix.length + 1);
}

export class HmemMemoryStore implements MemoryStore {
  readonly hmem: HMEM;
  readonly persistDir: string | null;
  private recallThreshold: number;

  constructor(opts: HmemStoreOptions = {}) {
    this.persistDir = opts.persistDir === undefined ? DEFAULT_MEMORY_DIR : opts.persistDir;
    this.recallThreshold = opts.recallThreshold ?? 0.05;
    this.hmem = new HMEM({
      clock: opts.clock,
      persistDir: this.persistDir ?? undefined,
      actor: SOURCE,
    });
  }

  async remember(claim: NewClaim): Promise<MemoryClaim> {
    if (!claim.subject_id) throw new Error("hmem: claim needs a subject_id");
    if (claim.supersedes && !this.hmem.store.get(claim.supersedes)) {
      throw new Error(`hmem: cannot supersede unknown claim ${claim.supersedes}`);
    }
    const refs = claim.derivedFrom.map((d) => lineageRef(d.row, d.result_hash));
    const tags = [`subject:${claim.subject_id}`];
    if (claim.decision_id) tags.push(`decision:${claim.decision_id}`);
    if (claim.metric) tags.push(`metric:${claim.metric}`);
    if (claim.value !== undefined) tags.push(`value:${JSON.stringify(claim.value)}`);
    const rec = this.hmem.add({
      content: claim.text,
      type: "factual",
      tags,
      source: SOURCE,
      provenance: { origin: "document", learnedAt: this.hmem.clock(), label: "evidence-backed claim", refs },
      chatId: claim.subject_id,
      supersedes: claim.supersedes,
      derivedFrom: refs,
    });
    // H-MEM auto-links `supersedes` when text has a correction word ("instead", "actually") and is
    // similar to any record. Tripwire's supersession must be explicit, so undo an auto-link.
    if (!claim.supersedes && rec.supersedes) this.hmem.store.update(rec.id, { supersedes: undefined });
    return toClaim(rec);
  }

  async recall(subject_id: string, query: string, limit = 5): Promise<MemoryClaim[]> {
    const res = this.hmem.query(query, {
      chatId: subject_id,
      topN: Number.MAX_SAFE_INTEGER,
      threshold: this.recallThreshold,
    });
    return res.memories
      .map((r) => r.memory)
      .filter((m) => m.chatId === subject_id && !m.supersededBy)
      .slice(0, limit)
      .map(toClaim);
  }

  /** Exact: decision ids of current (not superseded) claims whose lineage includes this row. */
  async dependentsOf(row: RowRef): Promise<string[]> {
    const want = rowKey(row);
    const out = new Set<string>();
    for (const m of this.hmem.store.all()) {
      if (m.supersededBy) continue;
      const decision = tagValue(m.tags, "decision");
      if (!decision) continue;
      const hit = (m.derivedFrom ?? []).some((ref) => {
        const p = parseLineageRef(ref);
        return p !== null && rowKey(p.row) === want;
      });
      if (hit) out.add(decision);
    }
    return [...out].sort();
  }

  async supersede(oldClaimId: string, newClaim: NewClaim): Promise<MemoryClaim> {
    const old = this.hmem.store.get(oldClaimId);
    if (!old) throw new Error(`hmem: cannot supersede unknown claim ${oldClaimId}`);
    if (old.supersededBy) throw new Error(`hmem: claim ${oldClaimId} is already superseded by ${old.supersededBy}`);
    const created = await this.remember({ ...newClaim, supersedes: oldClaimId });
    // H-MEM sets supersededBy only via conflict resolution; we set it ourselves (logged as an update).
    this.hmem.store.update(oldClaimId, { supersededBy: created.id });
    return created;
  }

  // ---------- extras beyond the MemoryStore contract ----------

  get(claimId: string): MemoryClaim | undefined {
    const m = this.hmem.store.get(claimId);
    return m ? toClaim(m) : undefined;
  }

  supersededBy(claimId: string): string | undefined {
    return this.hmem.store.get(claimId)?.supersededBy;
  }

  /** Follow supersedes links back from a claim: [claimId, older, oldest...]. */
  chain(claimId: string): string[] {
    const out: string[] = [];
    let cur = this.hmem.store.get(claimId);
    while (cur && !out.includes(cur.id)) {
      out.push(cur.id);
      cur = cur.supersedes ? this.hmem.store.get(cur.supersedes) : undefined;
    }
    return out;
  }

  /** Current claims recorded for a decision. */
  claimsForDecision(decision_id: string): MemoryClaim[] {
    return this.hmem.store
      .all()
      .filter((m) => !m.supersededBy && tagValue(m.tags, "decision") === decision_id)
      .map(toClaim);
  }

  /** Mark a claim wrong in H-MEM (confidence -0.20, "review" tag, ledger entry). Used after a stale catch. */
  flagWrong(claimId: string): void {
    this.hmem.feedback(claimId, "wrong");
  }

  /** H-MEM's append-only audit trail for one claim. */
  history(claimId: string): LedgerEntry[] {
    return this.hmem.ledger.history(claimId);
  }

  ledgerStats(): Record<string, number> {
    return this.hmem.ledger.stats();
  }
}

function toClaim(m: MemoryRecord): MemoryClaim {
  const derivedFrom = (m.derivedFrom ?? [])
    .map(parseLineageRef)
    .filter((x): x is { row: RowRef; result_hash: string } => x !== null);
  const valueTag = tagValue(m.tags, "value");
  const claim: MemoryClaim = {
    id: m.id,
    subject_id: tagValue(m.tags, "subject") ?? m.chatId ?? "",
    text: m.content,
    derivedFrom,
    created_at: new Date(m.timestamp).toISOString(),
  };
  const metric = tagValue(m.tags, "metric");
  if (metric !== undefined) claim.metric = metric;
  if (valueTag !== undefined) claim.value = JSON.parse(valueTag) as number | string;
  const decision = tagValue(m.tags, "decision");
  if (decision !== undefined) claim.decision_id = decision;
  if (m.supersedes) claim.supersedes = m.supersedes;
  return claim;
}

export function createMemoryStore(opts: HmemStoreOptions = {}): HmemMemoryStore {
  return new HmemMemoryStore(opts);
}

// ---------- stale-memory check ----------

export interface StaleReport {
  /** true when at least one lineage row's current hash differs from the recorded one. */
  stale: boolean;
  changed: { row: RowRef; recorded: string; current: string }[];
  /** Rows with no current hash supplied: not verified either way. */
  unverified: RowRef[];
}

/** Compare a claim's recorded evidence hashes with the current result_hash for each row. */
export function checkStale(
  claim: Pick<MemoryClaim, "derivedFrom">,
  current: ((row: RowRef) => string | undefined) | Map<string, string> | Record<string, string>
): StaleReport {
  const lookup =
    typeof current === "function"
      ? current
      : current instanceof Map
        ? (r: RowRef) => current.get(rowKey(r))
        : (r: RowRef) => current[rowKey(r)];
  const report: StaleReport = { stale: false, changed: [], unverified: [] };
  for (const d of claim.derivedFrom) {
    const now = lookup(d.row);
    if (now === undefined) report.unverified.push(d.row);
    else if (now !== d.result_hash) report.changed.push({ row: d.row, recorded: d.result_hash, current: now });
  }
  report.stale = report.changed.length > 0;
  return report;
}

// ---------- failure guard ----------

export type HmemCallResult<T> =
  | { ok: true; value: T; latency_ms: number; event: Omit<TraceEvent, "timestamp" | "run_id"> }
  | { ok: false; error: string; latency_ms: number; event: Omit<TraceEvent, "timestamp" | "run_id"> };

/**
 * Run one H-MEM call without letting it throw. Returns a ready-to-emit trace event
 * (event "sponsor_call", sponsor "meterless-hmem"); the caller passes it to Tracer.emit
 * and decides the fallback.
 */
export async function callHmem<T>(
  agent_name: string,
  action: string,
  fn: () => Promise<T> | T,
  opts: { input_summary?: string; decision_id?: string; summarize?: (v: T) => string } = {}
): Promise<HmemCallResult<T>> {
  const t0 = Date.now();
  const base = { agent_name, action, event: "sponsor_call" as const, sponsor: "meterless-hmem", input_summary: opts.input_summary, decision_id: opts.decision_id };
  try {
    const value = await fn();
    const latency_ms = Date.now() - t0;
    return {
      ok: true,
      value,
      latency_ms,
      event: { ...base, status: "success", output_summary: opts.summarize?.(value), data: { latency_ms } },
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const latency_ms = Date.now() - t0;
    return { ok: false, error, latency_ms, event: { ...base, status: "failed", output_summary: `H-MEM error: ${error}`, data: { latency_ms, error } } };
  }
}
