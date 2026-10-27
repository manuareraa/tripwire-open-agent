// Proving Ground stage 1, Read (offline): Nemotron Parse reads each sample supplier's real 8-K filings.
//   NVIDIA_API_KEY=... tsx scripts/parse_filings.ts [--per-supplier 4] [--refresh]
// For each of the 20 suppliers in data/sample/supplier_spend.csv, picks up to N recent 8-Ks from
// data/sample/supplier_events.csv (built from EDGAR submissions by fetch_edgar.ts): filings with a
// material-risk item first (app/metrics.ts RISK_ITEMS), then other non-routine ones, newest first.
// Each primary document is fetched from EDGAR, printed to PDF with headless Chrome, and the pages that hold
// the "Item x.xx" sections are rendered to PNG and read by nvidia/nemotron-parse on build.nvidia.com.
// pdftotext is used only to find which pages to send; the text kept is Parse's. A small model
// (Nemotron 3.5 Lightning, thinking off, same endpoint) turns the parsed text into a one-line headline and a severity.
// Output (committed, so sample mode needs no key): data/cache/filings/parsed/<accession>.json and
// data/cache/filings/index.json. Cached files are reused unless --refresh. The key is read from env, never printed.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FilingEvent } from "../app/types.js";
import { RISK_ITEMS } from "../app/metrics.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "data/cache/filings");
const PARSED = join(OUT, "parsed");
const UA = process.env.SEC_USER_AGENT || "Tripwire hackathon demo manuareraa@gmail.com";
const BASE = process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
export const PARSE_MODEL = "nvidia/nemotron-parse";
export const HEADLINE_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
const PER_SUPPLIER = Number(argVal("--per-supplier") ?? 4);
const MAX_PAGES = 2;
const REFRESH = process.argv.includes("--refresh");
const CHROME = process.env.CHROME_BIN ?? "google-chrome";

function argVal(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

type Row = Record<string, string>;
interface EventRow extends Row { cik: string; filed_date: string; form: string; items: string; accession: string; url: string }

function csv<T extends Row = Row>(file: string): T[] {
  const [head, ...rows] = readFileSync(join(ROOT, file), "utf8").split(/\r?\n/).filter((l) => l.trim());
  const cols = head!.split(",");
  return rows.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])) as T);
}

/** Items the filing's text names ("Item 2.05"), in order, unique. */
export function itemsInText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/Item\s*(\d)\s*\.\s*(\d{2})/gi)) {
    const it = `${m[1]}.${m[2]}`;
    if (!out.includes(it)) out.push(it);
  }
  return out;
}

const ROUTINE = new Set(["7.01", "9.01"]);
/** Up to n filings: risk-item ones first, then non-routine, then the rest; newest first within each group. */
export function pickFilings<T extends { filed_date: string; items: string }>(rows: T[], n: number): T[] {
  const rank = (r: T) => {
    const its = r.items.split(/\s+/);
    if (its.some((i) => RISK_ITEMS.includes(i))) return 0;
    if (its.some((i) => !ROUTINE.has(i))) return 1;
    return 2;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b) || b.filed_date.localeCompare(a.filed_date)).slice(0, n);
}

