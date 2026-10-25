// Number and text formatting. Pure functions, no DOM.
import { METRIC } from "./labels";

export const pct = (v: number) => `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0)}%`;

export function fmtMetric(metric: string | undefined, v: unknown): string {
  if (typeof v !== "number") return String(v ?? "");
  const u = METRIC[metric ?? ""]?.[1];
  if (u === "share") return pct(v);
  if (u === "pct") return `${+v.toFixed(1)}%`;
  if (u === "weeks") return `${v} wk`;
  return Math.abs(v) >= 1e5 ? v.toLocaleString() : String(+v.toFixed(2));
}

export function fmtField(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "none";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (field === "spend_share" || field === "gross_margin") return pct(n);
  if (field === "current_ratio" || field === "debt_to_equity") return n.toFixed(2);
  if (field === "lead_time_weeks") return `${v} wk`;
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(+n.toFixed(2));
}

export const titleCase = (s: unknown) => String(s || "").toLowerCase()
  .replace(/(^|[\s.\-&/])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase())
  .replace(/[\s,]+(incorporated|inc|corporation|corp|company|co|ltd|plc|llc|n\.v|holdings?)\.?$/i, "").trim();

export const cap = (s: unknown) => String(s || "").replace(/^./, (c) => c.toUpperCase());
export const plural = (n: number | string, one: string, many = `${one}s`) => `${n} ${Number(n) === 1 ? one : many}`;
export const pretty = (a: unknown) => String(a || "").replace(/([a-z])([A-Z])/g, "$1 $2");

/** A random run id, so the console can watch a run's trace while the request is still open. */
export const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
