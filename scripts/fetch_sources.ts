// Builds the two extra real fragments from public sources:
//   data/sample/supplier_events.csv   SEC EDGAR 8-K filings (material events) for each supplier, last 12 months
//   data/sample/sanctions_screen.csv  each supplier's name screened against the US Treasury OFAC SDN list
// Usage: npx tsx scripts/fetch_sources.ts [--refresh]
// Raw downloads are cached in data/cache/ (gitignored). Nothing is estimated; a screen with no match says so.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UA = process.env.SEC_USER_AGENT || "Tripwire hackathon demo manuareraa@gmail.com";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, "data/cache");
const OUT = join(ROOT, "data/sample");
const REFRESH = process.argv.includes("--refresh");
const EVENT_DAYS = 365;
const SDN_URL = "https://www.treasury.gov/ofac/downloads/sdn.csv";
const ALT_URL = "https://www.treasury.gov/ofac/downloads/alt.csv";

/**
 * One real 8-K (by accession number) held back from the base CSV and shipped as change file 04, so the demo can show
 * a real filing "arriving". Default: Dow Inc.'s 8-K of 2026-01-29 (item 2.05, exit or restructuring costs). "" = none.
 */
export const HOLDBACK_EVENT = process.env.HOLDBACK_EVENT ?? "0001751788-26-000009";

let lastRequest = 0;
async function get(url: string): Promise<{ body: string; lastModified?: string }> {
  const wait = lastRequest + 220 - Date.now(); // <= 5 requests/second (SEC fair access)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Encoding": "gzip, deflate" }, redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return { body: await res.text(), lastModified: res.headers.get("last-modified") ?? undefined };
}

async function cached(name: string, url: string): Promise<{ body: string; lastModified?: string; fetchedAt?: string }> {
  const path = join(CACHE, name);
  const meta = `${path}.meta.json`;
  if (!REFRESH && existsSync(path)) {
    const m = existsSync(meta) ? JSON.parse(await readFile(meta, "utf8")) : {};
    return { body: await readFile(path, "utf8"), lastModified: m.lastModified, fetchedAt: m.fetchedAt };
  }
  const r = await get(url);
  const fetchedAt = new Date().toISOString();
  await writeFile(path, r.body);
  await writeFile(meta, JSON.stringify({ url, lastModified: r.lastModified, fetchedAt }));
  return { ...r, fetchedAt };
}

// ---------- CSV ----------

