// Plain English: codes from the data and the agents, turned into words.
import { cap, fmtMetric, pct, plural, pretty } from "./format";
import { DATA_SRC, GUARD, METRIC, MODEL_TIER, NOW, OP, TABLE, TEMPLATE, ZETARIS } from "./labels";
import { decName, metricName, rowName, supName, tplName, verdictName } from "./names";
import type { Decision, TraceEvent, WriteResult } from "./types";

export interface Flag { name: string; value?: string; rule?: string; meaning?: string; metric?: string; group: "health" | "exposure" | "policy" }

// Risk flags exactly as the Risk Officer writes them (app/agents/risk.ts), with the rule and what it means.
const FLAG: [RegExp, string, string, string][] = [
  [/^current ratio (\S+) < 1$/, "current_ratio", "should be at least 1", "Its short-term assets don't cover the bills due within a year."],
  [/^liabilities\/equity (\S+) > 3$/, "debt_to_equity", "should be 3 or less", "It owes a lot compared with what its owners have put in."],
  [/^gross margin (\S+) < 0\.1$/, "gross_margin", "should be at least 10%", "It keeps very little from each sale, so it has little cushion for shocks."],
  [/^revenue change (\S+)% < -10%$/, "revenue_change_pct", "shouldn't fall by more than 10%", "Its sales are shrinking fast."],
  [/^spend share (\S+) ≥ 0\.25$/, "spend_share", "should stay under 25%", "A large slice of this category's spend rides on this one supplier."],
  [/^lead time (\S+) weeks ≥ 12$/, "lead_time_weeks", "should be under 12 weeks", "Replacing or restocking them would take a quarter or more."],
];
const FIXED: Record<string, [string, string]> = {
  "no alternative supplier in category": ["No other supplier in this category", "If this supplier fails, there is nowhere to move the work."],
  "prior decision relied on data that has since changed": ["Earlier decision used data that has since changed", "What we knew before is out of date, so this needs a fresh look."],
  "guard model flagged the rationale": ["Safety check flagged the reasoning", "A separate guard model objected to the written rationale."],
  "exit decisions always go to a senior buyer": ["Exit always needs a senior buyer", "Dropping a supplier is a policy decision, whatever the numbers say."],
};
/** One risk flag or escalation reason → { name, value, rule, meaning, group }. */
export function readFlag(raw: unknown): Flag {
  const r = String(raw).trim().replace(/^high risk: /, "");
  for (const [re, metric, rule, meaning] of FLAG) {
    const m = r.match(re);
    if (m) return { name: metricName(metric), value: fmtMetric(metric, Number(m[1])), rule, meaning, metric, group: /spend|lead/.test(metric) ? "exposure" : "health" };
  }
  const low = r.match(/^low confidence (\S+)$/);
  if (low) return { name: "Low confidence", value: pct(Number(low[1])), rule: "should be at least 60%", meaning: "The agents were not sure enough for a routine sign-off.", group: "policy" };
  const f = FIXED[r];
  return f ? { name: f[0], meaning: f[1], group: /supplier in|data/.test(r) ? "exposure" : "policy" } : { name: cap(r), group: "policy" };
}
/** escalation_reasons → one readable flag each ("high risk: a; b" becomes a and b). */
export const readReasons = (list: unknown[] | undefined) => (list || []).flatMap((r) => String(r).split("; ")).filter(Boolean).map(readFlag);
export const flagText = (f: Flag) => `${f.name}${f.value ? ` ${f.value}` : ""}${f.rule ? ` (${f.rule})` : ""}`;

