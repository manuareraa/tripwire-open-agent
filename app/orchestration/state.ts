import type { Tracer } from "../tracing.js";
import type { MetricValue } from "../metrics.js";
import type { TripwireDraft } from "../tripwires.js";
import type {
  DataGateway, Decision, DecisionKind, Finding, MemoryClaim, MemoryStore, ModelClient, ModelRequest, ModelResponse, QueryResult,
} from "../types.js";

export interface Deps {
  gateway: DataGateway;
  model: ModelClient;
  memory: MemoryStore;
  tracer: Tracer;
}

export type RiskLevel = "low" | "medium" | "high";

export interface DecisionDraft {
  decision: DecisionKind;
  confidence: number;
  rationale: string;
  tripwires: TripwireDraft[];
  limitations: string[];
  /** true when the rule-based path produced this draft. */
  rules: boolean;
}

export interface RunState {
  run_id: string;
  decision_id: string;
  subject_id: string;
  question: string;
  supersedes?: Decision;
  plan: string[];
  results: Record<string, QueryResult>;
  metrics: MetricValue[];
  findings: Finding[];
  summary: string;
  priorClaims: MemoryClaim[];
  staleClaims: MemoryClaim[];
  risk: { level: RiskLevel; flags: string[]; thinking: boolean };
  draft?: DecisionDraft;
  rounds: number;
  limitations: string[];
  escalated: boolean;
  escalationReasons: string[];
}

/** Every model call goes through here so the trace records model, thinking, tokens, latency and fallbacks. */
export async function callModel(deps: Deps, s: RunState, req: ModelRequest): Promise<ModelResponse> {
  const res = await deps.model.complete(req);
  deps.tracer.emit({
    decision_id: s.decision_id,
    agent_name: req.agent_name,
    action: res.fallback ? "model_unavailable" : `model_call_${req.tier}`,
    event: res.fallback ? "fallback" : "sponsor_call",
    sponsor: "nvidia",
    status: res.fallback ? "fallback" : "success",
    output_summary: res.fallback ? `rule-based path (${res.error})` : `${res.model}${res.thinking ? " (thinking on)" : ""}`,
    data: {
      model: res.model, tier: req.tier, thinking: res.thinking, tokens_in: res.tokens_in, tokens_out: res.tokens_out,
      latency_ms: res.latency_ms, reasoning_excerpt: res.reasoning_excerpt,
    },
  });
  return res;
}