export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), out.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell !== "" || row.length) row.push(cell), out.push(row);
  return out.filter((r) => r.length > 1 || r[0] !== "");
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (cols: string[], rows: Record<string, unknown>[]) =>
  [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";

// ---------- source status ----------

export interface SourceStatusRow { source: string; system: string; fetched_on: string; as_of: string; row_count: number; url: string }
const STATUS_COLS = ["source", "system", "fetched_on", "as_of", "row_count", "url"];

/** Record when each source was fetched and what date its contents are current to, merging by source. */
export async function writeSourceStatus(rows: SourceStatusRow[], dir = OUT): Promise<void> {
  const file = join(dir, "source_status.csv");
  const merged = new Map<string, Record<string, unknown>>();
  if (existsSync(file)) {
    const [h, ...body] = parseCsv(await readFile(file, "utf8"));
    for (const r of body) merged.set(r[h.indexOf("source")], Object.fromEntries(h.map((c, i) => [c, r[i]])));
  }
  for (const r of rows) merged.set(r.source, { ...r });
  const sorted = [...merged.values()].sort((a, b) => String(a.source).localeCompare(String(b.source)));
  await writeFile(file, toCsv(STATUS_COLS, sorted));
}

// ---------- name screening ----------

const SUFFIXES = new Set(["INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "LIMITED", "LLC", "PLC", "SA", "NV", "LP", "THE", "HOLDINGS", "HOLDING", "GROUP", "DE"]);

/** Uppercase words with punctuation and legal-form suffixes removed: "Jabil Inc." -> ["JABIL"]. */
export function nameTokens(name: string): string[] {
  return name.toUpperCase().replace(/&/g, " AND ").replace(/[^A-Z0-9 ]+/g, " ").split(/\s+/).filter((t) => t && !SUFFIXES.has(t));
}

/**
 * A listed name matches a supplier when the cleaned names are equal, or (for supplier names of 2+ words) the
 * supplier's words appear in order inside the listed name. One-word names need an exact match: "DOW" must not
 * hit every entity with Dow in its name. This is a screen that flags candidates for a person, not a verdict.
 */
export function namesMatch(supplier: string, listed: string): boolean {
  const a = nameTokens(supplier);
  const b = nameTokens(listed);
  if (!a.length || !b.length) return false;
  if (a.join(" ") === b.join(" ")) return true;
  if (a.length < 2) return false;
  return ` ${b.join(" ")} `.includes(` ${a.join(" ")} `);
}

// ---------- 8-K items ----------

/** 8-K item numbers (SEC Form 8-K) and plain names. */
export const ITEM_NAMES: Record<string, string> = {
  "1.01": "material agreement entered", "1.02": "material agreement terminated", "1.03": "bankruptcy or receivership",
  "1.05": "cybersecurity incident", "2.01": "acquisition or disposal completed", "2.02": "results of operations",
  "2.03": "new direct financial obligation", "2.04": "debt acceleration triggered", "2.05": "exit or restructuring costs",
  "2.06": "material impairment", "3.01": "delisting notice", "3.02": "unregistered equity sale", "3.03": "rights of holders modified",
  "4.01": "auditor changed", "4.02": "prior financials no longer reliable", "5.01": "change in control",
  "5.02": "director or officer change", "5.03": "bylaws amended", "5.07": "shareholder vote", "7.01": "Regulation FD disclosure",
  "8.01": "other events", "9.01": "financial statements and exhibits",
};

async function main() {
  await mkdir(CACHE, { recursive: true });
  await mkdir(join(OUT, "changes"), { recursive: true });
  const [fh, ...fin] = parseCsv(await readFile(join(OUT, "supplier_financials.csv"), "utf8"));
  const [sh, ...spend] = parseCsv(await readFile(join(OUT, "supplier_spend.csv"), "utf8"));
  const names = new Map<string, { name: string; ticker: string }>();
  for (const r of fin) names.set(r[fh.indexOf("cik")], { name: r[fh.indexOf("name")], ticker: r[fh.indexOf("ticker")] });
  const ciks = [...new Set(spend.map((r) => r[sh.indexOf("cik")]))];
  const fetchedOn = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - EVENT_DAYS * 86400_000).toISOString().slice(0, 10);

  // SEC 8-K events
  const events: Record<string, unknown>[] = [];
  const pulls: string[] = [];
  for (const cik of ciks) {
    const cik10 = cik.padStart(10, "0");
    const got = await cached(`submissions_${cik10}.json`, `https://data.sec.gov/submissions/CIK${cik10}.json`);
    if (got.fetchedAt) pulls.push(got.fetchedAt.slice(0, 10));
    const sub = JSON.parse(got.body) as {
      filings: { recent: { form: string[]; filingDate: string[]; items: string[]; accessionNumber: string[]; primaryDocument: string[] } };
    };
    const r = sub.filings.recent;
    for (let i = 0; i < r.form.length; i++) {
      if (r.form[i] !== "8-K" && r.form[i] !== "8-K/A") continue;
      if (r.filingDate[i] < since) continue;
      const acc = r.accessionNumber[i];
      events.push({
        cik, filed_date: r.filingDate[i], form: r.form[i], items: r.items[i].split(",").map((s) => s.trim()).filter(Boolean).join(" "),
        accession: acc, url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, "")}/${r.primaryDocument[i]}`,
      });
    }
  }
  // The feed is only as current as its oldest per-company pull.
  const eventsFetchedOn = pulls.sort()[0] ?? fetchedOn;
  events.sort((a, b) => String(a.cik).localeCompare(String(b.cik)) || String(b.filed_date).localeCompare(String(a.filed_date)));

  let held: Record<string, unknown> | undefined;
  if (HOLDBACK_EVENT) {
    const i = events.findIndex((e) => e.accession === HOLDBACK_EVENT);
    if (i < 0) throw new Error(`8-K ${HOLDBACK_EVENT} is not in the ${EVENT_DAYS}-day window`);
    held = events.splice(i, 1)[0];
  }
  const EVENT_COLS = ["cik", "filed_date", "form", "items", "accession", "url"];
  await writeFile(join(OUT, "supplier_events.csv"), toCsv(EVENT_COLS, events));
  if (held) {
    const ticker = names.get(String(held.cik))?.ticker ?? String(held.cik);
    const items = String(held.items).split(" ").map((x) => `${x} ${ITEM_NAMES[x] ?? ""}`.trim()).join("; ");
    const change = {
      description: `Real SEC 8-K for ${ticker} filed ${held.filed_date} (items: ${items}), held back from the base sample so the demo can show it arriving. ${held.url}`,
      synthetic: false, table: "supplier_events", key: held.cik, row: held,
    };
    await writeFile(join(OUT, "changes", "04_new_8k.json"), JSON.stringify(change, null, 2) + "\n");
  }

  // OFAC SDN screen
  const sdn = await cached("ofac_sdn.csv", SDN_URL);
  const alt = await cached("ofac_alt.csv", ALT_URL);
  const listed: string[] = [];
  for (const r of parseCsv(sdn.body)) if (r[1]) listed.push(r[1]);
  for (const r of parseCsv(alt.body)) if (r[3]) listed.push(r[3]);
  const entries = parseCsv(sdn.body).length;
  const sdnFetchedOn = sdn.fetchedAt?.slice(0, 10) ?? fetchedOn;
  const asOf = sdn.lastModified ? new Date(sdn.lastModified).toISOString().slice(0, 10) : fetchedOn;
  const screen = ciks.map((cik) => {
    const name = names.get(cik)?.name ?? "";
    const hits = [...new Set(listed.filter((l) => namesMatch(name, l)))];
    return {
      cik, name, list: "OFAC SDN", list_as_of: asOf, list_entries: entries, match_count: hits.length,
      matches: hits.slice(0, 5).join("; "), screened_on: sdnFetchedOn, source_url: SDN_URL,
    };
  });
  const SCREEN_COLS = ["cik", "name", "list", "list_as_of", "list_entries", "match_count", "matches", "screened_on", "source_url"];
  await writeFile(join(OUT, "sanctions_screen.csv"), toCsv(SCREEN_COLS, screen));

  await writeSourceStatus([
    { source: "supplier_events", system: "SEC EDGAR 8-K filings (submissions API)", fetched_on: eventsFetchedOn, as_of: eventsFetchedOn, row_count: events.length, url: "https://data.sec.gov/submissions/" },
    { source: "sanctions_screen", system: "US Treasury OFAC SDN list", fetched_on: sdnFetchedOn, as_of: asOf, row_count: entries, url: SDN_URL },
  ]);

  console.log(`${events.length} 8-K events since ${since} for ${ciks.length} suppliers${held ? ` (+1 held back: ${held.accession} ${held.filed_date})` : ""}`);
  console.log(`OFAC SDN as of ${asOf}: ${entries} entries + aliases; ${screen.filter((s) => s.match_count > 0).length} suppliers with a name match`);
  for (const s of screen.filter((x) => x.match_count > 0)) console.log(`  ${s.name}: ${s.matches}`);
}

// Run main() only when started directly. Compare file paths, not a hand-built URL: that form never matches on Windows.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)).toLowerCase() === realpathSync(resolve(process.argv[1])).toLowerCase()) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
