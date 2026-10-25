// Tripwire console: decide → review and approve → change data → watch what reopens.
TW.mountNav("console");
TW.renderModes(document.getElementById("modes"));

const $ = (id) => document.getElementById(id);
const esc = TW.esc;
const LABEL = { keep: "Keep", dual_source: "Dual-source", exit: "Exit" };
const VERB = { keep: "Keep this supplier as it is.", dual_source: "Add a second supplier alongside this one.", exit: "Move this spend to other suppliers." };
const METRIC = {
  current_ratio: ["Current ratio", "ratio"],
  debt_to_equity: ["Liabilities to equity", "ratio"],
  gross_margin: ["Gross margin", "share"],
  revenue_change_pct: ["Revenue change across reported periods", "pct"],
  spend_share: ["Share of our category spend", "share"],
  lead_time_weeks: ["Lead time", "weeks"],
  category_alternatives: ["Other suppliers in the category", "count"],
};
const FIELD = { spend_share: "Spend share", open_po_value: "Open orders", lead_time_weeks: "Lead time", annual_spend: "Annual spend", revenue: "Revenue", current_assets: "Current assets", current_liabilities: "Current liabilities", total_liabilities: "Total liabilities", equity: "Equity", gross_profit: "Gross profit" };
const OP = { ">": "rises above", ">=": "reaches", "<": "falls below", "<=": "falls to", "==": "equals", changed: "changes at all" };
const TIP = {
  confidence: "How sure the Decider is, from 0 to 100%. Low confidence on a risky call is a reason to escalate.",
  risk: "Graded in code by the Risk Officer from the metrics, not by a model.",
  evidence: "Each finding names the approved SQL query it came from and a hash of the exact result. If the data changes, the hash no longer matches.",
  tripwire: "A condition on a specific data row. When that row changes, the Watcher re-checks the condition in code. If it fires, the decision is reopened.",
  escalated: "Risky or low-confidence decisions go to a senior buyer. Approving one needs a written reason.",
  status: "proposed → approved or rejected by a human. A reopened decision marks the old one superseded.",
};
// What each key number means, for the tooltips on the number tiles and tripwires.
const METRIC_TIP = {
  current_ratio: "Current assets divided by current liabilities, from the latest SEC filing. Below 1 means the bills due within a year are bigger than what the company can quickly turn into cash.",
  debt_to_equity: "Total liabilities divided by shareholders' equity, from the latest SEC filing. Above 3 means the company is funded mostly by what it owes.",
  gross_margin: "Gross profit divided by revenue: how much of each sale is left after the direct cost of making it. Below 10% leaves little cushion for shocks.",
  revenue_change_pct: "How much revenue changed from the oldest to the newest reported period we hold. A fall of more than 10% is a warning sign.",
  spend_share: "Of everything we spend in this category, the share that goes to this supplier. 25% or more counts as heavy dependence.",
  lead_time_weeks: "Weeks from placing an order to delivery. 12 weeks or more makes switching or recovering slow.",
  category_alternatives: "How many other suppliers we already buy this category from. Zero means there is nowhere to move the work.",
};
const SVG = (d, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  check: SVG('<path d="M20 6 9 17l-5-5"/>', 3),
  wire: SVG('<path d="M2 16h6M16 16h6M8 16l4-9 4 9"/>', 2.4),
  warn: SVG('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01"/>'),
  arrow: SVG('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.2-6.5a1 1 0 0 0 0-1.7L9.5 4.6A1 1 0 0 0 8 5.5Z"/></svg>',
  chev: SVG('<path d="m9 6 6 6-6 6"/>'),
  bulb: SVG('<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2Z"/>'),
  file: SVG('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
  trend: SVG('<path d="m3 17 6-6 4 4 8-8M15 7h6v6"/>'),
  clock: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  agents: SVG('<circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M2 20c0-3.3 2.7-6 6-6s6 2.7 6 6M14 20c0-2.5 1.3-4.5 3-4.5s3 2 3 4.5"/>'),
  person: SVG('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>'),
  db: SVG('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
  shield: SVG('<path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6Z"/><path d="m9 12 2 2 4-4"/>'),
  empty: SVG('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 10h18M8 15h5"/>', 1.8),
};
const VICON = { keep: IC.shield, dual_source: IC.agents, exit: SVG('<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>') };

let selected = null;
let suppliers = [];
let lastTrace = [];

const titleCase = (s) => String(s || "").toLowerCase()
  .replace(/(^|[\s.\-&/])([a-z])/g, (m, a, b) => a + b.toUpperCase())
  .replace(/[\s,]+(incorporated|inc|corporation|corp|company|co|ltd|plc|llc|n\.v|holdings?)\.?$/i, "").trim();
const sup = (id) => suppliers.find((s) => s.supplier_id === id);
const supName = (id) => sup(id)?.short || id;
const initials = (id) => (supName(id) || id).replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const pct = (v) => `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0)}%`;
function fmtMetric(metric, v) {
  if (typeof v !== "number") return esc(v ?? "");
  const u = METRIC[metric]?.[1];
  if (u === "share") return pct(v);
  if (u === "pct") return `${+v.toFixed(1)}%`;
  if (u === "weeks") return `${v} wk`;
  return Math.abs(v) >= 1e5 ? v.toLocaleString() : String(+v.toFixed(2));
}
function fmtField(field, v) {
  if (v === null || v === undefined) return "none";
  if (field === "spend_share") return pct(v);
  if (field === "lead_time_weeks") return `${v} wk`;
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(+Number(v).toFixed(2));
}
const info = (key) => `<span class="info" tabindex="0" data-tip="${esc(TIP[key])}">i</span>`;
const empty = (text) => `<div class="none">${IC.empty}${text}</div>`;
const swap = (el, html) => { el.innerHTML = html; el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter"); };
const ring = (v, cls = "ring") => `<svg viewBox="0 0 36 36"><circle class="t" cx="18" cy="18" r="15.9" pathLength="100"/><circle class="v" cx="18" cy="18" r="15.9" pathLength="100" stroke-dasharray="${v} 100"/></svg>`;
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");

// ---------- Plain English: codes from the data and the agents, turned into words ----------
const TEMPLATE = {
  supplier_spend_row: "our spend record",
  supplier_financials_latest: "latest SEC financials",
  supplier_financials_history: "financial history",
  category_concentration: "category spend split",
  decisions_for_supplier: "past decisions",
};
const TABLE = { supplier_spend: "spend table", supplier_financials: "financials table", tripwire_decisions: "decision ledger" };
const tplName = (t) => TEMPLATE[t] ?? String(t || "").replace(/_/g, " ");
const metricName = (m) => METRIC[m]?.[0] ?? String(m || "").replace(/_/g, " ");
const verdictName = (v) => LABEL[v] ?? String(v || "").replace(/_/g, " ");
const cap = (s) => String(s || "").replace(/^./, (c) => c.toUpperCase());
const plural = (n, one, many = `${one}s`) => `${n} ${Number(n) === 1 ? one : many}`;
const supByCik = (k) => suppliers.find((s) => s.cik != null && String(s.cik) === String(k));
/** DEC-SUP-06-jozqki → "Kemet's decision". */
function decName(id) { const m = String(id || "").match(/^DEC-(SUP-\d+)-/); return m ? `${supName(m[1])}'s decision` : String(id || ""); }
/** One data row in words: supplier_financials:898293 → "Jabil's SEC filings". */
function rowName(table, key) {
  if (table === "supplier_financials") { const s = supByCik(key); return s ? `${s.short}'s SEC filings` : `SEC filings of company ${key}`; }
  if (table === "supplier_spend") return `${supName(key)}'s spend record`;
  if (table === "tripwire_decisions") return decName(key);
  return `${String(table).replace(/_/g, " ")} row ${key}`;
}
const rowTip = (table, key) => table === "supplier_financials" ? `SEC company ID (CIK) ${key}, in the ${TABLE[table]}` : `Row ${key} in the ${TABLE[table] ?? table}`;

// Risk flags exactly as the Risk Officer writes them (app/agents/risk.ts), with the rule and what it means.
const FLAG = [
  [/^current ratio (\S+) < 1$/, "current_ratio", "should be at least 1", "Its short-term assets don't cover the bills due within a year."],
  [/^liabilities\/equity (\S+) > 3$/, "debt_to_equity", "should be 3 or less", "It owes a lot compared with what its owners have put in."],
  [/^gross margin (\S+) < 0\.1$/, "gross_margin", "should be at least 10%", "It keeps very little from each sale, so it has little cushion for shocks."],
  [/^revenue change (\S+)% < -10%$/, "revenue_change_pct", "shouldn't fall by more than 10%", "Its sales are shrinking fast."],
  [/^spend share (\S+) ≥ 0\.25$/, "spend_share", "should stay under 25%", "A large slice of this category's spend rides on this one supplier."],
  [/^lead time (\S+) weeks ≥ 12$/, "lead_time_weeks", "should be under 12 weeks", "Replacing or restocking them would take a quarter or more."],
];
const FIXED = {
  "no alternative supplier in category": ["No other supplier in this category", "If this supplier fails, there is nowhere to move the work."],
  "prior decision relied on data that has since changed": ["Earlier decision used data that has since changed", "What we knew before is out of date, so this needs a fresh look."],
  "guard model flagged the rationale": ["Safety check flagged the reasoning", "A separate guard model objected to the written rationale."],
  "exit decisions always go to a senior buyer": ["Exit always needs a senior buyer", "Dropping a supplier is a policy decision, whatever the numbers say."],
};
/** One risk flag or escalation reason → { name, value, rule, meaning, group }. */
function readFlag(raw) {
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
const readReasons = (list) => (list || []).flatMap((r) => String(r).split("; ")).filter(Boolean).map(readFlag);
const flagText = (f) => `${f.name}${f.value ? ` ${f.value}` : ""}${f.rule ? ` (${f.rule})` : ""}`;

/** Tripwire text from the agents: "debt_to_equity > 5 (now 4.138, was 4.138)" → "Liabilities to equity rises above 5 (now 4.14, was 4.14)". */
function wireText(s) {
  return String(s).replace(/\b([a-z_]+) (>=|<=|>|<|==|changed) *(-?[\d.]+(?:e-?\d+)?)? *(?:\(now (\S+?), was (\S+?)\))?/g, (all, m, op, th, now, was) => {
    if (!METRIC[m]) return all;
    const f = (x) => x === undefined || x === "undefined" ? "unknown" : fmtMetric(m, Number(x));
    return `${metricName(m)} ${OP[op] ?? op}${th !== undefined && op !== "changed" ? ` ${f(th)}` : ""}${now !== undefined ? ` (now ${f(now)}, was ${f(was)})` : ""}`.trim();
  });
}
/** Catch-all for any remaining codes inside agent text. */
function plain(s) {
  return wireText(String(s ?? ""))
    .replace(/\b(supplier_financials|supplier_spend|tripwire_decisions):([\w-]+)/g, (_, t, k) => rowName(t, k))
    .replace(/\bDEC-SUP-\d+-\w+/g, decName)
    .replace(/\b(dual_source|keep|exit) @ ([\d.]+)/g, (_, v, c) => `${verdictName(v)} at ${pct(Number(c))} confidence`)
    .replace(/\bdual_source\b/g, "Dual-source")
    .replace(/\bhash ([0-9a-f]{8,})/g, "result fingerprint $1")
    .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (w) => TEMPLATE[w] ?? (METRIC[w] ? metricName(w) : w.replace(/_/g, " ")));
}
const numsList = (s) => String(s).split(/,\s*/).filter(Boolean).join(", ");
/** Why the Critic sent work back, in words. */
function issueText(s) {
  return String(s).split(" | ").map((x) => {
    let m = x.match(/^(?:rationale cites )?numbers not in the evidence: (.+)$/);
    if (m) return `It quotes numbers that no query produced: ${numsList(m[1])}.`;
    m = x.match(/^"keep" at ([\d.]+) confidence ignores high-risk flags \((.+)\); justify or lower confidence$/);
    if (m) return `It says Keep at ${pct(Number(m[1]))} confidence but ignores red flags (${m[2].split("; ").map((f) => flagText(readFlag(f))).join("; ")}).`;
    return cap(plain(x)) + (/[.!?]$/.test(x) ? "" : ".");
  }).join(" ");
}
const MODEL_TIER = { small: "fast model", reasoning: "reasoning model", guard: "safety guard model" };
const DATA_SRC = { zetaris: "live data in Zetaris", sample: "the bundled sample data" };
const GUARD = { safe: "The guard model saw no problem.", unsafe: "The guard model raised a concern.", unknown: "The guard model gave no clear verdict, so the code rules decide." };
const ZETARIS = { health: "Zetaris health check", write_decision: "Zetaris wrote the decision to the ledger", verify_decision: "Zetaris read the ledger back to confirm the write", read_decisions: "Zetaris read the decision ledger" };

/** A trace event in words: { title, detail }. The raw text stays on hover for anyone who wants it. */
function say(e) {
  const a = String(e.action || ""), o = String(e.output_summary || ""), fail = e.status === "failed";
  const [kind, arg] = a.includes(":") ? [a.slice(0, a.indexOf(":")), a.slice(a.indexOf(":") + 1)] : [a, ""];
  let m;
  switch (kind) {
    case "start_decision":
    case "reopen_decision": {
      const src = (o.match(/data: (\w+)/) || [])[1], sup2 = (o.match(/supersedes (\S+)/) || [])[1];
      return { title: kind === "start_decision" ? "Started a new decision" : "Reopened an earlier decision", detail: `Using ${DATA_SRC[src] ?? src ?? "the data layer"}${sup2 ? `. This will replace ${decName(sup2)}.` : "."}` };
    }
    case "plan": {
      const [steps, ...rest] = o.split(" | ");
      const extra = rest.map((p) => p.replace(/^focus: /, "Focus: ").replace(/^policy added: (.+)/, (_, x) => `Added by policy: ${x.split(", ").map(tplName).join(", ")}`));
      return { title: "Chose which approved queries to run", detail: [steps.split(" → ").map(tplName).join(" → "), ...extra].join(". ") };
    }
    case "drop_unknown_steps": return { title: "Ignored steps that are not approved queries", detail: o.replace(/^ignored: /, "Ignored: ") };
    case "query":
      if (fail) return { title: `Couldn't read ${tplName(arg)}${e.retry_count ? `, retrying` : ""}`, detail: o };
      m = o.match(/^(\d+) rows/);
      return { title: `Read ${tplName(arg)}`, detail: `${m ? plural(m[1], "row") : "Result"} returned${/sample data/.test(o) ? " from the sample data" : ""}. A fingerprint of the result is kept so the number can be re-checked later.` };
    case "template": return { title: `Zetaris ran the ${tplName(arg)} query`, detail: o.replace(/(\d+) rows in (\d+) ms/, (_, n, ms) => `${plural(n, "row")} in ${Number(ms).toLocaleString()} ms`) };
    case "verify":
      return e.status === "success"
        ? { title: `Double-checked ${tplName(arg)}`, detail: "Re-ran the query and got exactly the same result, so the numbers stand." }
        : { title: `Double-checked ${tplName(arg)}: unstable`, detail: "The result was different on a re-run." };
    case "reject_evidence": return { title: "Sent the analysis back: the data changed mid-run", detail: `Re-running ${tplName((o.match(/^REJECT (\S+):/) || [])[1])} gave a different result, so the Analyst starts again on fresh data.` };
    case "review_memory": {
      if (e.status === "success") return { title: "Checked what memory recalled", detail: cap(o.replace(/(\d+) recalled claims still match today's evidence/, (_, n) => `${plural(n, "remembered claim")} still match today's data.`)) };
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
      return { title: `Graded the risk: ${m[1]}`, detail: `${flags.length ? `Red flags: ${flags.join("; ")}.` : "No red flags."} ${m[3] === "ON" ? "Deep thinking is on for the Decider." : "Deep thinking is not needed."}` };
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
      return { title: "Approved by a person", detail: /^written via/.test(o) ? "Written to the decision ledger in Zetaris." : cap(o.replace(/^approved but NOT written: /, "Approved, but not written to the ledger: ")) };
    case "run_failed": return { title: "The run failed", detail: o };
    case "read_table": return { title: `Zetaris read the ${TABLE[arg] ?? arg}`, detail: plain(o) };
    case "apply_change": return { title: `Zetaris wrote the change into the ${TABLE[arg] ?? arg}`, detail: plain(o) };
    case "changes_since": return { title: "Zetaris checked for new data", detail: plain(o) };
  }
  m = a.match(/^model_call_(\w+)$/);
  if (m) return { title: `Asked the ${MODEL_TIER[m[1]] ?? `${m[1]} model`}`, detail: o.replace(/^nvidia\//, "NVIDIA ").replace(/ \(thinking on\)$/, ", with deep thinking on") };
  if (ZETARIS[a]) return { title: ZETARIS[a], detail: plain(o) };
  return { title: cap(plain(a)), detail: plain(o) };
}
/** Write result from the approve call, in words. */
function writeText(w) {
  if (!w) return "";
  if (w.written) { const n = (String(w.detail).match(/read back (\d+) row/) || [])[1]; return `Saved to the decision ledger in Zetaris${n ? ` and read back to confirm (${plural(n, "row")})` : ""}.`; }
  return cap(String(w.detail || "The ledger write did not happen."));
}

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.detail || body.error || r.statusText), { body });
  return body;
}

let toastT;
function toast(html, ms = 7000) {
  document.querySelector(".toast")?.remove();
  const t = Object.assign(document.createElement("div"), { className: "toast", role: "status" });
  t.innerHTML = `<div>${html}</div><button type="button" aria-label="Dismiss">×</button>`;
  const close = () => { t.classList.add("out"); setTimeout(() => t.remove(), 250); };
  t.querySelector("button").onclick = close;
  document.body.appendChild(t);
  clearTimeout(toastT); toastT = setTimeout(close, ms);
}

const STEPS = ["step-decide", "step-review", "step-change"];
function chips() {
  for (const id of STEPS) {
    const el = $(id);
    el.querySelector("[data-chip]").textContent = el.classList.contains("active") ? "Now" : el.classList.contains("done") ? "Done" : "Next";
  }
}
function setStep(n) { STEPS.forEach((id, i) => $(id).classList.toggle("active", i + 1 === n)); chips(); }
function markDone(id) { $(id).classList.add("done"); chips(); }

// ---------- Step 1: suppliers ----------
async function loadSuppliers() {
  suppliers = (await api("/suppliers").catch(() => [])).map((s) => ({ ...s, short: titleCase(s.name) || s.supplier_id }));
  if (!suppliers.length) for (let i = 1; i <= 20; i++) suppliers.push({ supplier_id: `SUP-${String(i).padStart(2, "0")}`, short: "" });
  const s = $("supplier");
  s.innerHTML = suppliers.map((x) => `<option value="${esc(x.supplier_id)}">${esc(x.supplier_id)} · ${esc(x.short)}</option>`).join("");
  const want = new URLSearchParams(location.search).get("supplier");
  s.value = suppliers.some((x) => x.supplier_id === want) ? want : "SUP-18";
  s.onchange = () => supMeta(true);
  supMeta();
}
let decisionsCache = [];
function supMeta(animate) {
  const id = $("supplier").value, x = sup(id);
  const prior = decisionsCache.find((d) => d.subject_id === id && d.status !== "superseded" && d.status !== "rejected");
  const el = $("sup-meta");
  const cat = x?.category ? String(x.category).replace(/_/g, " ") : "";
  el.innerHTML = `
    <div class="sc-head">
      <span class="avatar">${esc(initials(id))}</span>
      <div class="sc-id"><span class="nm">${esc(x?.short || id)}</span><span class="mt"><span class="mono">${esc(id)}</span>${x?.ticker ? `<span class="dotsep"></span><span tabindex="0" data-tip="Stock ticker">${esc(x.ticker)}</span>` : ""}</span>${cat ? `<span class="cat" tabindex="0" data-tip="Purchase category this supplier sells us">${esc(cat)}</span>` : ""}</div>
    </div>
    ${typeof x?.spend_share === "number" ? `<div class="sc-stats">
      <div class="stat share"><span class="k term" tabindex="0" data-tip="Of everything we spend in this category, how much goes to this supplier (synthetic data). Above 25% counts as heavy dependence.">Share of category spend</span><b>${pct(x.spend_share)}</b><span class="bar"><i></i><em style="left:25%" title="25%: heavy-dependence line"></em></span></div>
      ${typeof x.lead_time_weeks === "number" ? `<div class="stat"><span class="k term" tabindex="0" data-tip="Weeks from placing an order to delivery. 12 weeks or more makes switching slow.">Lead time</span><b>${x.lead_time_weeks} wk</b></div>` : ""}
    </div>` : ""}
    ${prior ? `<div class="prior"><span>Already decided</span><span class="verdict ${esc(prior.decision)}">${LABEL[prior.decision] ?? esc(prior.decision)}</span><span class="st ${esc(prior.status)}">${esc(prior.status)}</span></div>` : ""}`;
  if (animate) { el.classList.remove("swap"); void el.offsetWidth; el.classList.add("swap"); }
  requestAnimationFrame(() => { const i = el.querySelector(".share i"); if (i) i.style.width = `${Math.min(100, x.spend_share * 100)}%`; });
}

// ---------- Step 2: decisions list ----------
async function loadDecisions() {
  const list = await api("/decisions").catch(() => []);
  list.sort((a, b) => (a.status === "superseded") - (b.status === "superseded"));
  decisionsCache = list;
  const live = list.filter((d) => d.status !== "superseded" && d.status !== "rejected").length;
  $("dcount").textContent = live;
  $("decisions").innerHTML = list.length ? list.map((d, i) => {
    const conf = Math.round((d.confidence ?? 0) * 100);
    return `
    <button class="dcard enter ${esc(d.decision)} ${d.decision_id === selected ? "sel" : ""} ${d.status === "superseded" || d.status === "rejected" ? "old" : ""}" style="--i:${Math.min(i, 8)}" data-id="${esc(d.decision_id)}" type="button">
      <span class="who">${esc(supName(d.subject_id))}<small>${esc(d.subject_id)}</small></span>
      <span class="mini-ring" title="${conf}% confident">${ring(conf)}${conf}%</span>
      <span class="tags"><span class="verdict ${esc(d.decision)}">${LABEL[d.decision] ?? esc(d.decision)}</span><span class="st ${esc(d.status)}">${esc(d.status)}</span>${d.escalated ? `<span class="st esc">escalated</span>` : ""}</span>
    </button>`;
  }).join("") : empty("No decisions yet. Make one in step 1.");
  for (const el of $("decisions").querySelectorAll(".dcard")) el.onclick = () => openDecision(el.dataset.id);
  if (list.some((d) => d.status === "approved")) markDone("step-review");
  supMeta();
  return list;
}

// ---------- Step 3: change files ----------
async function loadChanges() {
  let cat = await api("/changes/catalog").catch(() => null);
  if (!cat) cat = (await api("/changes").catch(() => [])).map((f) => ({ file: f, description: f }));
  $("changes").innerHTML = cat.map((c, i) => {
    const name = c.file.replace(/\.json$/, "").replace(/^\d+_/, "").replace(/_/g, " ");
    const about = String(c.description).replace(/^SYNTHETIC:\s*/i, "").replace(/\s*Figures from (https?:\S+)/, "").replace(/^./, (m) => m.toUpperCase());
    const who = c.supplier_id || (c.table === "supplier_spend" ? c.key : null);
    const fields = (c.fields || []).filter((f) => f.before !== f.after).slice(0, 3);
    const ico = c.table === "supplier_financials" ? IC.file : /lead/.test(c.file) ? IC.clock : IC.trend;
    return `<div class="ccard enter" style="--i:${i}" data-card="${esc(c.file)}">
      <span class="cc-ico">${ico}</span>
      <div class="cc-t">${esc(name.charAt(0).toUpperCase() + name.slice(1))}<span class="tg ${c.synthetic ? "synthetic" : "real"}" data-tip="${c.synthetic ? "A made-up change to synthetic spend data, to show the mechanism." : "Based on a real SEC filing."}" tabindex="0">${c.synthetic ? "synthetic" : "real filing"}</span></div>
      <div class="cc-who">${who ? `<b>${esc(supName(who))}</b><span class="mono">${esc(who)}</span>` : ""}${c.table ? `<span class="watch" data-tip="${esc(`The exact data row this change rewrites (${rowTip(c.table, c.key)}). Only decisions that read this row are checked.`)}" tabindex="0">${IC.db}${esc(rowName(c.table, c.key))}</span>` : ""}</div>
      ${fields.length ? `<div class="deltas">${fields.map((f) => `<div class="delta"><span class="l">${esc(FIELD[f.field] ?? f.field.replace(/_/g, " "))}</span><s>${esc(fmtField(f.field, f.before))}</s><span class="arr">→</span><b>${esc(fmtField(f.field, f.after))}</b></div>`).join("")}</div>` : ""}
      <div class="cc-foot"><details><summary>Details</summary></details><button class="btn sm primary" data-f="${esc(c.file)}" type="button" ${i === 0 ? 'id="first-change"' : ""}>Apply</button></div>
      <p class="cc-about" hidden>${esc(about)}</p>
    </div>`;
  }).join("") || empty("No change files found.");
  for (const b of $("changes").querySelectorAll("button[data-f]")) b.onclick = () => applyChange(b.dataset.f, b);
  for (const d of $("changes").querySelectorAll(".cc-foot details")) d.ontoggle = () => { d.closest(".ccard").querySelector(".cc-about").hidden = !d.open; };
}

// ---------- Centre: start ----------
function renderStart() {
  actionBar(null);
  selected = null;
  swap($("detail"), `
    <div class="start">
      <div class="eyebrow">Start here</div>
      <h2>Make a decision, then change the data under it.</h2>
      <p>Agents decide whether to keep, dual-source or exit a supplier, and record which data rows each decision used. Change one of those rows and only the affected decisions reopen.</p>
      <div class="loop">
        <div><span class="ic">${IC.agents}</span><b>Agents decide</b><span>Six agents query, check each other and propose</span></div>
        <div><span class="ic">${IC.person}</span><b>You approve</b><span>Nothing is final until a person signs off</span></div>
        <div><span class="ic">${IC.db}</span><b>Data changes</b><span>A new filing or a spend shift lands</span></div>
        <div><span class="ic">${IC.wire}</span><b>Tripwire checks</b><span>Only dependent decisions are re-checked</span></div>
      </div>
      <div class="eyebrow" style="margin-bottom:10px">Quick start</div>
      <div class="quick">
        <button class="qcard risky enter" style="--i:1" type="button" data-q="SUP-18"><span class="qi">${IC.warn}</span><b>Risky supplier</b><span class="s">${esc(supName("SUP-18"))} · SUP-18</span><span class="exp">Weak financials. Expect exit or dual-source, escalated.</span><span class="go">Run it ${IC.arrow}</span></button>
        <button class="qcard healthy enter" style="--i:2" type="button" data-q="SUP-17"><span class="qi">${IC.shield}</span><b>Healthy supplier</b><span class="s">${esc(supName("SUP-17"))} · SUP-17</span><span class="exp">No red flags. Expect keep.</span><span class="go">Run it ${IC.arrow}</span></button>
        <button class="qcard wire enter" style="--i:3" type="button" data-q="SUP-06" data-then="change"><span class="qi">${IC.wire}</span><b>Test a tripwire</b><span class="s">${esc(supName("SUP-06"))} · SUP-06</span><span class="exp">Decide, then apply the spend share jump.</span><span class="go">Run it ${IC.arrow}</span></button>
      </div>
    </div>`);
  for (const b of $("detail").querySelectorAll("[data-q]")) b.onclick = () => pick(b.dataset.q, b.dataset.then === "change");
}
function pick(id, thenChange) { $("supplier").value = id; supMeta(true); decide(thenChange); }

// ---------- Centre: live run ----------
const STAGES = [
  ["Planner", "Pl", "Picks the approved queries"],
  ["Analyst", "An", "Runs them, computes metrics"],
  ["EvidenceCritic", "Cr", "Checks every number"],
  ["MemoryKeeper", "Me", "Recalls, drops stale claims"],
  ["RiskOfficer", "Ri", "Grades risk in code"],
  ["Decider", "De", "Chooses, sets tripwires"],
];
const NOW = {
  start_decision: "Starting the run and handing the question to the Planner",
  plan: "Planner is choosing which approved queries to run",
  check_summary: "Evidence Critic is checking the summary against the numbers",
  recall: "Memory Keeper is recalling earlier claims about this supplier",
  drop_stale: "Memory Keeper is dropping claims whose data has changed",
  assess_risk: "Risk Officer is grading risk from the metrics",
  propose_decision: "Decider is choosing keep, dual-source or exit, and drafting tripwires",
  review_decision: "Evidence Critic is reviewing the draft decision",
  final_check: "Risk Officer is running the final guard and escalation check",
  remember: "Memory Keeper is saving claims with their data lineage",
  decision_proposed: "Done. Loading the decision…",
  lineage_lookup: "Watcher is asking memory which decisions read the changed row",
  check_tripwires: "Watcher is re-checking the tripwires of dependent decisions",
  reopen_summary: "Watcher is summarising what reopened",
};
const TIPS = [
  "Every number in the decision links to the <b>SQL query</b> and a <b>hash</b> of its exact result.",
  "The <b>Evidence Critic</b> can send work back. Pushbacks show up in red in the trace.",
  "<b>Risk</b> is graded in plain code, not by a model, so it can't be talked out of a red flag.",
  "A <b>tripwire</b> is a condition on a specific row. Change that row and only its decisions are re-checked.",
  "If a model is unavailable, a labelled <b>rule-based fallback</b> decides. It is never passed off as a model answer.",
];
const nowText = (e) => NOW[e.action] ?? (String(e.action || "").startsWith("query:") ? `Analyst is reading ${tplName(e.action.slice(6))}` : String(e.action || "").startsWith("verify:") ? `Evidence Critic is re-running ${tplName(e.action.slice(7))} to make sure it gives the same result` : `${pretty(e.agent_name)}: ${say(e).title}`);

function renderRun(title, sub, kind = "decide") {
  actionBar(null);
  const stages = kind === "decide" ? STAGES : [["Watcher", "Wa", "Finds dependent decisions"], ["Planner", "Pl", "Re-plans reopened ones"], ["Analyst", "An", "Re-runs queries"], ["EvidenceCritic", "Cr", "Re-checks numbers"], ["RiskOfficer", "Ri", "Re-grades risk"], ["Decider", "De", "Proposes again"]];
  swap($("detail"), `
    <div class="run" data-kind="${kind}">
      <div class="run-head">
        <span>${TW.LOADER}</span>
        <div><div class="eyebrow"><span class="live">Live</span></div><h2>${title}</h2><div class="muted" style="font-size:13px">${sub}</div></div>
        <span class="t" id="elapsed">0s</span>
      </div>
      <div class="relay" id="relay"><span class="fill"></span><span class="spark" style="left:8.33%"></span>
        ${stages.map(([a, ab, d], i) => `<div class="ag" data-a="${a}" data-i="${i}"><span class="av">${ab}${IC.check.replace("<svg", '<svg class="ck"')}</span><b>${esc(pretty(a))}</b><span>${d}</span><span class="think"><i></i><i></i><i></i></span></div>`).join("")}
      </div>
      <div class="now" id="now"><span class="spin"></span><div class="tx">Sending the request…</div></div>
      <div class="counters">
        <div class="counter"><b id="c-q">0</b><span>queries run</span></div>
        <div class="counter"><b id="c-ok">0</b><span>checks passed</span></div>
        <div class="counter"><b id="c-push">0</b><span>pushbacks</span></div>
        <div class="counter"><b id="c-ev">0</b><span>trace steps</span></div>
      </div>
      <div class="feed" id="feed"></div>
      <div class="tipcard">${IC.bulb}<div class="tx" id="tip">${TIPS[0]}</div></div>
    </div>`);
}

/** Polls the server's live trace for run_id and drives the run view. Returns a stop function. */
function watchRun(run_id) {
  const t0 = Date.now();
  let seen = 0, tipI = 0, stopped = false;
  const counts = { q: 0, ok: 0, push: 0 };
  renderTrace([]); $("trace-live").classList.add("on");
  const bump = (id, v) => { const el = $(id); if (el && el.textContent !== String(v)) { el.textContent = v; el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); } };
  const tick = setInterval(() => { const el = $("elapsed"); if (el) el.textContent = `${Math.round((Date.now() - t0) / 1000)}s`; }, 250);
  const tips = setInterval(() => { const el = $("tip"); if (!el) return; tipI = (tipI + 1) % TIPS.length; el.outerHTML = `<div class="tx" id="tip">${TIPS[tipI]}</div>`; }, 6000);
  const reached = new Set();
  const apply = (events) => {
    const fresh = events.slice(seen); seen = events.length;
    if (!fresh.length) return;
    renderTrace(fresh, true);
    const relay = $("relay");
    for (const e of fresh) {
      if (e.event === "tool_call" && e.agent_name === "Analyst") counts.q++;
      if (e.event === "critique" && e.status === "success") counts.ok++;
      if (e.status === "needs_revision" || e.event === "retry") counts.push++;
      const node = relay?.querySelector(`[data-a="${e.agent_name}"]`);
      if (node) {
        reached.add(node);
        if (e.status === "needs_revision" || e.event === "retry") { node.classList.remove("push"); void node.offsetWidth; node.classList.add("push"); }
      }
      const feed = $("feed");
      if (feed && e.agent_name !== "Orchestrator") {
        feed.insertAdjacentHTML("afterbegin", `<div class="fe ${e.status === "needs_revision" ? "push" : ""}"><b>${esc(pretty(e.agent_name))}</b><span>${esc(say(e).title)}</span></div>`);
        while (feed.children.length > 4) feed.lastElementChild.remove();
      }
    }
    const last = fresh[fresh.length - 1];
    const next = last.target_agent && relay?.querySelector(`[data-a="${last.target_agent}"]`);
    const cur = next || relay?.querySelector(`[data-a="${last.agent_name}"]`);
    if (next) reached.add(relay.querySelector(`[data-a="${last.agent_name}"]`) ?? next);
    if (relay && cur) {
      for (const n of relay.querySelectorAll(".ag")) { n.classList.toggle("on", n === cur); n.classList.toggle("done", n !== cur && reached.has(n)); }
      const i = Number(cur.dataset.i), x = 8.33 + i * (83.34 / 5);
      relay.querySelector(".spark").style.left = `${x}%`;
      relay.querySelector(".fill").style.width = `${x - 8.33}%`;
    }
    const now = $("now");
    if (now) now.innerHTML = `<span class="spin"></span><div class="tx">${esc(nowText(last))}${say(last).detail ? `<small>${esc(say(last).detail)}</small>` : ""}${next && next.dataset.a !== last.agent_name ? `<small>Handed to the <b>${esc(pretty(last.target_agent))}</b>, which is working on it now${last.target_agent === "Decider" ? ". With thinking on, a model call can take a minute." : "."}</small>` : ""}</div>`;
    bump("c-q", counts.q); bump("c-ok", counts.ok); bump("c-push", counts.push); bump("c-ev", lastTrace.length);
  };
  const poll = async () => {
    if (stopped) return;
    try { apply(await (await fetch(`/trace/${run_id}`)).json()); } catch {}
    if (!stopped) setTimeout(poll, 700);
  };
  setTimeout(poll, 400);
  return async () => {
    stopped = true; clearInterval(tick); clearInterval(tips);
    try { apply(await (await fetch(`/trace/${run_id}`)).json()); } catch {}
    $("trace-live").classList.remove("on");
  };
}

// ---------- Centre: decision ----------
function evidenceFor(d, metric) { return (d.findings || []).find((f) => f.metric === metric && typeof f.value === "number"); }
function gauge(t, d) {
  const name = METRIC[t.metric]?.[0] ?? t.metric.replace(/_/g, " ");
  const cond = `<b>${esc(name)}</b> ${esc(OP[t.op] ?? t.op)}${t.threshold != null && t.op !== "changed" ? ` <b>${fmtMetric(t.metric, t.threshold)}</b>` : ""}`;
  const f = evidenceFor(d, t.metric);
  let track = "", gap = "";
  if (f && typeof t.threshold === "number" && t.op !== "changed") {
    const cur = f.value, th = t.threshold;
    const share = METRIC[t.metric]?.[1] === "share";
    const lo = Math.min(0, cur, th), hi = share ? Math.max(1, cur, th) : Math.max(cur, th) * 1.35 || 1;
    const p = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
    const below = t.op === "<" || t.op === "<=";
    const zone = below ? `left:0;width:${p(th)}%` : `left:${p(th)}%;right:0`;
    track = `<div class="track"><span class="base"></span><span class="zone" style="${zone}"></span><span class="th" style="left:${p(th)}%" data-l="trips at ${fmtMetric(t.metric, th)}"></span><span class="cur" style="left:${p(cur)}%" data-l="now ${fmtMetric(t.metric, cur)}"></span></div>`;
    const dist = Math.abs(cur - th);
    gap = `${fmtMetric(t.metric, dist).replace(/^-/, "")} away`;
  } else if (f) gap = `now ${fmtMetric(t.metric, f.value)}`;
  const rows = (t.depends_on || []).map((r) => rowName(r.table, r.key)).join(" or ") || "its source data";
  const tip = `If ${rows} changes and ${METRIC[t.metric]?.[0]?.toLowerCase() ?? "this value"} ${OP[t.op] ?? t.op}${t.threshold != null && t.op !== "changed" ? ` ${fmtMetric(t.metric, t.threshold)}` : ""}, the Watcher reopens this decision.${f ? ` It is ${fmtMetric(t.metric, f.value)} now.` : ""} ${METRIC_TIP[t.metric] ?? ""}`;
  return `<div class="gauge"><div class="g-t">${IC.wire}<span class="term-ish" tabindex="0" data-tip="${esc(tip.trim())}">${cond}</span><span class="gap" tabindex="0" data-tip="How far the current value is from the line that fires this tripwire.">${esc(gap)}</span></div>${track}
    <div class="rows">${IC.db}Watches ${(t.depends_on || []).map((r) => `<span tabindex="0" data-tip="${esc(rowTip(r.table, r.key))}">${esc(rowName(r.table, r.key))}</span>`).join(", ") || "its source rows"}</div></div>`;
}

const GROUP = { health: "Financial health", exposure: "How much we depend on them", policy: "Policy" };
/** The escalation reasons as readable rows: what was measured, its value, the policy line and what it means. */
function escPanel(d) {
  const flags = readReasons(d.escalation_reasons);
  const groups = Object.keys(GROUP).map((g) => [g, flags.filter((f) => f.group === g)]).filter(([, l]) => l.length);
  return `<section class="esc-panel enter" aria-label="Why this was escalated">
    <div class="esc-h"><span class="esc-ic">${IC.warn}</span><div><b>Escalated: a senior buyer must sign off</b> ${info("escalated")}
      <p>${flags.length ? `The Risk Officer found ${plural(flags.length, "reason")} in code. Each value is compared with a fixed policy line.` : "This decision needs a senior buyer's sign-off."}</p></div></div>
    ${groups.map(([g, list]) => `<div class="esc-g"><div class="esc-gh">${GROUP[g]}</div>${list.map((f) => `
      <div class="flag">
        <div class="f-l"><b>${esc(f.name)}</b>${f.meaning ? `<span>${esc(f.meaning)}</span>` : ""}</div>
        ${f.value ? `<div class="f-r"><b>${esc(f.value)}</b>${f.rule ? `<span>${esc(cap(f.rule))}</span>` : ""}</div>` : ""}
      </div>`).join("")}</div>`).join("")}
  </section>`;
}

function renderDecision(d) {
  selected = d.decision_id;
  const conf = Math.round((d.confidence ?? 0) * 100);
  const fallback = /^Rule-based policy/i.test(d.rationale || "");
  const risk = String(d.risk || "").toLowerCase();
  const segs = { low: 1, medium: 2, high: 3 }[risk] ?? 0;
  const why = String(d.rationale || "");
  const m = why.match(/^(.+?[.!?])(\s|$)/);
  const whyHtml = m && m[1].length < 180 ? `<b>${esc(m[1])}</b>${esc(why.slice(m[1].length))}` : esc(why);
  const watched = new Set((d.tripwires || []).map((t) => t.metric));
  const nums = (d.findings || []).map((f, i) => ({ f, i })).filter(({ f }) => typeof f.value === "number" && f.metric);
  swap($("detail"), `
    <div class="hero-card ${esc(d.decision)}">
      <div>
        <div class="hc-sup"><span class="avatar">${esc(initials(d.subject_id))}</span><b>${esc(supName(d.subject_id))}</b><span class="mono">${esc(d.subject_id)}</span></div>
        <div class="hc-verdict"><span class="vi">${VICON[d.decision] ?? IC.check}</span><div><div class="eyebrow">Recommendation</div><div class="verdict ${esc(d.decision)}">${LABEL[d.decision] ?? esc(d.decision)}</div></div></div>
        <div class="hc-verb">${esc(VERB[d.decision] ?? "")}</div>
      </div>
      <div class="hc-side">
        <div class="gstat" tabindex="0" data-tip="${esc(TIP.confidence)}"><div class="ring">${ring(conf)}<div class="lbl"><b data-count="${conf}">${conf}%</b></div></div><span class="cap">Confidence</span></div>
        <div class="riskm ${esc(risk)}" tabindex="0" data-tip="${esc(TIP.risk)}"><span>Risk</span><b>${esc(risk || "?")}</b><span class="segs">${[0, 1, 2].map((i) => `<i class="${i < segs ? "f" : ""}" style="--i:${i}"></i>`).join("")}</span></div>
      </div>
      <div class="hc-meta">
        <span class="st ${esc(d.status)}" tabindex="0" data-tip="${esc(TIP.status)}">${esc(d.status)}</span>
        ${fallback ? `<span class="pill fallback" tabindex="0" data-tip="No model was available for this run, so a simple rule-based policy decided. It is labelled, never passed off as a model answer."><span class="dot"></span>rule-based fallback</span>` : ""}
        ${d.supersedes ? `<span class="pill" tabindex="0" data-tip="${esc(`This decision was reopened by a tripwire and replaces an earlier one (${d.supersedes}).`)}">replaces ${esc(decName(d.supersedes))}</span>` : ""}
        <span class="id" tabindex="0" data-tip="Decision ID, as stored in the ledger.">${esc(d.decision_id)}</span>
      </div>
    </div>
    ${d.escalated ? escPanel(d) : ""}

    <div class="sec"><div class="sec-h"><h3>Why</h3><span class="line"></span></div>
      <p class="why">${whyHtml}</p>
      ${d.summary ? `<details class="more"><summary>Read the Analyst's summary</summary><p>${esc(d.summary)}</p></details>` : ""}
    </div>

    ${nums.length ? `<div class="sec"><div class="sec-h"><h3>Key numbers</h3>${info("evidence")}<span class="line"></span></div>
      <div class="nums">${nums.map(({ f, i }, k) => `<button class="num enter" style="--i:${k}" type="button" data-ev="${i}" data-tip="${esc(`${METRIC_TIP[f.metric] ?? f.claim}${watched.has(f.metric) ? " A tripwire watches this number." : ""} Click to see the query and its exact result.`)}">${watched.has(f.metric) ? `<span class="w">${IC.wire}</span>` : ""}<span class="v">${fmtMetric(f.metric, f.value)}</span><span class="l">${esc(METRIC[f.metric]?.[0] ?? f.metric.replace(/_/g, " "))}</span><span class="src">From ${esc(tplName(f.evidence?.template_id || ""))} · show proof</span></button>`).join("")}</div>
    </div>` : ""}

    <div class="sec"><div class="sec-h"><h3>Tripwires: reopen if…</h3>${info("tripwire")}<span class="line"></span></div>
      <div class="gauges">${(d.tripwires || []).map((t) => gauge(t, d)).join("") || empty("No tripwires.")}</div>
    </div>

    <div class="sec">
      <details class="ev" id="ev"><summary>${IC.chev}Evidence behind every number<span class="muted">${plural((d.findings || []).length, "finding")}, each with its SQL query and result fingerprint</span></summary>
        <div class="ev-list">${(d.findings || []).map((f, i) => `
          <details class="ev-row" id="ev-${i}"><summary><span>${esc(f.claim)}</span><span class="q">${esc(cap(tplName(f.evidence?.template_id)))}</span></summary>
            <div class="body">
              <pre>${esc(f.evidence?.sql)}</pre>
              <div class="ev-meta"><span tabindex="0" data-tip="A fingerprint (SHA-256 hash) of the exact query result. Re-running the query on unchanged data gives the same fingerprint; any change to the data gives a different one.">Result fingerprint <code>${esc((f.evidence?.result_hash || "").slice(0, 12))}</code></span>${(f.evidence?.depends_on || []).length ? `<span>Reads ${f.evidence.depends_on.map((r) => `<b tabindex="0" data-tip="${esc(rowTip(r.table, r.key))}">${esc(rowName(r.table, r.key))}</b>`).join(", ")}</span>` : ""}</div>
            </div></details>`).join("") || empty("No findings recorded.")}</div>
      </details>
    </div>

    ${(d.limitations || []).length ? `<div class="sec"><div class="sec-h"><h3>Limitations</h3><span class="line"></span></div><ul class="lim">${d.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>` : ""}

    ${d.status === "proposed" ? `<div class="await" tabindex="0" data-tip="Approve or reject in the bar fixed to the bottom of the screen.">${IC.person}<span><b>Waiting for your call.</b> Approve or reject it in the bar at the bottom.</span></div>` : d.status === "approved" ? `<div class="banner ok done-anim"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m7 12.5 3.2 3.2L17 9"/></svg><div><b>Approved.</b> ${esc(d.approved_by_reason || "")}</div></div>` : ""}
    <div id="write-result"></div>`);

  for (const b of $("detail").querySelectorAll(".num[data-ev]")) b.onclick = () => {
    $("ev").open = true;
    const row = $(`ev-${b.dataset.ev}`); row.open = true;
    row.scrollIntoView({ block: "center", behavior: TW.reduced() ? "auto" : "smooth" });
    row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 1400);
  };
  TW.countUp($("detail").querySelector("[data-count]"), conf, { ms: 1000, fmt: (v) => `${Math.round(v)}%` });

  actionBar(d.status === "proposed" ? d : null);
}

// ---------- Bottom action bar: shown only while a decision waits for a person ----------
/** A reason the reviewer can accept, edit or replace. It is assembled in the browser from what the agents
 *  already produced (verdict, risk flags, tripwires, the Decider's rationale); no extra model call is made. */
function suggestReason(d) {
  const v = verdictName(d.decision), c = pct(d.confidence ?? 0);
  // Numbered flags first: they say the most in the fewest words.
  const flags = readReasons(d.escalation_reasons).sort((a, b) => !a.value - !b.value);
  const tw = (d.tripwires || []).slice(0, 2).map((t) => `${metricName(t.metric).toLowerCase()} ${OP[t.op] ?? t.op}${t.threshold != null && t.op !== "changed" ? ` ${fmtMetric(t.metric, t.threshold)}` : ""}`);
  const first = (String(d.rationale || "").match(/^(.+?[.!?])(\s|$)/) || [])[1];
  const why = flags.length
    ? `${flags.slice(0, 3).map((f) => f.value ? `${f.name.toLowerCase()} is ${f.value} (${f.rule})` : f.name.toLowerCase()).join(", ")}.`
    : first && first.length < 220 && !/^Rule-based/i.test(first) ? first : `Risk is ${d.risk || "not graded"} and the evidence checks out.`;
  return `${d.escalated ? "Reviewed the escalation and agree" : "Agree"} with ${v} at ${c} confidence: ${why.charAt(0).toLowerCase() + why.slice(1)}${tw.length ? ` Reopen if ${tw.join(" or ")}.` : ""}`;
}
let barFor = null;
function actionBar(d) {
  const bar = $("actionbar");
  if (!d) { if (!bar.hidden) { bar.classList.remove("in"); bar.hidden = true; barFor = null; document.body.style.removeProperty("--ab-h"); } return; }
  if (barFor === d.decision_id && !bar.hidden) return;
  barFor = d.decision_id;
  const tip = suggestReason(d);
  bar.innerHTML = `
    <div class="ab-in">
      <div class="ab-top">
        <div class="ab-sum"><span class="ab-dot"></span><div><div class="eyebrow">Needs your decision</div>
          <b>${esc(supName(d.subject_id))}: <span class="verdict ${esc(d.decision)}">${LABEL[d.decision] ?? esc(d.decision)}</span> at ${pct(d.confidence ?? 0)}</b>${d.escalated ? `<span class="st esc" tabindex="0" data-tip="${esc(TIP.escalated)}">escalated<span class="ab-req"> · reason required</span></span>` : ""}</div></div>
        <button class="ab-toggle" id="ab-toggle" type="button" aria-expanded="true" aria-controls="ab-body">Reason${IC.chev}</button>
        <div class="ab-act"><button class="btn ghost" id="reject" type="button">Reject</button><button class="btn primary" id="approve" type="button">${IC.check}Approve and write to ledger</button></div>
      </div>
      <div class="ab-body" id="ab-body">
        <div class="ab-sug" id="ab-sug">
          <div class="ab-sug-h">${IC.bulb}<span>Suggested reason</span><span class="info" tabindex="0" data-tip="Drafted in your browser from what the agents found: the verdict, the risk flags and the tripwires. No extra model call. Use it, edit it or write your own.">i</span></div>
          <p>${esc(tip)}</p>
          <div class="row"><button class="btn sm primary" id="ab-use" type="button">${IC.check}Use this reason</button><button class="btn sm ghost" id="ab-own" type="button">Write my own</button></div>
        </div>
        <div class="ab-write" id="ab-write" hidden>
          <label class="field" for="reason"><span id="ab-src">Your reason</span> ${d.escalated ? "(required)" : "(optional)"}</label>
          <textarea class="input" id="reason" rows="2" placeholder="${d.escalated ? "Why you agree, in a sentence. It goes on the record." : "Optional note for the record"}"></textarea>
          <button class="linkbtn" id="ab-back" type="button">Show the suggestion again</button>
        </div>
        <div class="err" id="writeres" role="alert"></div>
      </div>
    </div>`;
  bar.hidden = false;
  requestAnimationFrame(() => bar.classList.add("in"));
  const fit = () => document.body.style.setProperty("--ab-h", `${bar.offsetHeight}px`);
  fit(); (bar._ro ??= new ResizeObserver(fit)).observe(bar);

  const reason = $("reason"), sug = $("ab-sug"), write = $("ab-write"), src = $("ab-src");
  const toggle = $("ab-toggle"), body = $("ab-body");
  const setOpen = (open) => { body.hidden = !open; toggle.setAttribute("aria-expanded", String(open)); toggle.classList.toggle("open", open); };
  // Open on wide screens; on phones it starts folded so the page stays readable (Approve unfolds it if a reason is missing).
  setOpen(innerWidth > 720);
  toggle.onclick = () => setOpen(body.hidden);
  const showWrite = (text, from) => { $("writeres").textContent = ""; sug.hidden = true; write.hidden = false; reason.value = text; src.textContent = from; reason.focus(); reason.setSelectionRange(text.length, text.length); };
  $("ab-use").onclick = () => showWrite(tip, "Suggested reason, yours to edit");
  $("ab-own").onclick = () => showWrite("", "Your reason");
  $("ab-back").onclick = () => { sug.hidden = false; write.hidden = true; reason.value = ""; };
  reason.oninput = () => { if (src.textContent.startsWith("Suggested") && reason.value !== tip) src.textContent = "Suggested reason, edited by you"; };

  const a = $("approve"), rj = $("reject"), err = $("writeres");
  const fail = (msg) => { err.textContent = ""; void err.offsetWidth; err.textContent = msg; };
  a.onclick = async () => {
    const r0 = write.hidden ? "" : reason.value.trim();
    if (d.escalated && !r0) { setOpen(true); fail("Escalated decisions need a reason. Use the suggestion or write your own."); (write.hidden ? $("ab-use") : reason).focus(); return; }
    a.disabled = rj.disabled = true; a.innerHTML = `<span class="spin"></span>Writing to the ledger…`;
    try {
      const r = await api(`/decisions/${d.decision_id}/approve`, { method: "POST", body: JSON.stringify({ reason: r0 }) });
      renderDecision(r.decision);
      $("write-result").innerHTML = `<div class="banner ${r.write?.written ? "ok" : "bad"} enter">${r.write?.written ? IC.db : IC.warn}<div><b>${r.write?.written ? "Written to the ledger." : "Not written."}</b> <span title="${esc(r.write?.detail || "")}">${esc(writeText(r.write))}</span></div></div>`;
      await loadTrace(r.run_id, true);
      markDone("step-review"); setStep(3);
      toast(`<b>Approved.</b> Now try step 3: apply a data change and see which decisions reopen.`);
    } catch (e) { fail(e.message); a.disabled = rj.disabled = false; a.innerHTML = `${IC.check}Approve and write to ledger`; }
    loadDecisions();
  };
  rj.onclick = async () => {
    rj.disabled = a.disabled = true; rj.innerHTML = `<span class="spin"></span>Rejecting…`;
    await api(`/decisions/${d.decision_id}/reject`, { method: "POST" }).catch((e) => toast(esc(e.message)));
    openDecision(d.decision_id);
  };
}

function renderDecisionSkeleton() {
  $("detail").innerHTML = `<div class="skel l1"></div><div class="skel l3"></div><div class="skel l2"></div><div class="skel l3"></div><div class="skel l2"></div><div class="skel l2"></div>`;
}
async function openDecision(id) {
  for (const el of $("decisions").querySelectorAll(".dcard")) el.classList.toggle("sel", el.dataset.id === id);
  if (selected !== id) renderDecisionSkeleton();
  try { renderDecision(await api(`/decisions/${id}`)); }
  catch (e) { $("detail").innerHTML = `<div class="banner bad">${IC.warn}<div>${esc(e.message)}</div></div>`; }
  if (innerWidth < 860) $("detail").scrollIntoView({ behavior: TW.reduced() ? "auto" : "smooth", block: "start" });
  loadDecisions();
}

// ---------- Trace ----------
const AGENT = { Orchestrator: "Or", ZetarisGateway: "Ze", Planner: "Pl", Analyst: "An", EvidenceCritic: "Cr", MemoryKeeper: "Me", RiskOfficer: "Ri", Decider: "De", Watcher: "Wa", Human: "Hu" };
function pretty(a) { return String(a || "").replace(/([a-z])([A-Z])/g, "$1 $2"); }
const tev = (e, fresh) => `
    <div class="tev ${fresh ? "new" : ""} ${esc(e.event)} ${esc(e.status)}">
      <span class="av">${esc(AGENT[e.agent_name] ?? String(e.agent_name || "?").slice(0, 2))}</span>
      <div>
        <div class="h"><b>${esc(pretty(e.agent_name))}</b>${e.target_agent ? `<span class="a">→ ${esc(pretty(e.target_agent))}</span>` : ""}<span class="a">${esc(say(e).title)}</span>
          ${e.sponsor ? `<span class="bd">${esc(e.sponsor)}</span>` : ""}${e.event === "fallback" ? `<span class="bd">fallback</span>` : ""}${e.status === "needs_revision" ? `<span class="bd">sent back</span>` : ""}${e.retry_count ? `<span class="bd">retry ${e.retry_count}</span>` : ""}</div>
        ${say(e).detail ? `<div class="o" title="${esc(`As logged: ${e.action}${e.output_summary ? ` · ${e.output_summary}` : ""}`)}">${esc(say(e).detail)}</div>` : ""}
      </div>
    </div>`;
function renderTrace(events, append = false) {
  const tr = $("trace");
  const first = !append || !lastTrace.length;
  lastTrace = append ? lastTrace.concat(events) : events;
  $("trace-count").textContent = lastTrace.length ? `${lastTrace.length} steps` : "";
  if (first) tr.innerHTML = lastTrace.map((e) => tev(e, true)).join("") || (append ? "" : `<div class="none">${IC.empty}Waiting for the first step…</div>`);
  else tr.insertAdjacentHTML("beforeend", events.map((e) => tev(e, true)).join(""));
  tr.scrollTop = tr.scrollHeight;
}
async function loadTrace(run_id, append) { renderTrace(await api(`/trace/${run_id}`).catch(() => []), append); }

// ---------- Actions ----------
let running = false;
async function decide(thenChange = false) {
  if (running) return;
  running = true;
  const b = $("decide"); b.disabled = true; b.classList.add("running"); b.innerHTML = `<span class="spin"></span>Agents working…`;
  for (const q of document.querySelectorAll("[data-q], #changes button[data-f]")) q.disabled = true;
  supMeta();
  const id = $("supplier").value, run_id = rid();
  setStep(1);
  renderRun(`Deciding on ${esc(supName(id))}`, `${esc(id)} · six agents, about 30 to 90 seconds live`);
  if (innerWidth < 860) $("detail").scrollIntoView({ behavior: TW.reduced() ? "auto" : "smooth", block: "start" });
  const stop = watchRun(run_id);
  try {
    const r = await api("/run", { method: "POST", body: JSON.stringify({ mode: "decide", subject_id: id, run_id }) });
    await stop();
    await openDecision(r.decision_id);
    await loadTrace(r.run_id);
    markDone("step-decide"); setStep(thenChange ? 3 : 2);
    if (thenChange) {
      toast(`<b>Decision made.</b> Now apply <b>Spend share jump</b> in step 3 and see whether this decision reopens.`, 10000);
      const card = document.querySelector('[data-card="02_spend_share_jump.json"]');
      card?.scrollIntoView({ block: "center", behavior: TW.reduced() ? "auto" : "smooth" }); card?.classList.add("suggest", "pulse-once");
    } else {
      toast(`<b>Decision proposed.</b> Read the reasoning and evidence, then approve or reject it in the bar at the bottom of the screen.`);
    }
  } catch (e) {
    await stop();
    swap($("detail"), `<div class="banner bad">${IC.warn}<div><b>The run failed.</b> ${esc(e.message)}<div style="margin-top:8px"><button class="btn sm" id="retry" type="button">Try again</button></div></div></div>`);
    $("retry").onclick = () => decide(thenChange);
  }
  b.disabled = false; b.classList.remove("running"); b.innerHTML = `${IC.play}Decide`; running = false;
  for (const q of document.querySelectorAll("[data-q], #changes button[data-f]")) if (!q.textContent.includes("Applied")) q.disabled = false;
}

function watcherSteps(stage) {
  const s = ["Writing the change to the data layer", "Asking memory which decisions read that row", "Re-checking their tripwires in code", "Re-running any decision whose tripwire fired"];
  return `<div class="wsteps">${s.map((t, i) => `<div class="${i < stage ? "ok" : i === stage ? "on" : ""}"><i></i>${t}</div>`).join("")}</div>`;
}
async function applyChange(file, btn) {
  if (running) return;
  running = true;
  for (const b of $("changes").querySelectorAll("button[data-f]")) b.disabled = true;
  const label = btn.textContent; btn.innerHTML = `<span class="spin"></span>Applying`;
  for (const c of $("changes").querySelectorAll(".ccard")) c.classList.toggle("suggest", c.dataset.card === file);
  setStep(3);
  const run_id = rid();
  $("report").innerHTML = `<div class="wr"><div class="wr-h">${TW.LOADER.replace("tw-loader", "tw-loader sm")}<b>Watcher at work</b></div><div id="wsteps">${watcherSteps(0)}</div></div>`;
  const stepper = setInterval(() => { const el = $("wsteps"); if (!el) return; const ev = lastTrace.map((e) => e.action); el.innerHTML = watcherSteps(ev.includes("check_tripwires") ? (ev.includes("plan") ? 3 : 2) : ev.includes("lineage_lookup") ? 1 : 0); }, 300);
  const name = file.replace(/\.json$/, "").replace(/^\d+_/, "").replace(/_/g, " ");
  renderRun(`Applying “${esc(name)}”`, "The Watcher checks only decisions that read the changed row", "change");
  const stop = watchRun(run_id);
  try {
    const r = await api(`/changes/${encodeURIComponent(file)}/apply?run_id=${run_id}`, { method: "POST" });
    await stop(); clearInterval(stepper);
    const total = (r.reports || []).reduce((n, x) => n + x.active, 0);
    $("report").innerHTML = r.reports.map((x) => {
      const dep = new Set(x.dependents.map((d) => d.decision_id ?? d));
      const fired = new Set(x.reopened.map((o) => o.old));
      const dots = decisionsCache.filter((d) => d.status !== "superseded" && d.status !== "rejected" || fired.has(d.decision_id));
      const n = Math.max(x.active, dots.length);
      const cells = Array.from({ length: n }, (_, i) => { const d = dots[i]; const id = d?.decision_id; return `<span style="--i:${i}" class="${id && fired.has(id) ? "fire" : id && dep.has(id) ? "dep" : ""}" title="${esc(id ? `${supName(d.subject_id)}'s decision (${LABEL[d.decision] ?? d.decision})` : "decision")}"></span>`; });
      return `<div class="wr">
        <div class="wr-h">${IC.db}<span>Changed: <b tabindex="0" data-tip="${esc(rowTip(x.changed.table, x.changed.key))}">${esc(rowName(x.changed.table, x.changed.key))}</b></span></div>
        ${n ? `<div class="dots">${cells.join("")}</div><div class="dots-legend"><span><i></i>left alone</span><span><i class="dep"></i>depends, still holds</span><span><i class="fire"></i>tripwire fired</span></div>` : ""}
        <div class="tiles">
          <div class="tile" data-tip="Active decisions that read the changed row." tabindex="0"><b data-n="${x.dependents.length}">0</b><span>of ${x.active} ${x.dependents.length === 1 ? "depends" : "depend"} on it</span></div>
          <div class="tile ${x.reopened.length ? "hot" : ""}" data-tip="Dependent decisions whose tripwire fired." tabindex="0"><b data-n="${x.reopened.length}">0</b><span>reopened</span></div>
          <div class="tile" data-tip="Active decisions not re-run because the change could not affect them, or no tripwire fired." tabindex="0"><b data-n="${x.work_saved}">0</b><span>left alone</span></div>
        </div>
        ${x.reopened.map((o) => `<div class="rline fired"><b>Tripwire fired.</b> ${esc(decName(o.old))} reopened → <a href="#" data-id="${esc(o.new.decision_id)}">new decision: ${LABEL[o.new.decision] ?? esc(o.new.decision)}</a><ul>${o.fired.map((f) => `<li>${esc(cap(wireText(f)))}</li>`).join("")}</ul></div>`).join("")}
        ${x.still_valid.map((v) => `<div class="rline"><b>Still holds.</b> ${esc(decName(v.decision_id))} depends on this row, but no tripwire fired.${(v.checked || []).length ? `<ul>${v.checked.map((c) => `<li>${esc(typeof c === "string" ? cap(wireText(c)) : JSON.stringify(c))}</li>`).join("")}</ul>` : ""}</div>`).join("")}
        ${!x.dependents.length ? `<div class="rline">No active decision depends on this row, so nothing was re-run.${x.active ? "" : " Make a decision first to see the Watcher at work."}</div>` : ""}
      </div>`;
    }).join("") || empty("No rows changed.");
    for (const el of $("report").querySelectorAll("[data-n]")) TW.countUp(el, Number(el.dataset.n), { ms: 800 });
    for (const a of $("report").querySelectorAll("a[data-id]")) a.onclick = (ev) => { ev.preventDefault(); openDecision(a.dataset.id); };
    await loadTrace(r.run_id);
    const reopened = r.reports.flatMap((x) => x.reopened);
    if (reopened[0]) { await openDecision(reopened[0].new.decision_id); toast(`<b>A tripwire fired.</b> The reopened decision is open in the middle. The old one is marked superseded.`); }
    else {
      swap($("detail"), `<div class="start"><div class="banner ok done-anim"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m7 12.5 3.2 3.2L17 9"/></svg><div><b>Nothing reopened.</b> ${total ? `The change was checked against ${total} active decision${total === 1 ? "" : "s"} and crossed no tripwire, so no work was redone.` : "No decision exists yet, so there was nothing to check. Make a decision first."}</div></div><p class="muted" style="margin-top:14px">See the breakdown under step 3 on the left, and every step the Watcher took in the trace.</p></div>`);
      toast(`<b>Nothing reopened.</b> The change did not cross any tripwire, so no work was redone.`);
    }
    markDone("step-change");
    loadDecisions();
    btn.innerHTML = `${IC.check}Applied`;
  } catch (e) {
    await stop(); clearInterval(stepper);
    $("report").innerHTML = `<div class="banner bad">${IC.warn}<div>${esc(e.message)}</div></div>`;
    btn.textContent = label;
    renderStart();
  }
  for (const b of $("changes").querySelectorAll("button[data-f]")) if (b !== btn || !b.textContent.includes("Applied")) b.disabled = false;
  running = false;
}

// ---------- Wiring ----------
$("decide").onclick = () => decide();
for (const b of document.querySelectorAll(".try [data-q]")) b.onclick = () => pick(b.dataset.q, b.dataset.then === "change");

// ---------- Tour ----------
const TOUR = [
  { el: null, title: "Welcome to the Tripwire console", body: "Tripwire is a team of AI agents that makes supplier decisions and remembers exactly which data each one depends on. When that data changes, it reopens only the decisions affected. This tour takes about a minute." },
  { el: "#status-bar", title: "What is running right now", body: "Each pill shows whether a sponsor technology is live or on its fallback. Hover one for details. <b>Zetaris</b> holds the data, <b>Nemotron</b> does the reasoning, <b>H-MEM</b> stores memory and lineage." },
  { el: "#step-decide", title: "Step 1: make a decision", body: "Pick one of 20 suppliers and press <b>Decide</b>. Six agents plan queries, analyse, critique each other and propose <b>keep</b>, <b>dual-source</b> or <b>exit</b>. You watch each agent work live." },
  { el: "#detail", title: "The decision, explained", body: "Here you see the verdict and confidence, why, the key numbers (click one for its SQL and result hash), and the <b>tripwires</b>: how close each one is to firing." },
  { el: "#step-review", title: "Step 2: review and approve", body: "Every decision starts as a proposal. A human approves or rejects it. Risky ones are <b>escalated</b> and need a written reason. Approval writes the decision to the ledger." },
  { el: "#step-change", title: "Step 3: change the data", body: "Each card shows the value before and after. Apply one and the Watcher asks memory which decisions read that row, checks only their tripwires, and reopens only the ones that fire." },
  { el: "#trace-panel", title: "See the agents think", body: "Every step of each run streams in here as it happens: queries, handoffs, where the Critic sent work back, and any fallback. Nothing is hidden." },
  { el: "#tour-btn", title: "You're ready", body: "Try the <b>Tripwire test</b> shortcut first: it decides on SUP-06, then you apply the spend share jump. You can replay this tour from here." },
];
// Shown on every load on purpose (nothing is stored), so each visitor gets the walkthrough.
function startTour() { TW.tour(TOUR, { finishLabel: "Start using it" }); }
$("tour-btn").onclick = startTour;

// ---------- Boot ----------
(async () => {
  await loadSuppliers();
  renderStart();
  const list = await loadDecisions();
  loadChanges();
  chips();
  if (list.length) setStep(list.some((d) => d.status === "approved") ? 3 : 2);
  const q = new URLSearchParams(location.search);
  if (q.get("run") === "1") decide(q.get("supplier") === "SUP-06");
  else startTour();
})();
