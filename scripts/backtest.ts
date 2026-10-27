// Proving Ground stage 4, Backtest: replays Tripwire's tripwires on real SEC history (a "time machine").
// For each as-of date it uses only filings available then, sets tripwires, then steps forward through the real
// 10-Q/10-K numbers and 8-K filings: did a tripwire fire before real trouble, and how often for nothing?
// Rules are pre-registered in app/proving/backtest.ts and docs/proving/BACKTEST.md.
//
// Usage:
//   npx tsx scripts/backtest.ts                 fetch (cached), run the rule arm, write eval/backtest_results.json + eval/BACKTEST.md
//   npx tsx scripts/backtest.ts --refresh       re-download from SEC EDGAR (User-Agent from SEC_USER_AGENT, <= 5 requests/second)
//   npx tsx scripts/backtest.ts --budget        print the model arms' call budget and a minutes estimate, run nothing
//   npx tsx scripts/backtest.ts --record [--max-cases N]   model arms live through Nightshift (Windows PC only), recorded
//   npx tsx scripts/backtest.ts --replay [--max-cases N]   model arms from data/backtest/recordings.jsonl, no keys
// Raw downloads go to data/backtest/raw/ (gitignored); the derived history (data/backtest/history.json) is committed.
// Nothing here touches Zetaris.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultTripwires, type TripwireDraft } from "../app/tripwires.js";
import {
  asOfDates, ceoCfoDeparture, qEnd, FOLLOWUP_QUARTERS, metricsAsOf, OFFICER_ITEM, qIndex, qLabel, scoreArm, troubleEvents, WINDOW_QUARTERS,
  type ArmResult, type BacktestResults, type CaseTripwires, type Filing8K, type HeldValues, type Period, type SupplierHistory,
} from "../app/proving/backtest.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "data/backtest");
const RAW = join(DIR, "raw");
const HISTORY = join(DIR, "history.json");
const RECORDINGS = join(DIR, "recordings.jsonl");
const OUT_JSON = join(ROOT, "eval/backtest_results.json");
const OUT_MD = join(ROOT, "eval/BACKTEST.md");
const OUT_TIMELINE = join(ROOT, "eval/backtest_timeline.json");
const UA = process.env.SEC_USER_AGENT || "Tripwire hackathon demo manuareraa@gmail.com";
const has = (f: string) => process.argv.includes(f);
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const REFRESH = has("--refresh");
/** Filings older than this are not needed: the first as-of date looks back 12 months for 8-Ks and 6 quarters for revenue. */
const HISTORY_FROM = "2019-07-01";

// ---------- SEC EDGAR fetching (cached) ----------

let lastRequest = 0;
async function get(url: string): Promise<string> {
  const wait = lastRequest + 220 - Date.now(); // <= 5 requests/second
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Encoding": "gzip, deflate" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function cachedText(name: string, url: string): Promise<string> {
  const path = join(RAW, name);
  if (!REFRESH && existsSync(path)) return readFileSync(path, "utf8");
  const body = await get(url);
  writeFileSync(path, body);
  return body;
}
const cachedJson = async (name: string, url: string) => JSON.parse(await cachedText(name, url));

interface Fact { start?: string; end: string; val: number; accn: string; form: string; filed: string }
type Concepts = Record<string, { units: Record<string, Fact[]> }>;

const REVENUE = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"];
const COST = ["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfGoodsSold"];
const EQUITY = ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"];
const FORMS = new Set(["10-Q", "10-K", "10-Q/A", "10-K/A", "10-KT"]);
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const usd = (g: Concepts, c: string) => (g[c]?.units?.USD ?? []).filter((f) => FORMS.has(f.form));
/** The original filing's value (earliest filed), as fetch_edgar.ts does. */
const first = (list: Fact[], pred: (f: Fact) => boolean) => list.filter(pred).sort((a, b) => a.filed.localeCompare(b.filed))[0];
const pick = <T>(cs: string[], fn: (c: string) => T | undefined) => { for (const c of cs) { const v = fn(c); if (v !== undefined) return v; } return undefined; };

