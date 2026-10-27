// Shared contracts. Every stream codes against these; change them only on the scaffold/integration branch.
import type { SourceFreshness } from "./freshness.js";

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
  /** Who proposed it (Proving Ground). Absent on older decisions. */
  origin?: TripwireOrigin;
  /** The pre-mortem failure story this tripwire guards against, when origin = "premortem". */
  story_id?: string;
  /** The crash test result: does crossing the line really change the call? */
  crash_test?: CrashTest;
}

// ---------- Proving Ground: Nemotron attacks its own decision before a human approves it ----------
// Read (Nemotron Parse on real 8-K filings) → Imagine (Ultra pre-mortem) → Crash-test (Lightning) → Backtest (real SEC history).
// See docs/PROVING_GROUND.md. Each stage fills its own part of `Decision.proving`; every stage is optional and labelled when skipped.

export type TripwireOrigin = "decider" | "premortem" | "rules" | "backup" | "stale";

/** A material event read out of a real 8-K filing by Nemotron Parse (stage 1, Read). */
export interface FilingEvent {
  id: string;
  supplier_id: string;
  accession: string;
  filed: string;
  /** 8-K item numbers, e.g. ["2.06", "5.02"]. */
  items: string[];
  /** One plain sentence: what happened. */
  headline: string;
  severity: "low" | "medium" | "high";
  /** EDGAR URL of the document that was read. */
  source_url: string;
  /** The model that read the document, e.g. "nvidia/nemotron-parse". */
  parsed_by: string;
  /** SHA-256 of the parsed text, so the reading can be checked against the document. */
  text_hash: string;
}

/** "It is six months later and this decision went badly. What happened?" (stage 2, Imagine). */
export interface FailureStory {
  id: string;
  /** Two or three plain sentences. */
  story: string;
  /** The early-warning number the story would move first. */
  metric: string;
  op: "<" | ">" | "changed";
  threshold?: number;
  /** FilingEvent ids or finding metrics the story leans on. */
  grounded_in: string[];
  /** How likely Ultra judged this failure path, given today's evidence. */
  likelihood?: "low" | "medium" | "high";
}

/** Stage 3, Crash-test: push one number just past the line, and just short of it, and re-decide. */
export interface CrashTest {
  /** verified: holds short of the line, changes past it. decorative: past the line changes nothing. mis-set: already changes short of the line. */
  verdict: "verified" | "decorative" | "mis_set" | "untested";
  /** The value tried just past the line, and just short of it. */
  past_value?: number;
  short_value?: number;
  /** What the re-decision said past the line and short of it. */
  past_decision?: DecisionKind;
  short_decision?: DecisionKind;
  /** One plain sentence from the model on why the call held or changed. */
  why?: string;
  /** Why it was not tested (no model, no number), when verdict = "untested". */
  reason?: string;
}

/** How this decision's tripwires did on real history (stage 4, Backtest); filled from eval/backtest_results.json. */
export interface TrackRecord {
  /** Quarters replayed, e.g. "2022Q1–2025Q4". */
  window: string;
  /** Real trouble events in the window (8-K items 1.03, 2.04, 2.06, 4.02, 5.02 …, or a covenant-level ratio break). */
  trouble_events: number;
  /** How many of them a tripwire fired on before (or the same quarter as) the event. */
  caught_early: number;
  /** Tripwire firings with no trouble in the next two quarters. */
  false_alarms: number;
  /** Plain one-liner for the UI. */
  note: string;
}

export interface ProvingGround {
  filings?: FilingEvent[];
  stories?: FailureStory[];
  /** Counts over this decision's candidate tripwires; dropped = candidates removed as decorative or mis-set. */
  crash?: { tested: number; verified: number; decorative: number; mis_set: number; dropped: string[] };
  track_record?: TrackRecord;
  /** Stages that did not run, and why, so nothing is passed off as done. */
  skipped?: string[];
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
  /** Freshness of each source fragment when the decision was made. */
  sources?: SourceFreshness[];
  /** Every model call made for this decision: which model really answered each step, or why none did. */
  model_calls?: ModelCall[];
  supersedes?: string;
  backup?: Backup;
  /** Proving Ground: how Nemotron read, imagined, crash-tested and backtested this decision. */
  proving?: ProvingGround;
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
  /** Which sponsor, when event = sponsor_call: "zetaris" | "meterless-hmem" | "meterless-nightshift" | "nvidia". */
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
  /**
   * The date source ages are measured from. Live data: now. Bundled sample data: the day it was fetched, so a
   * snapshot does not go stale just because it is read later. Absent = now.
   */
  clock?(): Date;
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
  /** Who served the call: "meterless-nightshift" (primary) or "nvidia" (direct backup). */
  provider?: string;
  /** Route facts the provider reported (Nightshift's `meterless` receipt object and meterless-* headers). */
  receipt?: Record<string, string>;
  /** The model id Tripwire asked for. Shown next to `model` when the provider served a different one. */
  requested_model?: string;
  /** Set when this answer is a replay of a recorded live call: the time it was recorded. */
  replayed_from?: string;
}

/** One model call as a decision records it, so the answer to "which model handled this?" travels with the decision. */
export interface ModelCall {
  agent: string;
  tier: ModelTier;
  /** The model that answered (the provider's own report), or the one asked for when none answered. */
  model: string;
  requested_model?: string;
  provider?: string;
  thinking: boolean;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  receipt_id?: string;
  replayed_from?: string;
  /** Set when no model answered and the agent used its rule-based path; says why. */
  fallback?: string;
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
