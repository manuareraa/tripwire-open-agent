// Proving Ground stage 1, Read: material events from the supplier's real 8-K filings, read by Nemotron Parse.
// scripts/parse_filings.ts fetched each document from EDGAR and had nvidia/nemotron-parse (build.nvidia.com) read it,
// offline; the results are cached in data/cache/filings/index.json, so every run (sample or live) needs no key.
// This stage only loads those events into s.proving.filings. It adds no findings and calls no model, so the
// prompts of the other agents (and the recorded live answers) are unchanged; the pre-mortem cites events by id.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Deps, RunState } from "../orchestration/state.js";
import type { FilingEvent } from "../types.js";

const AGENT = "FilingReader";
export const FILINGS_INDEX = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/cache/filings/index.json");

export interface FilingsIndex {
  parse_model: string;
  headline_model: string;
  /** When the newest document was read (ISO). */
  read_at: string | null;
  by_supplier: Record<string, FilingEvent[]>;
}

let cached: { path: string; index: FilingsIndex | null } | undefined;

/** The cached index, or null when the cache file is missing or unreadable. */
export function loadFilingsIndex(path = process.env.FILINGS_INDEX ?? FILINGS_INDEX): FilingsIndex | null {
  if (cached?.path === path) return cached.index;
  let index: FilingsIndex | null = null;
  try {
    if (existsSync(path)) index = JSON.parse(readFileSync(path, "utf8")) as FilingsIndex;
  } catch {
    index = null;
  }
  cached = { path, index };
  return index;
}

const RANK = { high: 0, medium: 1, low: 2 } as const;
/** Highest severity first, then newest. */
export const bySeverity = (a: FilingEvent, b: FilingEvent) => RANK[a.severity] - RANK[b.severity] || b.filed.localeCompare(a.filed);

export async function readFilings(deps: Deps, s: RunState, index = loadFilingsIndex()): Promise<void> {
  // A backtest replays an earlier date (SAMPLE_CLOCK): filings made after it must not be seen.
  const asOf = process.env.SAMPLE_CLOCK?.slice(0, 10);
  const events = (index?.by_supplier?.[s.subject_id] ?? []).filter((e) => !asOf || e.filed.slice(0, 10) <= asOf);
  if (!index || events.length === 0) {
    const why = !index ? "no cached 8-K readings (run scripts/parse_filings.ts)" : `no 8-K filings read for ${s.subject_id}${asOf ? ` filed by ${asOf}` : ""}`;
    (s.proving.skipped ??= []).push(`read: ${why}`);
    deps.tracer.emit({ decision_id: s.decision_id, agent_name: AGENT, action: "read_filings", event: "message", status: "partial", output_summary: why });
    return;
  }
  s.proving.filings = [...events].sort(bySeverity);
  const high = events.filter((e) => e.severity === "high").length;
  const when = index.read_at ? index.read_at.slice(0, 10) : "an unknown date";
  deps.tracer.emit({
    decision_id: s.decision_id,
    agent_name: AGENT,
    action: "read_filings",
    event: "sponsor_call",
    sponsor: "nvidia",
    status: "success",
    output_summary: `${events.length} 8-K filings read by ${index.parse_model} on build.nvidia.com (offline, ${when}; served from cache), ${high} high severity`,
    data: { parse_model: index.parse_model, headline_model: index.headline_model, read_at: index.read_at, ids: events.map((e) => e.id), cached: true },
  });
}