/** Quarter value of a duration concept: a ~3-month fact, or Q4 = fiscal year minus 9-month YTD. Known on the later filing date. */
function quarterValue(list: Fact[], end: string): { val: number; filed: string } | undefined {
  const q = first(list, (f) => f.end === end && !!f.start && Math.abs(days(f.start, f.end) - 91) <= 10);
  if (q) return { val: q.val, filed: q.filed };
  const fy = first(list, (f) => f.end === end && !!f.start && Math.abs(days(f.start, f.end) - 364) <= 10);
  if (!fy) return undefined;
  const ytd9 = first(list, (f) => f.start === fy.start && Math.abs(days(f.start!, f.end) - 273) <= 10);
  return ytd9 ? { val: fy.val - ytd9.val, filed: fy.filed > ytd9.filed ? fy.filed : ytd9.filed } : undefined;
}

function periodsFrom(g: Concepts): Period[] {
  const ac = usd(g, "AssetsCurrent");
  const ends = [...new Set(ac.map((f) => f.end))].filter((e) => e >= HISTORY_FROM).sort();
  const out: Period[] = [];
  for (const end of ends) {
    if (out.some((p) => Math.abs(days(p.end, end)) < 7)) continue; // one row per quarter
    const assetsCur = first(ac, (f) => f.end === end)!;
    const liabCur = first(usd(g, "LiabilitiesCurrent"), (f) => f.end === end);
    if (!liabCur) continue;
    const equity = pick(EQUITY, (c) => first(usd(g, c), (f) => f.end === end));
    let liab = first(usd(g, "Liabilities"), (f) => f.end === end)?.val;
    if (liab === undefined && equity) {
      const lse = first(usd(g, "LiabilitiesAndStockholdersEquity"), (f) => f.end === end);
      if (lse) liab = lse.val - equity.val;
    }
    const rev = pick(REVENUE, (c) => quarterValue(usd(g, c), end));
    let gp = quarterValue(usd(g, "GrossProfit"), end)?.val;
    if (gp === undefined && rev) {
      const cost = pick(COST, (c) => quarterValue(usd(g, c), end));
      if (cost) gp = rev.val - cost.val;
    }
    let revenue: number | null = rev && rev.val > 0 ? rev.val : null;
    let gm: number | null = revenue && gp !== undefined ? gp / revenue : null;
    if (gm !== null && (gm < -1 || gm > 1)) { revenue = null; gm = null; } // Q4 = FY - YTD mixed restated figures
    const known = [assetsCur.filed, liabCur.filed].sort().at(-1)!;
    out.push({
      end,
      known,
      current_ratio: r4(assetsCur.val / liabCur.val),
      debt_to_equity: liab !== undefined && equity && equity.val > 0 ? r4(liab / equity.val) : null,
      ...(equity && equity.val <= 0 ? { equity_nonpositive: true } : {}),
      gross_margin: gm === null ? null : r4(gm),
      revenue: revenue === null ? null : Math.round(revenue),
      accession: assetsCur.accn,
    });
  }
  // Same clean-up as fetch_edgar.ts: a quarter's revenue under 0.3x the median is a derivation artefact.
  const revs = out.map((p) => p.revenue).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const med = revs[Math.floor(revs.length / 2)];
  for (const p of out) if (p.revenue !== null && p.revenue < 0.3 * med) { p.revenue = null; p.gross_margin = null; }
  return out;
}

interface Recent { accessionNumber: string[]; filingDate: string[]; form: string[]; items: string[]; primaryDocument: string[] }