/** Tripwire text from the agents: "debt_to_equity > 5 (now 4.138, was 4.138)" → "Liabilities to equity rises above 5 (now 4.14, was 4.14)". */
export function wireText(s: unknown) {
  return String(s).replace(/\b([a-z_]+) (>=|<=|>|<|==|changed) *(-?[\d.]+(?:e-?\d+)?)? *(?:\(now (\S+?), was (\S+?)\))?/g, (all, m: string, op: string, th?: string, now?: string, was?: string) => {
    if (!METRIC[m]) return all;
    const f = (x?: string) => x === undefined || x === "undefined" ? "unknown" : fmtMetric(m, Number(x));
    return `${metricName(m)} ${OP[op] ?? op}${th !== undefined && op !== "changed" ? ` ${f(th)}` : ""}${now !== undefined ? ` (now ${f(now)}, was ${f(was)})` : ""}`.trim();
  });
}
/** Catch-all for any remaining codes inside agent text. */
export function plain(s: unknown) {
  return wireText(String(s ?? ""))
    .replace(/\b(supplier_financials|supplier_spend|tripwire_decisions):([\w-]+)/g, (_, t: string, k: string) => rowName(t, k))
    .replace(/\bDEC-SUP-\d+-\w+/g, decName)
    .replace(/\b(dual_source|keep|exit) @ ([\d.]+)/g, (_, v: string, c: string) => `${verdictName(v)} at ${pct(Number(c))} confidence`)
    .replace(/\bdual_source\b/g, "Dual-source")
    .replace(/\bhash ([0-9a-f]{8,})/g, "result fingerprint $1")
    .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (w) => TEMPLATE[w] ?? (METRIC[w] ? metricName(w) : w.replace(/_/g, " ")));
}
const numsList = (s: string) => s.split(/,\s*/).filter(Boolean).join(", ");
/** Why the Critic sent work back, in words. */
export function issueText(s: unknown) {
  return String(s).split(" | ").map((x) => {
    let m = x.match(/^(?:rationale cites )?numbers not in the evidence: (.+)$/);
    if (m) return `It quotes numbers that no query produced: ${numsList(m[1])}.`;
    m = x.match(/^"keep" at ([\d.]+) confidence ignores high-risk flags \((.+)\); justify or lower confidence$/);
    if (m) return `It says Keep at ${pct(Number(m[1]))} confidence but ignores red flags (${m[2].split("; ").map((f) => flagText(readFlag(f))).join("; ")}).`;
    return cap(plain(x)) + (/[.!?]$/.test(x) ? "" : ".");
  }).join(" ");
}

/** A trace event in words: { title, detail }. The raw text stays on hover for anyone who wants it. */
/** "supplier_spend SUP-06" (as the server logs a row) in words. */
const rowText = (s: string) => { const i = s.indexOf(" "); return i > 0 ? rowName(s.slice(0, i), s.slice(i + 1)) : s; };

