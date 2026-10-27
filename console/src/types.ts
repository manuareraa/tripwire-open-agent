// Shapes of what the Hono API returns, as far as the console reads them.

export interface Supplier {
  supplier_id: string;
  name?: string;
  short: string;
  ticker?: string;
  category?: string;
  spend_share?: number;
  lead_time_weeks?: number;
  cik?: string | number | null;
}

export interface RowRef { table: string; key: string }

export interface Finding {
  claim: string;
  metric?: string;
  value?: unknown;
  evidence?: { template_id?: string; sql?: string; result_hash?: string; depends_on?: RowRef[] };
}

export interface Tripwire {
  metric: string;
  op: string;
  threshold?: number | null;
  depends_on?: RowRef[];
  origin?: "decider" | "premortem" | "rules" | "backup" | "stale";
  story_id?: string;
  crash_test?: CrashTest;
}

export interface Backup { supplier_id: string; name?: string; healthy?: boolean; reason?: string; findings?: Finding[] }

export interface Decision {
  decision_id: string;
  subject_id: string;
  decision: string;
  confidence?: number;
  risk?: string;
  status: string;
  escalated?: boolean;
  escalation_reasons?: string[];
  rationale?: string;
  summary?: string;
  supersedes?: string | null;
  backup?: Backup;
  findings?: Finding[];
  tripwires?: Tripwire[];
  limitations?: string[];
  approved_by_reason?: string;
  sources?: SourceFreshness[];
  model_calls?: ModelCall[];
  proving?: ProvingGround;
}

export interface ModelCall {
  agent: string;
  tier: string;
  model: string;
  requested_model?: string;
  provider?: string;
  thinking: boolean;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  receipt_id?: string;
  replayed_from?: string;
  fallback?: string;
}

export interface SourceFreshness {
  table: string;
  label: string;
  system: string;
  as_of?: string;
  age_days?: number;
  max_age_days: number;
  basis: string;
  status: "fresh" | "stale" | "missing";
  note: string;
}

export interface WriteResult { written?: boolean; method?: string; detail?: string }

export interface TraceEvent {
  agent_name?: string;
  target_agent?: string;
  action?: string;
  output_summary?: string;
  event?: string;
  status?: string;
  sponsor?: string;
  retry_count?: number;
}

export interface ChangeField { field: string; before: unknown; after: unknown }

export interface ChangeCard {
  file: string;
  description: string;
  supplier_id?: string;
  table?: string;
  key?: string;
  synthetic?: boolean;
  supplier_name?: string;
  /** Already in the live data, so applying it again would change nothing. */
  in_data?: boolean;
  fields?: ChangeField[];
}

/** A change computed for one supplier from its current data (GET /changes/whatif). */
export interface WhatIf {
  id: string;
  kind: string;
  supplier_id: string;
  title: string;
  description: string;
  available: boolean;
  reason?: string;
  fields: (ChangeField & { table: string; key: string; supplier_id: string })[];
}

export interface ChangeReport {
  changed: RowRef;
  active: number;
  dependents: (string | { decision_id: string })[];
  reopened: { old: string; new: Decision; fired: string[] }[];
  still_valid: { decision_id: string; checked?: unknown[] }[];
  work_saved: number;
}

// Proving Ground (mirrors app/types.ts; see docs/PROVING_GROUND.md).
export interface FilingEvent { id: string; supplier_id: string; accession: string; filed: string; items: string[]; headline: string; severity: "low" | "medium" | "high"; source_url: string; parsed_by: string; text_hash: string }
export interface FailureStory { id: string; story: string; metric: string; op: string; threshold?: number; grounded_in: string[] }
export interface CrashTest { verdict: "verified" | "decorative" | "mis_set" | "untested"; past_value?: number; short_value?: number; past_decision?: string; short_decision?: string; why?: string; reason?: string }
export interface TrackRecord { window: string; trouble_events: number; caught_early: number; false_alarms: number; note: string }
export interface ProvingGround {
  filings?: FilingEvent[];
  stories?: FailureStory[];
  crash?: { tested: number; verified: number; decorative: number; mis_set: number; dropped: string[] };
  track_record?: TrackRecord;
  skipped?: string[];
}
