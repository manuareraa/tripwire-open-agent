// Metrics are computed in code from query rows, never by a model. Each one keeps the evidence it came from.
import type { Evidence, QueryResult } from "./types.js";

export interface MetricDef {
  name: string;
  label: string;
  template: string;
  /** Direction in which the metric gets riskier. */
  worseWhen: "lower" | "higher";
  unit: "ratio" | "share" | "pct" | "weeks" | "count";
}

export const METRICS: MetricDef[] = [
  { name: "current_ratio", label: "Current ratio", template: "supplier_financials_latest", worseWhen: "lower", unit: "ratio" },
  { name: "debt_to_equity", label: "Liabilities to equity", template: "supplier_financials_latest", worseWhen: "higher", unit: "ratio" },
  { name: "gross_margin", label: "Gross margin", template: "supplier_financials_latest", worseWhen: "lower", unit: "share" },
  { name: "revenue_change_pct", label: "Revenue change across reported periods", template: "supplier_financials_history", worseWhen: "lower", unit: "pct" },
  { name: "spend_share", label: "Share of our category spend", template: "supplier_spend_row", worseWhen: "higher", unit: "share" },
  { name: "lead_time_weeks", label: "Lead time", template: "supplier_spend_row", worseWhen: "higher", unit: "weeks" },
  { name: "category_alternatives", label: "Other suppliers in the category", template: "category_concentration", worseWhen: "lower", unit: "count" },
];

export const METRIC_NAMES = METRICS.map((m) => m.name);
export const metricDef = (name: string) => METRICS.find((m) => m.name === name);

export interface MetricValue {
  metric: string;
  value: number;
  evidence: Evidence;
}

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Compute every metric the available results allow. Missing data simply yields fewer metrics. */
export function computeMetrics(results: Record<string, QueryResult>, subjectId: string): MetricValue[] {
  const out: MetricValue[] = [];
  const push = (metric: string, value: number | undefined, ev: Evidence) => {
    if (value !== undefined) out.push({ metric, value: round(value), evidence: ev });
  };

  const spend = results.supplier_spend_row;
  if (spend?.rows[0]) {
    push("spend_share", num(spend.rows[0].spend_share), spend.evidence);
    push("lead_time_weeks", num(spend.rows[0].lead_time_weeks), spend.evidence);
  }
  const fin = results.supplier_financials_latest;
  if (fin?.rows[0]) {
    for (const m of ["current_ratio", "debt_to_equity", "gross_margin"]) push(m, num(fin.rows[0][m]), fin.evidence);
  }
  const hist = results.supplier_financials_history;
  if (hist && hist.rows.length >= 2) {
    const sorted = [...hist.rows].sort((a, b) => String(b.period_end).localeCompare(String(a.period_end)));
    const latest = num(sorted[0].revenue);
    const oldest = num(sorted[sorted.length - 1].revenue);
    if (latest !== undefined && oldest) push("revenue_change_pct", ((latest - oldest) / Math.abs(oldest)) * 100, hist.evidence);
  }
  const cat = results.category_concentration;
  if (cat) {
    push("category_alternatives", cat.rows.filter((r) => r.supplier_id !== subjectId).length, cat.evidence);
  }
  return out;
}

export const round = (n: number) => Math.round(n * 1000) / 1000;

export function formatMetric(m: MetricValue): string {
  const d = metricDef(m.metric);
  switch (d?.unit) {
    case "share": return `${(m.value * 100).toFixed(1)}%`;
    case "pct": return `${m.value.toFixed(1)}%`;
    case "weeks": return `${m.value} weeks`;
    default: return String(m.value);
  }
}