export function say(e: TraceEvent): { title: string; detail: string } {
  const a = String(e.action || ""), o = String(e.output_summary || ""), fail = e.status === "failed";
  const [kind, arg] = a.includes(":") ? [a.slice(0, a.indexOf(":")), a.slice(a.indexOf(":") + 1)] : [a, ""];
  let m: RegExpMatchArray | null;
  switch (kind) {
    case "start_decision":
    case "reopen_decision": {
      const src = (o.match(/data: (\w+)/) || [])[1], sup2 = (o.match(/supersedes (\S+)/) || [])[1];
      return { title: kind === "start_decision" ? "Started a new decision" : "Reopened an earlier decision", detail: `Using ${(src && DATA_SRC[src]) ?? src ?? "the data layer"}${sup2 ? `. This will replace ${decName(sup2)}.` : "."}` };
    }
    case "plan": {
      const [steps, ...rest] = o.split(" | ");
      const extra = rest.map((p) => p.replace(/^focus: /, "Focus: ").replace(/^policy added: (.+)/, (_, x: string) => `Added by policy: ${x.split(", ").map(tplName).join(", ")}`));
      return { title: "Chose which approved queries to run", detail: [steps.split(" → ").map(tplName).join(" → "), ...extra].join(". ") };
    }
    case "drop_unknown_steps": return { title: "Ignored steps that are not approved queries", detail: o.replace(/^ignored: /, "Ignored: ") };
    case "query":
      if (fail) return { title: `Couldn't read ${tplName(arg)}${e.retry_count ? `, retrying` : ""}`, detail: o };
      m = o.match(/^(\d+) rows/);
      return { title: `Read ${tplName(arg)}`, detail: `${m ? plural(m[1], "row") : "Result"} returned${/sample data/.test(o) ? " from the sample data" : ""}. A fingerprint of the result is kept so the number can be re-checked later.` };
    case "template": return { title: `Zetaris ran the ${tplName(arg)} query`, detail: o.replace(/(\d+) rows in (\d+) ms/, (_, n: string, ms: string) => `${plural(n, "row")} in ${Number(ms).toLocaleString()} ms`) };
    case "verify":
      return e.status === "success"
        ? { title: `Double-checked ${tplName(arg)}`, detail: "Re-ran the query and got exactly the same result, so the numbers stand." }
        : { title: `Double-checked ${tplName(arg)}: unstable`, detail: "The result was different on a re-run." };
    case "reject_evidence": return { title: "Sent the analysis back: the data changed mid-run", detail: `Re-running ${tplName((o.match(/^REJECT (\S+):/) || [])[1])} gave a different result, so the Analyst starts again on fresh data.` };
    case "review_memory": {
      if (e.status === "success") return { title: "Checked what memory recalled", detail: cap(o.replace(/(\d+) recalled claims still match today's evidence/, (_, n: string) => `${plural(n, "remembered claim")} still match today's data.`)) };
      const claims = [...o.matchAll(/"([^"]+)" \(from ([^)]+?), hash \w+\)/g)].map((x) => `“${x[1]}” (from ${plain(x[2])})`);
      m = o.match(/^REJECT (\d+)/);
      return { title: `Refused ${m ? plural(m[1], "remembered claim") : "remembered claims"} as evidence`, detail: `${claims.join("; ")}${claims.length ? " no longer match the data." : ""}` };
    }
    case "check_summary":
      return o.startsWith("REJECT")
        ? { title: "Sent the summary back to the Analyst", detail: issueText(o.replace(/^REJECT: /, "")) }
        : { title: "Checked the Analyst's summary", detail: "Every number in it traces back to a query result." };
    case "recall": {
      if (e.status !== "success") return { title: "Memory unavailable", detail: o.replace(/^memory unavailable: /, "") };
      m = o.match(/^(\d+) prior claims; (\d+) stale/);
      const ex = (o.match(/e\.g\. "([^"]+)"/) || [])[1];
      return { title: "Recalled what we knew before", detail: m ? `${plural(m[1], "earlier claim")}, ${m[2]} out of date${ex ? `, for example “${ex}”` : ""}.` : plain(o) };
    }
    case "drop_stale": m = o.match(/^(\d+)/); return { title: "Set aside out-of-date claims", detail: `${m ? plural(m[1], "claim") : "Claims"} whose data has changed go to the Decider marked “changed since”, not as facts.` };
    case "assess_risk": {
      m = o.match(/^risk (\w+)(?:: (.+?))?; reasoning budget: thinking (\w+)/);
      if (!m) return { title: "Graded the risk", detail: plain(o) };
      const flags = m[2] ? m[2].split("; ").map((f) => flagText(readFlag(f))) : [];
      return { title: `Graded the risk: ${m[1]}`, detail: `${flags.length ? `Red flags: ${flags.join("; ")}.` : "No red flags."} ${/no model/.test(o) ? (m[3] === "ON" ? "Deep thinking would be on, but no model is set up, so the rule-based path decides." : "No model is set up, so the rule-based path decides.") : m[3] === "ON" ? "Deep thinking is on for the Decider." : "Deep thinking is not needed."}` };
    }
    case "propose_decision": {
      m = o.match(/^(\w+) @ ([\d.]+); tripwires: (.*)$/);
      return m ? { title: `Proposed ${verdictName(m[1])} at ${pct(Number(m[2]))} confidence`, detail: m[3] ? `Reopen if: ${m[3].split(", ").map(wireText).join("; ")}.` : "No tripwires." } : { title: "Proposed a decision", detail: plain(o) };
    }
    case "review_decision": {
      m = o.match(/^APPROVE (\w+) @ ([\d.]+)/);
      if (m) return { title: "Passed the draft decision", detail: `${verdictName(m[1])} at ${pct(Number(m[2]))} confidence holds up against the evidence.` };
      m = o.match(/^REJECT round (\d+): (.+)$/);
      return m ? { title: `Sent the draft back to the Decider (round ${m[1]})`, detail: issueText(m[2]) } : { title: "Reviewed the draft decision", detail: plain(o) };
    }
    case "pick_backup": {
      m = o.match(/^backup (SUP-\d+)(?: \((.+?)\))?, (healthy|not healthy); ranked (\d+) candidates?: (.+)$/);
      if (!m) return { title: "Looked for a backup supplier", detail: cap(o) };
      return {
        title: `Named ${supName(m[1])} as the backup`,
        detail: `Ranked ${plural(m[4], "other supplier")} in the category in code: healthy finances first, then the shorter lead time. ${m[3] === "healthy" ? "It passes the financial health lines." : "None passes the financial health lines, so check it before moving volume."}`,
      };
    }
    case "check_backup": return { title: "Couldn't re-check the backup supplier", detail: o };
    case "round_limit": return { title: "Switched to the rule-based policy", detail: "The draft failed review too many times, so a simple labelled rule decides instead." };
    case "final_check": {
      m = o.match(/^guard: (\w+); (?:ESCALATED: (.+)|standard approval)$/);
      if (!m) return { title: "Ran the final check", detail: plain(o) };
      const why = m[2] ? readReasons([m[2]]).map((f) => f.name) : [];
      return { title: m[2] ? "Escalated to a senior buyer" : "Ran the final check: routine sign-off", detail: `${GUARD[m[1]] ?? ""} ${why.length ? `Reasons: ${why.join("; ")}.` : "No escalation needed."}`.trim() };
    }
    case "remember":
      if (fail) return { title: "Couldn't save to memory", detail: o };
      m = o.match(/^(\d+) claims stored with lineage(?:, (\d+) superseding)?/);
      return { title: "Saved the claims with where each came from", detail: m ? `${plural(m[1], "claim")} stored, each linked to the data row it came from${m[2] ? `. ${m[2]} replace the old decision's claims` : ""}.` : plain(o) };
    case "decision_proposed": {
      m = o.match(/^(\w+) @ ([\d.]+), (\d+) tripwires, (\w+) approval/);
      return { title: "Ready for a person to review", detail: m ? `${verdictName(m[1])} at ${pct(Number(m[2]))} confidence with ${plural(m[3], "tripwire")}. ${m[4] === "escalated" ? "Needs a senior buyer's sign-off." : "Routine sign-off."}` : plain(o) };
    }
    case "lineage_lookup": {
      if (e.status !== "success") return { title: "Memory unavailable, checking every decision", detail: plain(o) };
      m = o.match(/^(\d+) of (\d+) active decisions depend on this row: (.*)$/);
      return { title: "Looked up which decisions read the changed row", detail: m ? `${m[1]} of ${plural(m[2], "active decision")} ${Number(m[1]) === 1 ? "depends" : "depend"} on it${m[3] !== "none" ? `: ${m[3].split(", ").map(decName).join(", ")}` : ""}.` : plain(o) };
    }
    case "check_tripwires":
      if (o.startsWith("FIRED")) return { title: "A tripwire fired, so the decision reopens", detail: `${cap(wireText(o.replace(/^FIRED: /, "").replace(/ → reopening$/, "")))}.` };
      m = o.match(/^no tripwire fired \((.*)\); decision stands$/);
      return { title: "No tripwire fired: the decision stands", detail: m ? `Checked: ${wireText(m[1])}.` : plain(o) };
    case "reopen_summary":
      m = o.match(/^reopened (\d+) of (\d+); (\d+) decisions not re-run/);
      return { title: m ? `Reopened ${m[1]} of ${plural(m[2], "decision")}` : "Finished checking", detail: m ? `${plural(m[3], "decision")} did not need re-running.` : plain(o) };
    case "model_unavailable": return { title: "No model available: used the rule-based path", detail: cap(o.replace(/^rule-based path \((.+)\)$/, "$1")) };
    case "approve":
      if (/^written via zetaris/.test(o)) return { title: "Approved by a person", detail: "Written to the decision ledger in Zetaris." };
      if (/^written via sample/.test(o)) return { title: "Approved by a person", detail: "Written to the local sample ledger (sample mode, not Zetaris)." };
      if (/^written via/.test(o)) return { title: "Approved by a person", detail: "Written to the decision ledger." };
      return { title: "Approved by a person", detail: cap(o.replace(/^approved but NOT written: /, "Approved, but not written to the ledger: ")) };
    case "run_failed": return { title: "The run failed", detail: o };
    case "read_table": return { title: `Zetaris read the ${TABLE[arg] ?? arg}`, detail: plain(o) };
    case "apply_change": return { title: `Zetaris wrote the change into the ${TABLE[arg] ?? arg}`, detail: plain(o) };
    case "changes_since": return { title: "Zetaris checked for new data", detail: plain(o) };
    case "restore": return { title: `Zetaris restored the ${TABLE[arg] ?? arg}`, detail: plain(o) };
    case "write_change":
    case "write_whatif":
    case "restore_data": {
      m = o.match(/^(.+) in the (\w+) data: (.*)$/);
      const where = m ? DATA_SRC[m[2]] ?? m[2] : "the data layer";
      const rows = m && m[3] !== "no rows differed" ? m[3].split(", ").map(rowText) : [];
      const title = kind === "restore_data" ? "Put the bundled data back" : kind === "write_whatif" ? `Wrote the what-if: ${m?.[1] ?? "a change"}` : "Wrote the change";
      return { title, detail: rows.length ? `Changed in ${where}: ${rows.join(", ")}. The Watcher checks only decisions that read ${rows.length === 1 ? "this row" : "these rows"}.` : `Nothing in ${where} differed, so no decision needs re-checking.` };
    }
  }
  m = a.match(/^model_call_(\w+)$/);
  if (m) return { title: `Asked the ${MODEL_TIER[m[1]] ?? `${m[1]} model`}`, detail: o.replace(/^nvidia\//, "NVIDIA ").replace(/ \(thinking on\)$/, ", with deep thinking on") };
  if (ZETARIS[a]) return { title: ZETARIS[a], detail: plain(o) };
  return { title: cap(plain(a)), detail: plain(o) };
}
/** Write result from the approve call, in words. */
export function writeText(w: WriteResult | undefined) {
  if (!w) return "";
  if (w.written && /^sample/.test(String(w.method))) return "Saved to the local sample ledger. This is sample mode, so nothing was written to Zetaris.";
  if (w.written && !/^zetaris/.test(String(w.method ?? "zetaris"))) return "Saved to the decision ledger.";
  if (w.written) { const n = (String(w.detail).match(/read back (\d+) row/) || [])[1]; return `Saved to the decision ledger in Zetaris${n ? ` and read back to confirm (${plural(n, "row")})` : ""}.`; }
  return cap(String(w.detail || "The ledger write did not happen."));
}

/** What is happening right now, from the latest trace event. */
export const nowText = (e: TraceEvent) => {
  const a = String(e.action || "");
  return NOW[a] ?? (a.startsWith("query:") ? `Analyst is reading ${tplName(a.slice(6))}` : a.startsWith("verify:") ? `Evidence Critic is re-running ${tplName(a.slice(7))} to make sure it gives the same result` : `${pretty(e.agent_name)}: ${say(e).title}`);
};

/** A reason the reviewer can accept, edit or replace. It is assembled in the browser from what the agents
 *  already produced (verdict, risk flags, tripwires, the Decider's rationale); no extra model call is made. */
export function suggestReason(d: Decision) {
  const v = verdictName(d.decision), c = pct(d.confidence ?? 0);
  // Numbered flags first: they say the most in the fewest words.
  const flags = readReasons(d.escalation_reasons).sort((a, b) => Number(!a.value) - Number(!b.value));
  const tw = (d.tripwires || []).slice(0, 2).map((t) => `${metricName(t.metric).toLowerCase()} ${OP[t.op] ?? t.op}${t.threshold != null && t.op !== "changed" ? ` ${fmtMetric(t.metric, t.threshold)}` : ""}`);
  const first = (String(d.rationale || "").match(/^(.+?[.!?])(\s|$)/) || [])[1];
  const why = flags.length
    ? `${flags.slice(0, 3).map((f) => f.value ? `${f.name.toLowerCase()} is ${f.value} (${f.rule})` : f.name.toLowerCase()).join(", ")}.`
    : first && first.length < 220 && !/^Rule-based/i.test(first) ? first : `Risk is ${d.risk || "not graded"} and the evidence checks out.`;
  return `${d.escalated ? "Reviewed the escalation and agree" : "Agree"} with ${v} at ${c} confidence: ${why.charAt(0).toLowerCase() + why.slice(1)}${tw.length ? ` Reopen if ${tw.join(" or ")}.` : ""}`;
}