async function filingsFor(cik: number, cik10: string): Promise<Filing8K[]> {
  const sub = await cachedJson(`submissions_${cik10}.json`, `https://data.sec.gov/submissions/CIK${cik10}.json`);
  const pages: Recent[] = [sub.filings.recent];
  for (const f of sub.filings.files ?? []) {
    if (f.filingTo >= HISTORY_FROM) pages.push(await cachedJson(f.name, `https://data.sec.gov/submissions/${f.name}`));
  }
  const out: Filing8K[] = [];
  const seen = new Set<string>();
  for (const r of pages) {
    for (let i = 0; i < r.form.length; i++) {
      if (r.form[i] !== "8-K" || r.filingDate[i] < HISTORY_FROM || seen.has(r.accessionNumber[i])) continue;
      seen.add(r.accessionNumber[i]);
      const accn = r.accessionNumber[i].replace(/-/g, "");
      const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accn}/${r.primaryDocument[i]}`;
      const items = String(r.items[i] ?? "").split(/[\s,]+/).filter(Boolean);
      const f: Filing8K = { filed: r.filingDate[i], accession: r.accessionNumber[i], items, url };
      if (items.includes(OFFICER_ITEM)) f.ceo_cfo_departure = ceoCfoDeparture(await cachedText(`8k_${accn}.htm`, url));
      out.push(f);
    }
  }
  return out.sort((a, b) => a.filed.localeCompare(b.filed));
}

function readCsv(path: string): Record<string, string>[] {
  const [head, ...lines] = readFileSync(path, "utf8").trim().split("\n");
  const cols = head.split(",");
  return lines.map((l) => {
    const cells = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

const spend = () => readCsv(join(ROOT, "data/sample/supplier_spend.csv"));

/** Spend share, lead time, alternatives and sanctions stay at today's sample values: there is no past record of them. */
function heldValues(): Record<string, HeldValues> {
  const rows = spend();
  const sanctions = new Map(readCsv(join(ROOT, "data/sample/sanctions_screen.csv")).map((r) => [r.cik, Number(r.match_count)]));
  return Object.fromEntries(rows.map((r) => [r.supplier_id, {
    spend_share: Number(r.spend_share),
    lead_time_weeks: Number(r.lead_time_weeks),
    category_alternatives: rows.filter((x) => x.category === r.category && x.supplier_id !== r.supplier_id).length,
    sanctions_matches: sanctions.get(r.cik) ?? 0,
  }]));
}

interface HistoryFile { fetched_on: string; user_agent_note: string; suppliers: (SupplierHistory & { name: string; sic: string })[] }

async function buildHistory(): Promise<HistoryFile> {
  if (!REFRESH && existsSync(HISTORY) && !has("--rebuild")) return JSON.parse(readFileSync(HISTORY, "utf8"));
  mkdirSync(RAW, { recursive: true });
  const tickers = new Map(readCsv(join(ROOT, "data/sample/supplier_financials.csv")).map((r) => [r.cik, r.ticker]));
  const suppliers: HistoryFile["suppliers"] = [];
  for (const s of spend()) {
    const cik = Number(s.cik);
    const cik10 = String(cik).padStart(10, "0");
    const cf = await cachedJson(`companyfacts_${cik10}.json`, `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`);
    const sub = await cachedJson(`submissions_${cik10}.json`, `https://data.sec.gov/submissions/CIK${cik10}.json`);
    const periods = periodsFrom(cf.facts["us-gaap"] ?? {});
    const filings = await filingsFor(cik, cik10);
    suppliers.push({ supplier_id: s.supplier_id, ticker: tickers.get(s.cik) ?? "", cik: s.cik, category: s.category, name: cf.entityName || sub.name, sic: sub.sic ?? "", periods, filings });
    console.log(`${s.supplier_id} ${tickers.get(s.cik)?.padEnd(5)} periods=${periods.length} 8-Ks=${filings.length} (5.02 CEO/CFO leaving: ${filings.filter((f) => f.ceo_cfo_departure).length})`);
  }
  const h: HistoryFile = { fetched_on: new Date().toISOString().slice(0, 10), user_agent_note: "SEC EDGAR companyfacts + submissions, fetched with a declared User-Agent", suppliers };
  writeFileSync(HISTORY, JSON.stringify(h, null, 1) + "\n");
  return h;
}

// ---------- Cases ----------

function allCases(hist: HistoryFile): { supplier_id: string; as_of: string }[] {
  const dates = asOfDates(hist.fetched_on);
  return dates.flatMap((as_of) => hist.suppliers.map((s) => ({ supplier_id: s.supplier_id, as_of })));
}

/** An even spread of N cases across suppliers and years (every k-th case), the same for every arm. */
function subset<T>(cases: T[], max?: number): T[] {
  if (!max || max >= cases.length) return cases;
  const k = cases.length / max;
  return Array.from({ length: max }, (_, i) => cases[Math.floor(i * k)]);
}

function ruleCases(hist: HistoryFile, cases: { supplier_id: string; as_of: string }[], held: Record<string, HeldValues>): CaseTripwires[] {
  const by = new Map(hist.suppliers.map((s) => [s.supplier_id, s]));
  return cases.map((c) => ({ ...c, tripwires: defaultTripwires(metricsAsOf(by.get(c.supplier_id)!, c.as_of, held[c.supplier_id])) }));
}

// ---------- Model arms (Nightshift on the Windows PC, or replay) ----------

