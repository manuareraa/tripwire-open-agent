// Builds data/sample/supplier_financials.csv from SEC EDGAR company facts (XBRL).
// Usage: npx tsx scripts/fetch_edgar.ts [--refresh]
// Raw downloads are cached in data/cache/ (gitignored). Every figure comes from a filing; nothing is estimated.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeSourceStatus } from "./fetch_sources.js";

const UA = process.env.SEC_USER_AGENT || "Tripwire hackathon demo manuareraa@gmail.com";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, "data/cache");
const OUT = join(ROOT, "data/sample");
const REFRESH = process.argv.includes("--refresh");
const PERIODS = 6;

/** Supplier universe: real public companies in five supply categories. */
export const SUPPLIERS: { ticker: string; category: string }[] = [
  { ticker: "TXN", category: "semiconductors" },
  { ticker: "MCHP", category: "semiconductors" },
  { ticker: "ON", category: "semiconductors" },
  { ticker: "WOLF", category: "semiconductors" },
  { ticker: "DOW", category: "chemicals" },
  { ticker: "CE", category: "chemicals" },
  { ticker: "HUN", category: "chemicals" },
  { ticker: "EMN", category: "chemicals" },
  { ticker: "UPS", category: "logistics" },
  { ticker: "CHRW", category: "logistics" },
  { ticker: "JBHT", category: "logistics" },
  { ticker: "XPO", category: "logistics" },
  { ticker: "IP", category: "packaging" },
  { ticker: "BALL", category: "packaging" },
  { ticker: "SON", category: "packaging" },
  { ticker: "PKG", category: "packaging" },
  { ticker: "APH", category: "electronic_components" },
  { ticker: "JBL", category: "electronic_components" },
  { ticker: "SANM", category: "electronic_components" },
  { ticker: "VSH", category: "electronic_components" },
];

/** Held back from the base CSV and written as a change file: a real filing "arriving" during the demo. */
export const HOLDBACK_TICKER = process.env.HOLDBACK_TICKER || "VSH";

const REVENUE = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "SalesRevenueNet",
];
const COST = ["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfGoodsSold"];
const EQUITY = ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"];

interface Fact {
  start?: string;
  end: string;
  val: number;
  accn: string;
  fy: number;
  fp: string;
  form: string;
  filed: string;
}
type Facts = Record<string, Fact[]>;

let lastRequest = 0;
async function get(url: string): Promise<string> {
  const wait = lastRequest + 220 - Date.now(); // <= 5 requests/second
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Encoding": "gzip, deflate" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function cached(name: string, url: string): Promise<unknown> {
  const path = join(CACHE, name);
  if (!REFRESH && existsSync(path)) return JSON.parse(await readFile(path, "utf8"));
  const body = await get(url);
  await writeFile(path, body);
  return JSON.parse(body);
}

const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
const forms = new Set(["10-Q", "10-K", "10-Q/A", "10-K/A", "10-KT"]);

function usd(facts: Record<string, { units: Record<string, Fact[]> }>, concept: string): Fact[] {
  return (facts[concept]?.units?.USD ?? []).filter((f) => forms.has(f.form));
}

/** Earliest-filed value (the original filing, not a later comparative) for a matching fact. */
function first(list: Fact[], pred: (f: Fact) => boolean): Fact | undefined {
  return list.filter(pred).sort((a, b) => a.filed.localeCompare(b.filed))[0];
}

/** Quarter value of a duration concept ending at `end`: a ~3-month fact, or Q4 = fiscal year minus 9-month YTD. */
function quarterValue(list: Fact[], end: string): { val: number; accn: string } | undefined {
  const q = first(list, (f) => f.end === end && !!f.start && Math.abs(days(f.start, f.end) - 91) <= 10);
  if (q) return { val: q.val, accn: q.accn };
  const fy = first(list, (f) => f.end === end && !!f.start && Math.abs(days(f.start, f.end) - 364) <= 10);
  if (!fy) return undefined;
  const ytd9 = first(
    list,
    (f) => f.start === fy.start && Math.abs(days(f.start!, f.end) - 273) <= 10,
  );
  return ytd9 ? { val: fy.val - ytd9.val, accn: fy.accn } : undefined;
}

function pick<T>(concepts: string[], fn: (c: string) => T | undefined): T | undefined {
  for (const c of concepts) {
    const v = fn(c);
    if (v !== undefined) return v;
  }
  return undefined;
}

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

export interface FinRow {
  cik: string;
  ticker: string;
  name: string;
  sic: string;
  period_end: string;
  revenue: number | null;
  gross_margin: number | null;
  current_ratio: number | null;
  debt_to_equity: number | null;
  source_url: string;
}