async function nvidia(body: unknown): Promise<any> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error("NVIDIA_API_KEY is not set");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    throw new Error(`build.nvidia.com HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

async function parsePage(png: Buffer): Promise<string> {
  const json = await nvidia({
    model: PARSE_MODEL,
    messages: [{ role: "user", content: `<img src="data:image/png;base64,${png.toString("base64")}" />` }],
    tools: [{ type: "function", function: { name: "markdown_no_bbox" } }],
    tool_choice: { type: "function", function: { name: "markdown_no_bbox" } },
    max_tokens: 8192,
  });
  const args = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) throw new Error("Parse returned no tool call");
  const blocks = JSON.parse(args) as { text: string }[] | { text: string }[][];
  return (blocks.flat() as { text: string }[]).map((b) => b.text).join("\n\n");
}

/** The prompt holds only the filing's own text and items: deterministic, no ids or dates of this run. */
export function headlinePrompt(company: string, items: string[], text: string): string {
  return [
    `Below is text read from an SEC 8-K filing by ${company}. Items named in the filing: ${items.join(", ") || "none found"}.`,
    `Write ONE plain-English sentence (max 30 words) saying what happened, for a procurement manager deciding whether to keep this supplier.`,
    `Then rate severity for supply risk: "high" (bankruptcy, delisting, restated or unreliable accounts, auditor change, large impairment, major cyber incident, default or acceleration of debt),`,
    `"medium" (restructuring or layoffs, ending a material contract, senior officer or director departure, large new debt or acquisition), "low" (earnings release, investor presentation, routine votes, dividends, other routine news).`,
    `Answer with JSON only: {"headline": "...", "severity": "low|medium|high"}.`,
    "",
    "Filing text:",
    text.slice(0, 7000),
  ].join("\n");
}

async function headline(company: string, items: string[], text: string): Promise<{ headline: string; severity: FilingEvent["severity"] }> {
  const json = await nvidia({
    model: HEADLINE_MODEL,
    messages: [{ role: "user", content: headlinePrompt(company, items, text) }],
    temperature: 0,
    max_tokens: 300,
    chat_template_kwargs: { enable_thinking: false },
  });
  const raw = String(json.choices?.[0]?.message?.content ?? "");
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in headline answer: ${raw.slice(0, 120)}`);
  const parsed = JSON.parse(m[0]) as { headline?: string; severity?: string };
  const severity = ["low", "medium", "high"].includes(String(parsed.severity)) ? (parsed.severity as FilingEvent["severity"]) : "low";
  return { headline: String(parsed.headline ?? "").trim(), severity };
}

interface ParsedFiling {
  accession: string;
  cik: string;
  supplier_id: string;
  company: string;
  filed: string;
  metadata_items: string[];
  source_url: string;
  pages_read: number[];
  pages_total: number;
  parsed_by: string;
  parsed_text: string;
  text_hash: string;
  parse_ms: number;
  parse_calls: number;
  headline_by: string;
  headline: string;
  severity: FilingEvent["severity"];
  read_at: string;
}

