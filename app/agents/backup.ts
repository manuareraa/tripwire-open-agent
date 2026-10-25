// Backup picker (code, not a model): for a dual_source or exit decision, name the other supplier in the category
// that should take the work. Healthy finances first (current ratio ≥ 1, liabilities/equity ≤ 3), then the shorter
// lead time, then the stronger current ratio. Its numbers keep their own evidence and tripwires, so the decision
// reopens if the backup itself weakens.
import { round, type MetricValue } from "../metrics.js";
import type { TripwireDraft } from "../tripwires.js";
import type { Backup, Evidence } from "../types.js";
import { runQuery } from "./analyst.js";
import type { Deps, RunState } from "../orchestration/state.js";

const AGENT = "BackupPicker";

/** The same distress lines the Risk Officer uses. */
export const BACKUP_HEALTH = { minCurrentRatio: 1, maxDebtToEquity: 3 };

export interface Candidate {
  supplier_id: string;
  name?: string;
  lead_time_weeks?: number;
  current_ratio?: number;
  debt_to_equity?: number;
  metrics: MetricValue[];
}

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export const isHealthy = (c: Pick<Candidate, "current_ratio" | "debt_to_equity">) =>
  c.current_ratio !== undefined && c.debt_to_equity !== undefined &&
  c.current_ratio >= BACKUP_HEALTH.minCurrentRatio && c.debt_to_equity <= BACKUP_HEALTH.maxDebtToEquity;

/** Best candidate first. Missing numbers rank last within their group. */
export function rankCandidates(list: Candidate[]): Candidate[] {
  const inf = (x: number | undefined, fallback: number) => (x === undefined ? fallback : x);
  return [...list].sort((a, b) =>
    Number(isHealthy(b)) - Number(isHealthy(a)) ||
    inf(a.lead_time_weeks, Infinity) - inf(b.lead_time_weeks, Infinity) ||
    inf(b.current_ratio, -Infinity) - inf(a.current_ratio, -Infinity) ||
    a.supplier_id.localeCompare(b.supplier_id));
}

/** Read one candidate's spend row and latest financials; its metrics are named backup_*. */
export async function loadCandidate(deps: Deps, s: RunState, supplier_id: string): Promise<Candidate> {
  const spend = await runQuery(deps, s, "supplier_spend_row", { supplier_id }, AGENT);
  const row = spend.rows[0];
  if (!row) throw new Error(`no spend row for ${supplier_id}`);
  const c: Candidate = { supplier_id, lead_time_weeks: num(row.lead_time_weeks), metrics: [] };
  const push = (metric: string, value: number | undefined, evidence: Evidence) => {
    if (value !== undefined) c.metrics.push({ metric, value: round(value), evidence });
  };
  push("backup_lead_time_weeks", c.lead_time_weeks, spend.evidence);
  if (row.cik !== undefined && row.cik !== null && row.cik !== "") {
    const fin = await runQuery(deps, s, "supplier_financials_latest", { cik: String(row.cik) }, AGENT);
    const f = fin.rows[0];
    if (f) {
      c.name = f.name == null ? undefined : String(f.name);
      c.current_ratio = num(f.current_ratio);
      c.debt_to_equity = num(f.debt_to_equity);
      push("backup_current_ratio", c.current_ratio, fin.evidence);
      push("backup_debt_to_equity", c.debt_to_equity, fin.evidence);
    }
  }
  return c;
}

function reasonFor(c: Candidate, healthy: boolean, others: number): string {
  const facts = [
    c.current_ratio !== undefined ? `current ratio ${c.current_ratio}` : "no current ratio on file",
    c.debt_to_equity !== undefined ? `liabilities/equity ${c.debt_to_equity}` : "no liabilities/equity on file",
    c.lead_time_weeks !== undefined ? `lead time ${c.lead_time_weeks} weeks` : "no lead time on file",
  ].join(", ");
  const field = others === 1 ? "the only other supplier in the category" : `the best of ${others} other suppliers in the category`;
  return healthy
    ? `${field}: ${facts}, within the policy lines (current ratio ≥ ${BACKUP_HEALTH.minCurrentRatio}, liabilities/equity ≤ ${BACKUP_HEALTH.maxDebtToEquity}).`
    : `${field}, but none passes the policy lines (current ratio ≥ ${BACKUP_HEALTH.minCurrentRatio}, liabilities/equity ≤ ${BACKUP_HEALTH.maxDebtToEquity}): ${facts}. Check it before moving volume.`;
}

/** Tripwires that reopen the decision if a healthy backup stops being healthy. Never already true today. */
export function backupTripwires(c: Candidate): TripwireDraft[] {
  if (!isHealthy(c)) return [];
  return [
    { metric: "backup_current_ratio", op: "<", threshold: BACKUP_HEALTH.minCurrentRatio },
    { metric: "backup_debt_to_equity", op: ">", threshold: BACKUP_HEALTH.maxDebtToEquity },
  ];
}

/**
 * Pick the backup for this run. Returns undefined when the category has no other supplier or none can be read;
 * the reason goes to the limitations either way.
 */
export async function pickBackup(deps: Deps, s: RunState): Promise<{ backup: Backup; metrics: MetricValue[]; tripwires: TripwireDraft[] } | undefined> {
  const others = (s.results.category_concentration?.rows ?? [])
    .map((r) => String(r.supplier_id))
    .filter((id) => id && id !== s.subject_id);
  const emit = (status: "success" | "partial", output_summary: string) => deps.tracer.emit({
    decision_id: s.decision_id, agent_name: AGENT, action: "pick_backup", event: "handoff", target_agent: "RiskOfficer", status, output_summary,
  });
  if (!others.length) {
    s.limitations.push("No other supplier in the category to name as a backup");
    emit("partial", "no other supplier in the category");
    return undefined;
  }
  const candidates: Candidate[] = [];
  for (const id of others) {
    try {
      candidates.push(await loadCandidate(deps, s, id));
    } catch (e) {
      s.limitations.push(`Backup candidate ${id} could not be read: ${(e as Error).message}`);
    }
  }
  const best = rankCandidates(candidates)[0];
  if (!best) {
    emit("partial", "no candidate could be read");
    return undefined;
  }
  const healthy = isHealthy(best);
  if (!healthy) s.limitations.push(`No backup in the category passes the financial health lines; ${best.supplier_id} is the least weak`);
  const backup: Backup = {
    supplier_id: best.supplier_id,
    ...(best.name ? { name: best.name } : {}),
    healthy,
    reason: reasonFor(best, healthy, candidates.length),
    findings: best.metrics.map((m) => ({ claim: `Backup ${m.metric.replace(/^backup_/, "").replace(/_/g, " ")}: ${m.value}`, metric: m.metric, value: m.value, evidence: m.evidence })),
  };
  const tripwires = backupTripwires(best);
  emit(healthy ? "success" : "partial",
    `backup ${best.supplier_id}${best.name ? ` (${best.name})` : ""}, ${healthy ? "healthy" : "not healthy"}; ` +
    `ranked ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}: ${rankCandidates(candidates).map((c) => c.supplier_id).join(" > ")}`);
  return { backup, metrics: best.metrics, tripwires };
}