/** Rough per-decision model calls: 4 from the existing pipeline (measured in data/recordings/nightshift.jsonl), 1 Ultra pre-mortem, ~8 Lightning crash tests. */
const CALLS_PER_CASE = { pipeline: 4, premortem: 1, crash: 8 };
const MEAN_LATENCY_S = 2.5; // mean latency_ms of the 107 recorded Nightshift calls; Ultra calls run longer

function budget(n: number) {
  const per = CALLS_PER_CASE.pipeline + CALLS_PER_CASE.premortem + CALLS_PER_CASE.crash;
  return { cases: n, calls_per_case: per, calls: n * per, minutes_estimate: Math.round((n * per * MEAN_LATENCY_S) / 60) };
}

const csv = (cols: string[], rows: Record<string, unknown>[]) =>
  [cols.join(","), ...rows.map((r) => cols.map((c) => { const s = r[c] === null || r[c] === undefined ? "" : String(r[c]); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(","))].join("\n") + "\n";

/** A sample-data folder as it would have looked on `as_of`: only filings filed by then. Spend and sanctions as today. */
function writeAsOfSample(dir: string, hist: HistoryFile, as_of: string) {
  mkdirSync(dir, { recursive: true });
  for (const f of ["supplier_spend.csv", "sanctions_screen.csv"]) writeFileSync(join(dir, f), readFileSync(join(ROOT, "data/sample", f)));
  const fin: Record<string, unknown>[] = [];
  const ev: Record<string, unknown>[] = [];
  const from = new Date(Date.parse(as_of) - 365 * 86_400_000).toISOString().slice(0, 10);
  for (const s of hist.suppliers) {
    const known = s.periods.filter((p) => p.known <= as_of).sort((a, b) => b.end.localeCompare(a.end)).slice(0, 6);
    for (const p of known.reverse()) {
      fin.push({ cik: s.cik, ticker: s.ticker, name: s.name, sic: s.sic, period_end: p.end, revenue: p.revenue, gross_margin: p.gross_margin, current_ratio: p.current_ratio, debt_to_equity: p.debt_to_equity, source_url: `https://www.sec.gov/Archives/edgar/data/${s.cik}/${p.accession.replace(/-/g, "")}/` });
    }
    for (const f of s.filings.filter((x) => x.filed > from && x.filed <= as_of)) ev.push({ cik: s.cik, filed_date: f.filed, form: "8-K", items: f.items.join(" "), accession: f.accession, url: f.url });
  }
  writeFileSync(join(dir, "supplier_financials.csv"), csv(["cik", "ticker", "name", "sic", "period_end", "revenue", "gross_margin", "current_ratio", "debt_to_equity", "source_url"], fin));
  writeFileSync(join(dir, "supplier_events.csv"), csv(["cik", "filed_date", "form", "items", "accession", "url"], ev));
  const status = readCsv(join(ROOT, "data/sample/source_status.csv")).map((r) => (r.source === "sanctions_screen" ? r : { ...r, fetched_on: as_of, as_of }));
  writeFileSync(join(dir, "source_status.csv"), csv(["source", "system", "fetched_on", "as_of", "row_count", "url"], status));
}

async function modelCases(hist: HistoryFile, cases: { supplier_id: string; as_of: string }[], mode: "record" | "replay") {
  const work = mkdtempSync(join(tmpdir(), "tripwire-backtest-"));
  for (const k of Object.keys(process.env)) if (k.startsWith("ZETARIS_")) delete process.env[k];
  Object.assign(process.env, { DATA_DIR: work, LOG_DIR: join(work, "logs"), TRACE_STDOUT: "false" });
  if (mode === "record") Object.assign(process.env, { MODEL_RECORD_FILE: RECORDINGS, MODEL_REPLAY: "false", LLM_PROVIDER: "nightshift" });
  else Object.assign(process.env, { SAMPLE_MODE: "true", MODEL_REPLAY: "true", MODEL_REPLAY_FILE: RECORDINGS, MODEL_RECORD_FILE: "" });

  const { buildRuntime } = await import("../app/runtime.js");
  const { runDecide } = await import("../app/orchestration/graph.js");
  const { Tracer } = await import("../app/tracing.js");
  const { SampleDataGateway } = await import("../app/adapters/sample_data.js");
  const { LocalMemory } = await import("../app/adapters/local_memory.js");
  const rt = await buildRuntime();
  console.log(`model: ${rt.modes.model}`);
  if (mode === "record" && !rt.modes.model.startsWith("nightshift")) {
    rmSync(work, { recursive: true, force: true });
    throw new Error("Nightshift is not answering, so nothing was recorded (docs/NIGHTSHIFT.md).");
  }
  if (mode === "replay" && rt.modes.model !== "replay") {
    rmSync(work, { recursive: true, force: true });
    throw new Error(`no recordings to replay in ${RECORDINGS}`);
  }
  const decider: CaseTripwires[] = [];
  const crashed: CaseTripwires[] = [];
  let modelAnswered = 0;
  const started = Date.now();
  for (const [i, c] of cases.entries()) {
    const dir = join(work, `case-${i}`);
    writeAsOfSample(join(dir, "sample"), hist, c.as_of);
    process.env.SAMPLE_CLOCK = `${c.as_of}T23:59:59Z`;
    // A fresh gateway and memory per case, so nothing learned from a later quarter leaks into an earlier one.
    const gateway = new SampleDataGateway({ sampleDir: join(dir, "sample"), ledgerDir: join(dir, "ledger") });
    const deps = { gateway, model: rt.model, memory: new LocalMemory(join(dir, "memory.json")), tracer: new Tracer() };
    const { decision } = await runDecide(deps, c.supplier_id, "Keep, dual-source or exit this supplier?");
    if (decision.model_calls?.some((m) => !m.fallback)) modelAnswered++;
    const draft = (t: { metric: string; op: TripwireDraft["op"]; threshold?: number }): TripwireDraft => ({ metric: t.metric, op: t.op, threshold: t.threshold });
    decider.push({ ...c, tripwires: decision.tripwires.filter((t) => t.origin === "decider").map(draft) });
    crashed.push({ ...c, tripwires: decision.tripwires.filter((t) => t.origin === "premortem" && t.crash_test?.verdict === "verified").map(draft) });
    console.log(`${c.supplier_id} as of ${c.as_of}: ${decision.decision}; decider tripwires ${decider.at(-1)!.tripwires.length}, verified pre-mortem tripwires ${crashed.at(-1)!.tripwires.length}`);
  }
  delete process.env.SAMPLE_CLOCK;
  rmSync(work, { recursive: true, force: true });
  return { decider, crashed, modelAnswered, minutes: (Date.now() - started) / 60_000, mode: rt.modes.model };
}


// ---------- Time-lapse view (eval/backtest_timeline.json) ----------

/** Copy of BacktestTimeline in app/types.ts (branch pg-integrate). */
interface BacktestTimeline {
  subject_id: string;
  arm: string;
  as_of: string;
  quarters: string[];
  lines: { metric: string; op: "<" | ">"; threshold: number; values: (number | null)[]; fired_at?: string }[];
  trouble: { quarter: string; label: string; items?: string[]; source_url?: string }[];
}

const ITEM_WORDS: Record<string, string> = {
  "1.03": "Bankruptcy filed", "2.04": "Debt accelerated by lenders", "2.06": "Big write-down of assets",
  "4.01": "Auditor changed", "4.02": "Past financial statements withdrawn", "5.02": "CEO or CFO leaving",
};
const HELD = new Set(["spend_share", "lead_time_weeks", "category_alternatives", "sanctions_matches"]);

/**
 * One strip per supplier from a measured arm. The as-of shown is the case that caught trouble with the most warning,
 * else the first case that fired, else the latest case; the strip runs from the as-of quarter through the follow-up.
 * Values are the figures filed in each quarter (null when nothing was filed); the 8-K count is the count at quarter end.
 */
function timelines(arm: ArmResult, armName: string, hist: HistoryFile, held: Record<string, HeldValues>): Record<string, BacktestTimeline> {
  const out: Record<string, BacktestTimeline> = {};
  for (const h of hist.suppliers) {
    const cases = arm.cases!.filter((c) => c.supplier_id === h.supplier_id);
    const caught = arm.events!.filter((e) => e.supplier_id === h.supplier_id && e.caught_early).sort((a, b) => b.quarters_of_warning! - a.quarters_of_warning! || a.date.localeCompare(b.date))[0];
    const c = (caught && cases.find((x) => x.as_of === caught.as_of)) ?? cases.find((x) => x.firing) ?? cases.at(-1);
    if (!c) continue;
    const q0 = qIndex(c.as_of);
    const qs = Array.from({ length: WINDOW_QUARTERS + FOLLOWUP_QUARTERS + 1 }, (_, i) => q0 + i);
    const lines: BacktestTimeline["lines"] = [];
    for (const tw of c.tripwires) {
      if (HELD.has(tw.metric) || tw.op === "changed" || tw.threshold === undefined) continue;
      const values = qs.map((qi) => {
        if (tw.metric === "risk_events_12m") return metricsAsOf(h, qEnd(qi), held[h.supplier_id]).find((m) => m.metric === tw.metric)?.value ?? null;
        const filed = h.periods.filter((p) => qIndex(p.known) === qi).sort((a, b) => a.known.localeCompare(b.known)).at(-1);
        if (!filed) return null;
        return metricsAsOf(h, filed.known, held[h.supplier_id]).find((m) => m.metric === tw.metric)?.value ?? null;
      });
      lines.push({ metric: tw.metric, op: tw.op, threshold: tw.threshold, values, ...(c.firing?.metric === tw.metric ? { fired_at: c.firing.quarter } : {}) });
    }
    const trouble: BacktestTimeline["trouble"] = troubleEvents(h)
      .filter((e) => qIndex(e.date) >= qs[0] && qIndex(e.date) <= qs.at(-1)!)
      .map((e) => {
        if (e.kind === "covenant") return { quarter: e.quarter, label: e.detail.replace(/^covenant-level break/, "Covenant-level break") };
        const f = h.filings.find((x) => x.url === e.source)!;
        const items = f.items.filter((i) => ITEM_WORDS[i] && (i !== OFFICER_ITEM || f.ceo_cfo_departure));
        return { quarter: e.quarter, label: `${items.map((i) => ITEM_WORDS[i]).join("; ")} (8-K ${items.join(", ")})`, items, source_url: e.source };
      });
    out[h.supplier_id] = { subject_id: h.supplier_id, arm: armName, as_of: qLabel(q0), quarters: qs.map(qLabel), lines, trouble };
  }
  return out;
}

// ---------- Report ----------

function markdown(r: BacktestResults & { fetched_on: string; cases_total: number; budget: ReturnType<typeof budget> }): string {
  const lines = [
    "# Backtest: Tripwire's tripwires on real SEC history",
    "",
    `Written by \`scripts/backtest.ts\` from SEC EDGAR data fetched ${r.fetched_on}. Rules: \`docs/proving/BACKTEST.md\` (pre-registered).`,
    `Window: ${r.window}. ${r.cases_total} decisions = 20 suppliers x ${r.cases_total / 20} as-of dates, each watched for ${WINDOW_QUARTERS} quarters.`,
    "",
    "| Arm | Status | Decisions | Trouble events | Caught early (same quarter or before) | A quarter or more early | Median quarters of warning | Firings | False alarms |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const a of r.arms) {
    const t = a.totals;
    lines.push(t
      ? `| ${a.label} | ${a.status} | ${t.decisions} | ${t.trouble_events} (${t.trouble_8k} 8-K, ${t.trouble_covenant} covenant) | ${t.caught_early} | ${t.caught_a_quarter_or_more_early} | ${t.median_quarters_of_warning ?? "n/a"} | ${t.firings} | ${t.false_alarms} |`
      : `| ${a.label} | **${a.status}** | | | | | | | |`);
  }
  lines.push("", "Arms marked \"not run yet\" have no numbers: they are never estimated.", "");
  for (const a of r.arms.filter((x) => x.note)) lines.push(`- **${a.label}:** ${a.note}`);
  const rules = r.arms.find((a) => a.arm === "rules")!;
  lines.push("", "## Per supplier (rule arm)", "", "| Supplier | Ticker | Trouble events | Caught early | Firings | False alarms |", "|---|---|---|---|---|---|");
  for (const s of rules.suppliers!) lines.push(`| ${s.supplier_id} | ${s.ticker} | ${s.trouble_events} | ${s.caught_early} | ${s.firings} | ${s.false_alarms} |`);
  lines.push("", "## Every trouble event (rule arm)", "", "| Supplier | Became public | Quarter | What | Tripwire set from | Caught early | Fired on |", "|---|---|---|---|---|---|---|");
  for (const e of rules.events!) lines.push(`| ${e.supplier_id} | ${e.date} | ${e.quarter} | ${e.detail} | ${e.as_of} | ${e.caught_early ? `yes (${e.quarters_of_warning} q)` : "no"} | ${e.firing ? `${e.firing.metric} ${e.firing.value} vs ${e.firing.threshold} on ${e.firing.date}` : ""} |`);
  lines.push("", "## Model arms: live-recording budget", "",
    `All ${r.budget.cases} decisions: about ${r.budget.calls} model calls (${r.budget.calls_per_case} per decision), roughly ${r.budget.minutes_estimate} minutes at the recorded mean latency. This is a cost estimate, not a result.`,
    "Run on the Windows PC with Nightshift: `npx tsx scripts/backtest.ts --record --max-cases 40`, then commit `data/backtest/recordings.jsonl`; anyone can then run `--replay`.", "");
  return lines.join("\n");
}

async function main() {
  const hist = await buildHistory();
  const held = heldValues();
  const histories = hist.suppliers;
  const every = allCases(hist);
  const max = arg("--max-cases") ? Number(arg("--max-cases")) : undefined;
  const dates = asOfDates(hist.fetched_on);
  const window = `${qLabel(qIndex(dates[0]) + 1)}–${qLabel(qIndex(dates.at(-1)!) + WINDOW_QUARTERS)}`;
  const b = budget(every.length);
  if (has("--budget")) {
    console.log(JSON.stringify({ all: b, max_cases_40: budget(40) }, null, 2));
    return;
  }
  const label = { rules: "Rule-based tripwires (no model)", decider: "Ultra decider tripwires", crashed: "Pre-mortem + crash-tested tripwires" };
  const arms: ArmResult[] = [scoreArm("rules", label.rules, ruleCases(hist, every, held), histories, held)];
  let note = "Not recorded yet. Needs a live Nightshift run on the Windows PC (`--record`) after the Imagine and Crash-test stages land.";
  let prior: BacktestResults | undefined;
  try { prior = JSON.parse(readFileSync(OUT_JSON, "utf8")); } catch { prior = undefined; }
  if (has("--record") || has("--replay")) {
    const cases = subset(every, max);
    const m = await modelCases(hist, cases, has("--record") ? "record" : "replay");
    note = `${m.mode}: ${cases.length} of ${every.length} decisions (an even spread), ${m.modelAnswered} with at least one model answer, ${m.minutes.toFixed(1)} minutes.`;
    const sameRules = scoreArm("rules_same_cases", `${label.rules}, same ${cases.length} decisions`, ruleCases(hist, cases, held), histories, held);
    arms.push({ ...scoreArm("decider", label.decider, m.decider, histories, held), note }, { ...scoreArm("crashed", label.crashed, m.crashed, histories, held), note }, sameRules);
  } else if (prior) {
    // Keep model arms measured by an earlier --record/--replay run.
    arms.push(...prior.arms.filter((a) => a.arm !== "rules" && a.status === "measured"));
  }
  for (const [arm, l] of [["decider", label.decider], ["crashed", label.crashed]] as const) {
    if (!arms.some((a) => a.arm === arm)) arms.push({ arm, label: l, status: "not run yet", note });
  }
  const results = { window, fetched_on: hist.fetched_on, cases_total: every.length, pre_registered: "app/proving/backtest.ts, docs/proving/BACKTEST.md", held_at_sample: ["spend_share", "lead_time_weeks", "category_alternatives", "sanctions_matches"], budget: b, arms };
  writeFileSync(OUT_JSON, JSON.stringify(results, null, 1) + "\n");
  writeFileSync(OUT_MD, markdown(results));
  // The time-lapse shows the best measured arm on all 200 decisions (the rule arm until a model arm covers them all).
  const full = arms.filter((a) => a.status === "measured" && a.totals?.decisions === every.length)
    .sort((a, b) => b.totals!.caught_early - a.totals!.caught_early || a.totals!.false_alarms - b.totals!.false_alarms)[0];
  writeFileSync(OUT_TIMELINE, JSON.stringify(timelines(full, full.arm, hist, held), null, 1) + "\n");
  for (const a of arms) console.log(`${a.label}: ${a.status}${a.totals ? ` — trouble ${a.totals.trouble_events}, caught early ${a.totals.caught_early} (${a.totals.caught_a_quarter_or_more_early} by a quarter or more), median warning ${a.totals.median_quarters_of_warning} q, firings ${a.totals.firings}, false alarms ${a.totals.false_alarms}` : ""}`);
  console.log(`unscored trouble events (outside every window): ${histories.reduce((n, h) => n + troubleEvents(h).length, 0) - arms[0].totals!.trouble_events}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
