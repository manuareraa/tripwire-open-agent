// Evidence Critic: "prove it". Re-runs every query and compares hashes, and rejects any number in
// agent prose that does not trace back to a finding.
import { config } from "../config.js";
import { assessFreshness } from "../freshness.js";
import { reviewTripwires } from "../tripwires.js";
import type { MetricValue } from "../metrics.js";
import { metricDef } from "../metrics.js";
import { refreshFindings, runQuery } from "./analyst.js";
import { RISK_THRESHOLDS } from "./risk.js";
import type { DecisionDraft, Deps, RunState } from "../orchestration/state.js";

const AGENT = "EvidenceCritic";

/** Re-query each piece of evidence; on a hash mismatch, send the Analyst back (bounded). */
export async function verifyEvidence(deps: Deps, s: RunState): Promise<void> {
  for (const [id, result] of Object.entries(s.results)) {
    let current = result;
    let ok = false;
    for (let attempt = 0; attempt <= config.limits.maxRetriesPerQuery; attempt++) {
      let check;
      try {
        check = await runQuery(deps, s, id, current.evidence.params, AGENT);
      } catch (e) {
        s.limitations.push(`Could not re-verify ${id}: ${(e as Error).message}`);
        break;
      }
      if (check.evidence.result_hash === current.evidence.result_hash) {
        ok = true;
        break;
      }
      deps.tracer.emit({
        decision_id: s.decision_id, agent_name: AGENT, action: "reject_evidence", event: "critique", target_agent: "Analyst",
        status: "needs_revision", retry_count: attempt,
        output_summary: `REJECT ${id}: hash ${current.evidence.result_hash.slice(0, 12)} ≠ ${check.evidence.result_hash.slice(0, 12)}; data changed under us, re-analysing`,
      });
      current = check;
      s.results[id] = check;
    }
    deps.tracer.emit({
      decision_id: s.decision_id, agent_name: AGENT, action: `verify:${id}`, event: "critique",
      status: ok ? "success" : "partial", output_summary: ok ? `hash ${current.evidence.result_hash.slice(0, 12)} reproduced` : "evidence unstable",
    });
    if (!ok) s.limitations.push(`Evidence for ${id} changed during review; latest values used`);
  }
  refreshFindings(s);
}

/** Stale-memory catch: re-check each recalled H-MEM claim against today's evidence hashes; reject reuse of stale ones. */
/** Measure each source fragment against its freshness policy; stale or missing fragments become limitations. */
export function reviewFreshness(deps: Deps, s: RunState): string[] {
  const now = deps.gateway.clock?.() ?? new Date();
  s.freshness = assessFreshness(s.results, now);
  const issues = s.freshness.filter((f) => f.status !== "fresh").map((f) => `${f.status.toUpperCase()} ${f.note}`);
  for (const f of s.freshness) {
    deps.tracer.emit({
      decision_id: s.decision_id, agent_name: AGENT, action: `review_freshness:${f.table}`, event: "critique",
      status: f.status === "fresh" ? "success" : "needs_revision",
      output_summary: `${f.status}: ${f.note} (clock ${now.toISOString().slice(0, 10)})`,
    });
  }
  for (const i of issues) s.limitations.push(`Source freshness: ${i}`);
  return issues;
}

export function reviewMemory(deps: Deps, s: RunState): string[] {
  if (!s.priorClaims.length) return [];
  const issues = s.staleClaims.map((c) => {
    const rows = c.derivedFrom.map((d) => `${d.row.table}:${d.row.key}`).join(", ");
    return `"${c.text}" (from ${rows}, hash ${c.derivedFrom[0]?.result_hash.slice(0, 12) ?? "?"}) no longer matches the data`;
  });
  deps.tracer.emit({
    decision_id: s.decision_id, agent_name: AGENT, action: "review_memory", event: "critique",
    target_agent: issues.length ? "MemoryKeeper" : "Analyst", status: issues.length ? "needs_revision" : "success",
    output_summary: issues.length
      ? `REJECT ${issues.length} recalled claim(s) as evidence: ${issues.slice(0, 2).join("; ")}${issues.length > 2 ? "; …" : ""}`
      : `${s.priorClaims.length} recalled claims still match today's evidence`,
  });
  return issues;
}

