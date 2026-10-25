// Shared contracts. Every stream codes against these; change them only on the scaffold/integration branch.

export type DecisionKind = "keep" | "dual_source" | "exit";
export type DecisionStatus = "proposed" | "approved" | "rejected" | "superseded";

/** Proof that a number came from a specific query result. */
export interface Evidence {
  template_id: string;
  params: Record<string, string | number>;
  sql: string;
  table: string;
  period?: string;
  /** SHA-256 of canonical JSON of the result rows (sorted keys, sorted rows). */
  result_hash: string;
  /** Rows the decision depends on, as {table, key} pairs (feeds derivedFrom lineage). */
  depends_on: RowRef[];
}

export interface RowRef {
  table: string;
  key: string;
}

/** A condition that, when it trips, reopens the decision. Evaluated in code; the model only proposes it. */
export interface Tripwire {
  id: string;
  metric: string;
  op: "<" | ">" | "changed";
  threshold?: number;
  depends_on: RowRef[];
}

export interface Finding {
  claim: string;
  metric: string;
  value: number | string;
  evidence: Evidence;
}

/** The supplier a dual_source or exit decision names to take the work, picked in code. */
export interface Backup {
  supplier_id: string;
  name?: string;
  /** Passes the financial health lines (current ratio >= 1, liabilities/equity <= 3). */
  healthy: boolean;
  reason: string;
  /** The backup's own numbers (metrics named backup_*), each with its evidence. */
  findings: Finding[];
}

export interface Decision {
  decision_id: string;
  subject_id: string;
  decision: DecisionKind;
  confidence: number;
  status: DecisionStatus;
  findings: Finding[];
  evidence: Evidence[];
  tripwires: Tripwire[];
  limitations: string[];
  supersedes?: string;
  backup?: Backup;
  escalated: boolean;
  escalation_reasons?: string[];
  risk?: "low" | "medium" | "high";
  rationale?: string;
  summary?: string;
  created_at: string;
  approved_by_reason?: string;
}

/** POST /run body. */
export interface RunRequest {
  mode: "decide" | "reopen";
  subject_id: string;
  question?: string;
  changed?: RowRef;
  /** SAMPLE_MODE only: a file in data/sample/changes/ to apply before the reopen check. */
  change_file?: string;
  /** Optional client-chosen run id, so the UI can poll GET /trace/:run_id while the run is in progress. */
  run_id?: string;
}

export interface RunResponse {
  run_id: string;
  decision_id: string;
  decision: DecisionKind;
  confidence: number;
  status: DecisionStatus;
  evidence: Evidence[];
  tripwires: Tripwire[];
  escalated: boolean;
  trace_file: string;
}

// ---------- Trace (JSONL, one line per event; field names follow the hackathon's judging guide) ----------

export type TraceEventType =
  | "message"
  | "handoff"
  | "tool_call"
  | "critique"
  | "retry"
  | "escalation"
  | "sponsor_call"
  | "fallback"
  | "decision"
  | "error";

export type TraceStatus = "success" | "needs_revision" | "fallback" | "failed" | "partial" | "pending";

export interface TraceEvent {
  timestamp: string;
  run_id: string;
  decision_id?: string;
  agent_name: string;
  action: string;
  event: TraceEventType;
  target_agent?: string;
  input_summary?: string;
  output_summary?: string;
  confidence?: number;
  retry_count?: number;
  status: TraceStatus;
  /** Which sponsor, when event = sponsor_call: "zetaris" | "meterless-hmem" | "nvidia". */
  sponsor?: string;
  data?: unknown;
}

// ---------- Adapter interfaces (implemented in app/adapters/*) ----------

export interface QueryResult {
  rows: Record<string, unknown>[];
  evidence: Evidence;
  /** true when served from the SAMPLE_MODE data, never hidden. */
  sample: boolean;
}

/** Zetaris gateway (live) and sample_data (SAMPLE_MODE) both implement this. Template-only SQL. */
export interface DataGateway {
  readonly name: "zetaris" | "sample";
  health(): Promise<{ ok: boolean; detail: string }>;
  listTemplates(): TemplateSpec[];
  runTemplate(templateId: string, params: Record<string, string | number>): Promise<QueryResult>;
  /** Append an approved decision to the ledger (tripwire_decisions) and return how it was written. */
  writeDecision(d: Decision): Promise<{ written: boolean; method: string; detail: string }>;
  readDecisions(): Promise<Decision[]>;
  /** Rows changed since a marker, for the Watcher. */
  changesSince(marker: string): Promise<{ changes: RowRef[]; marker: string }>;
}

export interface TemplateSpec {
  id: string;
  description: string;
  table: string;
  params: string[];
  sql: string;
}

export type ModelTier = "reasoning" | "small" | "guard";

export interface ModelRequest {
  tier: ModelTier;
  agent_name: string;
  system: string;
  user: string;
  /** Reasoning budget: Risk Officer turns this on only for high-risk steps. */
  thinking?: boolean;
  /** Ask for JSON output. */
  json?: boolean;
  max_tokens?: number;
}

export interface ModelResponse {
  text: string;
  model: string;
  thinking: boolean;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  /** true when no model answered (no key, timeout, error); the agent must use its rule-based path. */
  fallback: boolean;
  /** Why the model was not used, when fallback = true. */
  error?: string;
  /** Short excerpt of the model's reasoning trace, when thinking was on. */
  reasoning_excerpt?: string;
}

export interface ModelClient {
  /** false when no model can run (no key, or rules-only), so traces do not promise model reasoning. */
  readonly enabled?: boolean;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export interface Lineage {
  row: RowRef;
  result_hash: string;
  /** Query template the hash came from. Older claims have none; they are compared row by row. */
  template_id?: string;
}

export interface MemoryClaim {
  id: string;
  subject_id: string;
  text: string;
  metric?: string;
  value?: number | string;
  /** Lineage: the rows and evidence hashes this claim came from, and the query template that produced each hash. */
  derivedFrom: Lineage[];
  decision_id?: string;
  supersedes?: string;
  created_at: string;
}

/** Wraps Meterless H-MEM (in-process). */
export interface MemoryStore {
  /** Shown in traces as the sponsor/backing store, e.g. "meterless-hmem" or "local-lineage". */
  readonly name?: string;
  remember(claim: Omit<MemoryClaim, "id" | "created_at">): Promise<MemoryClaim>;
  recall(subject_id: string, query: string, limit?: number): Promise<MemoryClaim[]>;
  /** Decisions whose claims derive from this row (selective reopen). */
  dependentsOf(row: RowRef): Promise<string[]>;
  supersede(oldClaimId: string, newClaim: Omit<MemoryClaim, "id" | "created_at">): Promise<MemoryClaim>;
}