async function readOne(row: EventRow, supplierId: string, company: string): Promise<ParsedFiling> {
  const work = mkdtempSync(join(tmpdir(), "tw-8k-"));
  try {
    const res = await fetch(row.url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`EDGAR HTTP ${res.status} for ${row.url}`);
    writeFileSync(join(work, "doc.htm"), Buffer.from(await res.arrayBuffer()));
    await sleep(250); // SEC fair-access: well under 10 requests a second
    execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", `--user-data-dir=${join(work, "chrome")}`,
      `--print-to-pdf=${join(work, "doc.pdf")}`, "--no-pdf-header-footer", `file://${join(work, "doc.htm")}`], { stdio: "ignore", timeout: 90_000 });
    const info = execFileSync("pdfinfo", [join(work, "doc.pdf")]).toString();
    const total = Number(info.match(/Pages:\s+(\d+)/)?.[1] ?? 1);
    let first = 1;
    for (let p = 1; p <= total; p++) {
      const t = execFileSync("pdftotext", ["-f", String(p), "-l", String(p), join(work, "doc.pdf"), "-"]).toString();
      if (/Item\s*\d\s*\.\s*\d{2}/i.test(t)) { first = p; break; }
    }
    const pages = Array.from({ length: Math.min(MAX_PAGES, total - first + 1) }, (_, i) => first + i);
    const t0 = Date.now();
    const texts: string[] = [];
    for (const p of pages) {
      execFileSync("pdftoppm", ["-r", "130", "-f", String(p), "-l", String(p), "-png", "-singlefile", join(work, "doc.pdf"), join(work, `p${p}`)]);
      texts.push(await parsePage(readFileSync(join(work, `p${p}.png`))));
    }
    const parse_ms = Date.now() - t0;
    const parsed_text = texts.join("\n\n");
    const items = itemsInText(parsed_text);
    const h = await headline(company, items, parsed_text);
    return {
      accession: row.accession, cik: row.cik, supplier_id: supplierId, company, filed: row.filed_date,
      metadata_items: row.items.split(/\s+/).filter(Boolean), source_url: row.url,
      pages_read: pages, pages_total: total, parsed_by: PARSE_MODEL, parsed_text, text_hash: sha256(parsed_text),
      parse_ms, parse_calls: pages.length, headline_by: HEADLINE_MODEL, ...h, read_at: new Date().toISOString(),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function toEvent(p: ParsedFiling): FilingEvent {
  return {
    id: `8k-${p.accession}`,
    supplier_id: p.supplier_id,
    accession: p.accession,
    filed: p.filed,
    items: itemsInText(p.parsed_text),
    headline: p.headline,
    severity: p.severity,
    source_url: p.source_url,
    parsed_by: p.parsed_by,
    text_hash: p.text_hash,
  };
}

/** Do the items Parse read agree with EDGAR's item metadata? Only items on the pages read can be found. */
export function crossCheck(files: ParsedFiling[]) {
  let risk_agree = 0, exact = 0, meta_items = 0, found_items = 0;
  for (const f of files) {
    const read = itemsInText(f.parsed_text);
    const metaRisk = f.metadata_items.some((i) => RISK_ITEMS.includes(i));
    const readRisk = read.some((i) => RISK_ITEMS.includes(i));
    if (metaRisk === readRisk) risk_agree++;
    const metaSet = [...f.metadata_items].sort().join(" ");
    if (metaSet === [...read].sort().join(" ")) exact++;
    meta_items += f.metadata_items.length;
    found_items += f.metadata_items.filter((i) => read.includes(i)).length;
  }
  return {
    filings: files.length,
    risk_flag_agree: risk_agree,
    exact_item_match: exact,
    metadata_items: meta_items,
    metadata_items_found_by_parse: found_items,
  };
}

async function main() {
  mkdirSync(PARSED, { recursive: true });
  const spend = csv("data/sample/supplier_spend.csv");
  const fin = csv("data/sample/supplier_financials.csv");
  const events = csv<EventRow>("data/sample/supplier_events.csv").filter((r) => r.form?.startsWith("8-K"));
  const files: ParsedFiling[] = [];
  let calls = 0;
  for (const s of spend) {
    const company = fin.find((f) => f.cik === s.cik)?.name ?? `CIK ${s.cik}`;
    for (const row of pickFilings(events.filter((e) => e.cik === s.cik), PER_SUPPLIER)) {
      const path = join(PARSED, `${row.accession}.json`);
      if (existsSync(path) && !REFRESH) {
        files.push(JSON.parse(readFileSync(path, "utf8")));
        continue;
      }
      try {
        const p = await readOne(row, s.supplier_id!, company);
        writeFileSync(path, JSON.stringify(p, null, 2) + "\n");
        files.push(p);
        calls += p.parse_calls + 1;
        console.log(`${s.supplier_id} ${row.filed_date} ${row.accession} pages ${p.pages_read.join(",")}/${p.pages_total} [${p.severity}] ${p.headline}`);
      } catch (e) {
        console.log(`${s.supplier_id} ${row.accession} FAILED: ${(e as Error).message.slice(0, 200)}`);
      }
    }
  }
  // Keep only files that belong to the current pick (a smaller --per-supplier drops the rest from the index).
  const known = new Set(files.map((f) => f.accession));
  for (const f of readdirSync(PARSED)) if (!known.has(f.replace(/\.json$/, ""))) console.log(`(not in this pick, left out of index: ${f})`);
  const bySupplier: Record<string, FilingEvent[]> = {};
  for (const f of files) (bySupplier[f.supplier_id] ??= []).push(toEvent(f));
  for (const list of Object.values(bySupplier)) list.sort((a, b) => b.filed.localeCompare(a.filed));
  const index = {
    note: "8-K documents fetched from EDGAR and read by Nemotron Parse (build.nvidia.com); headline and severity by Nemotron 3.5 Lightning from the parsed text. Written by scripts/parse_filings.ts.",
    parse_model: PARSE_MODEL,
    headline_model: HEADLINE_MODEL,
    read_at: files.map((f) => f.read_at).sort().at(-1) ?? null,
    per_supplier_cap: PER_SUPPLIER,
    parse_calls: files.reduce((n, f) => n + f.parse_calls, 0),
    headline_calls: files.length,
    parse_ms_total: files.reduce((n, f) => n + f.parse_ms, 0),
    cross_check: crossCheck(files),
    by_supplier: bySupplier,
  };
  writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 2) + "\n");
  console.log(`index: ${files.length} filings for ${Object.keys(bySupplier).length} suppliers; new model calls this run: ${calls}`);
  console.log(JSON.stringify(index.cross_check));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