/** Every acceptable written form of a metric value (e.g. 0.312 → 0.31, 31.2, 31). */
function allowedForms(metrics: MetricValue[], extra: number[]): number[] {
  const out: number[] = [];
  for (const m of metrics) {
    out.push(m.value);
    const unit = metricDef(m.metric)?.unit;
    if (unit === "share") out.push(m.value * 100);
  }
  for (const x of extra) out.push(x, x * 100);
  return out;
}

/** Numbers in `text` that match no finding (or tripwire threshold). Small counts and years are allowed. */
export function unsupportedNumbers(text: string, metrics: MetricValue[], extra: number[] = []): string[] {
  const allowed = allowedForms(metrics, extra);
  // Supplier ids and SEC form names ("8-K", "10-Q") are labels, not figures.
  const found = text.replace(/SUP-\d+|\b\d{1,2}-[KQ]\b/g, "").match(/-?\d+(?:,\d{3})*(?:\.\d+)?/g) ?? [];
  const bad: string[] = [];
  for (const raw of found) {
    const n = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    if (Number.isInteger(n) && Math.abs(n) <= 4) continue;
    if (n >= 1990 && n <= 2035 && Number.isInteger(n)) continue;
    // Accept a value rounded to the precision actually written ("0.9" covers 0.85–0.95, "0.55" only 0.545–0.555),
    // or within 2% for large figures.
    const decimals = raw.split(".")[1]?.length ?? 0;
    const tol = (a: number) => Math.max(0.5 * 10 ** -decimals + 1e-9, Math.abs(a) * 0.02);
    const ok = allowed.some((a) => Math.abs(Math.abs(a) - Math.abs(n)) <= tol(a));
    if (!ok) bad.push(raw);
  }
  return bad;
}

export function reviewSummary(deps: Deps, s: RunState, text: string): string[] {
  const bad = unsupportedNumbers(text, s.metrics);
  const issues = bad.length ? [`numbers not in the evidence: ${bad.join(", ")}`] : [];
  deps.tracer.emit({
    decision_id: s.decision_id, agent_name: AGENT, action: "check_summary", event: "critique", target_agent: issues.length ? "Analyst" : "RiskOfficer",
    status: issues.length ? "needs_revision" : "success", output_summary: issues.length ? `REJECT: ${issues[0]}` : "every number traced to evidence",
  });
  return issues;
}

/** Review a Decider draft; returns the list of problems (empty = approve). */
export function reviewDecision(deps: Deps, s: RunState, draft: DecisionDraft): string[] {
  const issues = reviewTripwires(draft.tripwires, s.metrics);
  if (!["keep", "dual_source", "exit"].includes(draft.decision)) issues.push(`decision must be keep, dual_source or exit`);
  if (!(draft.confidence >= 0 && draft.confidence <= 1)) issues.push(`confidence must be between 0 and 1`);
  const thresholds = draft.tripwires.map((t) => t.threshold).filter((x): x is number => typeof x === "number");
  const bad = unsupportedNumbers(draft.rationale, s.metrics, [...thresholds, ...RISK_THRESHOLDS]);
  if (bad.length) issues.push(`rationale cites numbers not in the evidence: ${bad.join(", ")}`);
  if (s.risk.level === "high" && draft.decision === "keep" && draft.confidence > 0.8) {
    issues.push(`"keep" at ${draft.confidence} confidence ignores high-risk flags (${s.risk.flags.join("; ")}); justify or lower confidence`);
  }
  deps.tracer.emit({
    decision_id: s.decision_id, agent_name: AGENT, action: "review_decision", event: "critique",
    target_agent: issues.length ? "Decider" : "RiskOfficer", status: issues.length ? "needs_revision" : "success",
    confidence: draft.confidence, retry_count: s.rounds - 1,
    output_summary: issues.length ? `REJECT round ${s.rounds}: ${issues.join(" | ")}` : `APPROVE ${draft.decision} @ ${draft.confidence}`,
  });
  return issues;
}