export const FIN_COLUMNS: (keyof FinRow)[] = [
  "cik", "ticker", "name", "sic", "period_end", "revenue", "gross_margin", "current_ratio", "debt_to_equity", "source_url",
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T extends object>(cols: (keyof T)[], rows: T[]): string {
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  await mkdir(join(OUT, "changes"), { recursive: true });
  const tickers = (await cached("company_tickers.json", "https://www.sec.gov/files/company_tickers.json")) as Record<
    string,
    { cik_str: number; ticker: string; title: string }
  >;
  const byTicker = new Map(Object.values(tickers).map((t) => [t.ticker, t]));

  const all: FinRow[] = [];
  const held: FinRow[] = [];
  for (const { ticker } of SUPPLIERS) {
    const t = byTicker.get(ticker);
    if (!t) throw new Error(`ticker not in SEC list: ${ticker}`);
    const cik10 = String(t.cik_str).padStart(10, "0");
    const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10}.json`;
    const cf = (await cached(`companyfacts_${cik10}.json`, factsUrl)) as {
      entityName: string;
      facts: { "us-gaap": Record<string, { units: Record<string, Fact[]> }> };
    };
    const sub = (await cached(`submissions_${cik10}.json`, `https://data.sec.gov/submissions/CIK${cik10}.json`)) as {
      sic: string;
      name: string;
    };
    const g = cf.facts["us-gaap"] ?? {};
    const ac = usd(g, "AssetsCurrent");
    const ends = [...new Set(ac.map((f) => f.end))].sort().reverse();

    const rows: FinRow[] = [];
    for (const end of ends) {
      if (rows.length >= PERIODS) break;
      // One row per quarter: skip a second balance date within a week (e.g. fresh-start accounting splits).
      if (rows.some((r) => Math.abs(days(r.period_end, end)) < 7)) continue;
      const assetsCur = first(ac, (f) => f.end === end)!;
      const liabCur = first(usd(g, "LiabilitiesCurrent"), (f) => f.end === end);
      const equity = pick(EQUITY, (c) => first(usd(g, c), (f) => f.end === end));
      let liab = first(usd(g, "Liabilities"), (f) => f.end === end)?.val;
      if (liab === undefined && equity) {
        const lse = first(usd(g, "LiabilitiesAndStockholdersEquity"), (f) => f.end === end);
        if (lse) liab = lse.val - equity.val;
      }
      const rev = pick(REVENUE, (c) => quarterValue(usd(g, c), end));
      if (!rev || !liabCur) continue; // skip periods we cannot derive honestly
      let gp = quarterValue(usd(g, "GrossProfit"), end)?.val;
      if (gp === undefined) {
        const cost = pick(COST, (c) => quarterValue(usd(g, c), end));
        if (cost) gp = rev.val - cost.val;
      }
      const gm = gp !== undefined && rev.val ? gp / rev.val : null;
      // Q4 = FY - YTD can mix restated and original figures; drop periods that come out implausible.
      if (rev.val <= 0 || (gm !== null && (gm < -1 || gm > 1))) continue;
      const accn = assetsCur.accn.replace(/-/g, "");
      rows.push({
        cik: String(t.cik_str),
        ticker,
        name: cf.entityName || sub.name,
        sic: sub.sic ?? "",
        period_end: end,
        revenue: Math.round(rev.val),
        gross_margin: gm === null ? null : r4(gm),
        current_ratio: r4(assetsCur.val / liabCur.val),
        debt_to_equity: liab !== undefined && equity && equity.val !== 0 ? r4(liab / equity.val) : null,
        source_url: `https://www.sec.gov/Archives/edgar/data/${t.cik_str}/${accn}/`,
      });
    }
    const revs = rows.map((r) => r.revenue!).sort((a, b) => a - b);
    const median = revs[Math.floor(revs.length / 2)];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].revenue! < 0.3 * median) rows.splice(i, 1);
    }
    if (rows.length < 4) console.warn(`warning: ${ticker} has only ${rows.length} derivable periods`);
    if (ticker === HOLDBACK_TICKER && rows.length > 1) held.push(rows.shift()!);
    all.push(...rows.reverse());
    const latest = rows[rows.length - 1];
    console.log(
      `${ticker.padEnd(5)} cik=${t.cik_str} periods=${rows.length} latest=${latest?.period_end} cr=${latest?.current_ratio} de=${latest?.debt_to_equity} gm=${latest?.gross_margin}`,
    );
  }

  await writeFile(join(OUT, "supplier_financials.csv"), toCsv(FIN_COLUMNS, all));
  for (const row of held) {
    const change = {
      description: `Real SEC filing for ${row.ticker} (period ${row.period_end}), held back from the base sample so the demo can show it arriving. Figures from ${row.source_url}`,
      synthetic: false,
      table: "supplier_financials",
      key: row.cik,
      row,
    };
    await writeFile(join(OUT, "changes", "01_new_quarter.json"), JSON.stringify(change, null, 2) + "\n");
  }
  const latestEnd = all.map((r) => r.period_end).sort().at(-1) ?? "";
  await writeSourceStatus([{
    source: "supplier_financials", system: "SEC EDGAR XBRL company facts", fetched_on: new Date().toISOString().slice(0, 10),
    as_of: latestEnd, row_count: all.length, url: "https://data.sec.gov/api/xbrl/companyfacts/",
  }]);
  console.log(`wrote ${all.length} rows (fetched ${new Date().toISOString()}, User-Agent "${UA}")`);
}

// Run main() only when started directly. Compare file paths, not a hand-built URL: that form never matches on Windows.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)).toLowerCase() === realpathSync(resolve(process.argv[1])).toLowerCase()) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
