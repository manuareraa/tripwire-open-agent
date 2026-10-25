import type { Tracer } from "../tracing.js";
import type { Reranker } from "../adapters/rerank.js";
import type { MetricValue } from "../metrics.js";
import type { TripwireDraft } from "../tripwires.js";
import type { SourceFreshness } from "../freshness.js";
import type {
  DataGateway, Decision, DecisionKind, Finding, MemoryClaim, MemoryStore, ModelCall, ModelClient, ModelRequest, ModelResponse, QueryResult,
} from "../types.js";

export interface Deps {
  gateway: DataGateway;
  model: ModelClient;
  memory: MemoryStore;
  tracer: Tracer;
  /** Optional: orders findings by relevance to the question before the summary (Nemotron rerank). */
  reranker?: Reranker;
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
  /** How current each source fragment is, measured against its policy line. */
  freshness: SourceFreshness[];
  /** Every model call so far, in order; copied onto the decision. */
  modelCalls: ModelCall[];
  metrics: MetricValue[];
  findings: Finding[];
  summary: string;
  priorClaims: MemoryClaim[];
  staleClaims: MemoryClaim[];
  /** The rerank order of findings for this question, so a revision does not call rerank again. */
  rankedFor?: { question: string; n: number; order: number[] };
  risk: { level: RiskLevel; flags: string[]; thinking: boolean };
  draft?: DecisionDraft;
  rounds: number;
  limitations: string[];
  escalated: boolean;
  escalationReasons: string[];
}

/** Nightshift's receipt id, wherever this runtime version puts it. */
const receiptId = (res: ModelResponse) => res.receipt?.receipt_id ?? res.receipt?.id ?? res.receipt?.["receipt.id"] ?? res.receipt?.["header.meterless-receipt-id"];

/** Every model call goes through here so the trace records model, thinking, tokens, latency and fallbacks. */
export async function callModel(deps: Deps, s: RunState, req: ModelRequest): Promise<ModelResponse> {
  const res = await deps.model.complete(req);
  s.modelCalls.push({
    agent: req.agent_name, tier: req.tier, model: res.model, provider: res.provider, thinking: res.thinking,
    tokens_in: res.tokens_in, tokens_out: res.tokens_out, latency_ms: res.latency_ms,
    ...(res.requested_model && res.requested_model !== res.model ? { requested_model: res.requested_model } : {}),
    ...(receiptId(res) ? { receipt_id: receiptId(res) } : {}),
    ...(res.replayed_from ? { replayed_from: res.replayed_from } : {}),
    ...(res.fallback ? { fallback: res.error ?? "no model answered" } : {}),
  });
  const via = res.provider === "meterless-nightshift" ? "Meterless Nightshift" : "NVIDIA direct (backup)";
  // When the provider served a different model than the one asked for, say so rather than claim the requested one.
  const swapped = res.requested_model && res.requested_model !== res.model ? ` (asked for ${res.requested_model})` : "";
  const replay = res.replayed_from ? ` [replay of a live call recorded ${res.replayed_from.slice(0, 16).replace("T", " ")} UTC]` : "";
  deps.tracer.emit({
    decision_id: s.decision_id,
    agent_name: req.agent_name,
    action: res.fallback ? "model_unavailable" : `model_call_${req.tier}`,
    event: res.fallback ? "fallback" : "sponsor_call",
    sponsor: res.fallback ? undefined : res.provider ?? "nvidia",
    status: res.fallback ? "fallback" : "success",
    output_summary: res.fallback
      ? `rule-based path (${res.error})`
      : `${res.model}${swapped} via ${via}` +
        `${res.thinking ? " (thinking on)" : ""}${receiptId(res) ? `, receipt ${receiptId(res)}` : ""}${replay}`,
    data: {
      model: res.model, requested_model: res.requested_model, provider: res.provider, tier: req.tier, thinking: res.thinking,
      tokens_in: res.tokens_in, tokens_out: res.tokens_out, latency_ms: res.latency_ms, reasoning_excerpt: res.reasoning_excerpt,
      receipt: res.receipt, replayed_from: res.replayed_from,
    },
  });
  return res;
}
