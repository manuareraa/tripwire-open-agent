// Analyst: runs the planned queries, computes metrics in code, and writes a short summary.
import { config } from "../config.js";
import { computeMetrics, formatMetric, metricDef } from "../metrics.js";
import { callModel, type Deps, type RunState } from "../orchestration/state.js";
import type { Finding, QueryResult } from "../types.js";

const AGENT = "Analyst";

export function paramsFor(templateId: string, s: RunState): Record<string, string | number> | undefined {
  const spend = s.results.supplier_spend_row?.rows[0];
  switch (templateId) {
    case "supplier_spend_row": return { supplier_id: s.subject_id };
    case "supplier_financials_latest": return spend?.cik !== undefined ? { cik: String(spend.cik) } : undefined;
    case "supplier_financials_history": return spend?.cik !== undefined ? { cik: String(spend.cik), periods: 5 } : undefined;
    case "category_concentration": return spend?.category ? { category: String(spend.category) } : undefined;
    case "supplier_events_recent":
    case "sanctions_screen_row": return spend?.cik !== undefined ? { cik: String(spend.cik) } : undefined;
    case "source_status": return {};
  }
  return undefined;
}

/** Run one template with bounded retries. */
export async function runQuery(deps: Deps, s: RunState, templateId: string, params: Record<string, string | number>, agent = AGENT): Promise<QueryResult> {
  const max = config.limits.maxRetriesPerQuery;
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      const r = await deps.gateway.runTemplate(templateId, params);
      deps.tracer.emit({
        decision_id: s.decision_id, agent_name: agent, action: `query:${templateId}`, event: "tool_call",
        sponsor: deps.gateway.name === "zetaris" ? "zetaris" : undefined, retry_count: attempt, status: "success",
        input_summary: JSON.stringify(params), output_summary: `${r.rows.length} rows, hash ${r.evidence.result_hash.slice(0, 12)}${r.sample ? " (sample data)" : ""}`,
      });
      return r;
    } catch (e) {
      lastErr = e as Error;
      deps.tracer.emit({
        decision_id: s.decision_id, agent_name: agent, action: `query:${templateId}`, event: attempt < max ? "retry" : "error",
        retry_count: attempt, status: "failed", output_summary: lastErr.message,
      });
    }
  }
  throw lastErr ?? new Error(`query ${templateId} failed`);
}

export async function gather(deps: Deps, s: RunState): Promise<void> {
  for (const id of s.plan) {
    const params = paramsFor(id, s);
    if (!params) {
      s.limitations.push(`Skipped ${id}: required input missing`);
      continue;
    }
    try {
      s.results[id] = await runQuery(deps, s, id, params);
    } catch (e) {
      if (id === "supplier_spend_row") throw new Error(`No spend record for ${s.subject_id}: ${(e as Error).message}`);
      s.limitations.push(`${id} unavailable: ${(e as Error).message}`);
    }
  }
  if (!s.results.supplier_spend_row?.rows.length) throw new Error(`Unknown supplier ${s.subject_id}`);
  refreshFindings(s);
}

export function refreshFindings(s: RunState): void {
  s.metrics = computeMetrics(s.results, s.subject_id);
  s.findings = s.metrics.map<Finding>((m) => ({
    claim: `${metricDef(m.metric)?.label ?? m.metric}: ${formatMetric(m)}`,
    metric: m.metric,
    value: m.value,
    evidence: m.evidence,
  }));
}

export function rulesSummary(s: RunState): string {
  return s.findings.map((f) => f.claim).join("; ") + ".";
}

/** Model-written summary; the Critic checks every number in it against the findings. */
export async function summarize(deps: Deps, s: RunState, feedback?: string): Promise<{ text: string; fromModel: boolean }> {
  const res = await callModel(deps, s, {
    tier: "small",
    agent_name: AGENT,
    system:
      "You are a procurement analyst. Summarise the supplier's position in 2-3 sentences for a buyer. " +
      "Use only the numbers given, written exactly as given. Do not add any other numbers.",
    user:
      `Supplier ${s.subject_id}. Question: ${s.question}\nFindings:\n` + s.findings.map((f) => `- ${f.claim}`).join("\n") +
      (feedback ? `\n\nYour previous summary was rejected by the evidence critic: ${feedback}. Fix it.` : ""),
  });
  if (res.fallback) return { text: rulesSummary(s), fromModel: false };
  return { text: res.text.trim(), fromModel: true };
}
