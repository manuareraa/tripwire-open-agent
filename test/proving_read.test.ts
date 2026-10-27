import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FILINGS_INDEX, loadFilingsIndex, readFilings, type FilingsIndex } from "../app/proving/filings.js";
import { crossCheck, headlinePrompt, itemsInText, pickFilings, toEvent } from "../scripts/parse_filings.js";
import type { Deps, RunState } from "../app/orchestration/state.js";
import type { FilingEvent } from "../app/types.js";

function state(subject_id: string): RunState {
  return { decision_id: "DEC-T", subject_id, proving: {} } as unknown as RunState;
}
function deps() {
  const emit = vi.fn();
  return { d: { tracer: { emit } } as unknown as Deps, emit };
}
const ev = (id: string, severity: FilingEvent["severity"], filed: string): FilingEvent => ({
  id, supplier_id: "SUP-01", accession: id, filed, items: ["8.01"], headline: `h ${id}`, severity,
  source_url: "https://www.sec.gov/x.htm", parsed_by: "nvidia/nemotron-parse", text_hash: "a".repeat(64),
});
const INDEX: FilingsIndex = {
  parse_model: "nvidia/nemotron-parse", headline_model: "nvidia/nemotron-3.5-lightning-30b-a3b", read_at: "2026-10-27T15:00:00.000Z",
  by_supplier: { "SUP-01": [ev("a", "low", "2026-09-01"), ev("b", "high", "2026-03-01"), ev("c", "medium", "2026-08-01"), ev("d", "high", "2026-05-01")] },
};

describe("readFilings (stage 1, Read)", () => {
  it("loads the cached events, highest severity first, and emits one nvidia trace event", async () => {
    const s = state("SUP-01");
    const { d, emit } = deps();
    await readFilings(d, s, INDEX);
    expect(s.proving.filings!.map((f) => f.id)).toEqual(["d", "b", "c", "a"]);
    expect(s.proving.skipped).toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(1);
    const e = emit.mock.calls[0]![0];
    expect(e).toMatchObject({ agent_name: "FilingReader", sponsor: "nvidia", event: "sponsor_call", status: "success" });
    expect(e.output_summary).toContain("4 8-K filings read by nvidia/nemotron-parse");
    expect(e.output_summary).toContain("2026-10-27");
    expect(e.output_summary).toContain("2 high severity");
  });

  it("adds nothing to findings and records a plain reason when a supplier has no readings", async () => {
    const s = state("SUP-99");
    (s as unknown as { findings: unknown[] }).findings = [];
    const { d, emit } = deps();
    await readFilings(d, s, INDEX);
    expect(s.proving.filings).toBeUndefined();
    expect(s.proving.skipped).toEqual(["read: no 8-K filings read for SUP-99"]);
    expect((s as unknown as { findings: unknown[] }).findings).toEqual([]);
    expect(emit.mock.calls[0]![0].sponsor).toBeUndefined();
  });

  it("skips honestly when there is no cache file", async () => {
    const s = state("SUP-01");
    await readFilings(deps().d, s, loadFilingsIndex("/nonexistent/index.json"));
    expect(s.proving.skipped![0]).toMatch(/no cached 8-K readings/);
  });
});

describe("parse_filings helpers", () => {
  it("reads item numbers from parsed text, in order, once each", () => {
    expect(itemsInText("**Item 2.05** Costs ... ITEM 5.02 Departure ... Item 2.05 again ... Item 9 . 01")).toEqual(["2.05", "5.02", "9.01"]);
    expect(itemsInText("no items here")).toEqual([]);
  });

  it("picks risk-item filings first, then non-routine, newest first, capped", () => {
    const rows = [
      { filed_date: "2026-10-01", items: "2.02 9.01" },
      { filed_date: "2026-09-01", items: "7.01 9.01" },
      { filed_date: "2026-01-01", items: "2.05" },
      { filed_date: "2026-06-01", items: "5.02" },
      { filed_date: "2026-03-01", items: "4.02 9.01" },
    ];
    expect(pickFilings(rows, 4).map((r) => r.filed_date)).toEqual(["2026-03-01", "2026-01-01", "2026-10-01", "2026-06-01"]);
  });

  it("cross-checks Parse's items against EDGAR's item metadata", () => {
    const f = (meta: string[], text: string) => ({ metadata_items: meta, parsed_text: text }) as Parameters<typeof crossCheck>[0][number];
    const r = crossCheck([f(["2.05", "9.01"], "Item 2.05 ... Item 9.01"), f(["4.02"], "Item 8.01"), f(["7.01"], "Item 7.01")]);
    expect(r).toEqual({ filings: 3, risk_flag_agree: 2, exact_item_match: 2, metadata_items: 4, metadata_items_found_by_parse: 3 });
  });

  it("headline prompt is deterministic (no run ids or clock)", () => {
    expect(headlinePrompt("ACME", ["8.01"], "text")).toBe(headlinePrompt("ACME", ["8.01"], "text"));
    expect(headlinePrompt("ACME", ["8.01"], "text")).not.toMatch(/DEC-|20\d\d-\d\d-\d\dT/);
  });
});

describe.skipIf(!existsSync(FILINGS_INDEX))("committed 8-K cache", () => {
  const load = () => JSON.parse(readFileSync(FILINGS_INDEX, "utf8")) as FilingsIndex;
  const parsedDir = join(FILINGS_INDEX, "../parsed");

  it("covers the 20 sample suppliers, read by Nemotron Parse, with unique ids", () => {
    const index = load();
    expect(Object.keys(index.by_supplier).length).toBe(20);
    const all = Object.values(index.by_supplier).flat();
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    for (const e of all) {
      expect(e.parsed_by).toBe("nvidia/nemotron-parse");
      expect(e.source_url).toMatch(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//);
      expect(e.headline.length).toBeGreaterThan(10);
      expect(["low", "medium", "high"]).toContain(e.severity);
    }
  });

  it("every event's text_hash is the SHA-256 of the cached parsed text", () => {
    for (const file of readdirSync(parsedDir)) {
      const p = JSON.parse(readFileSync(join(parsedDir, file), "utf8"));
      expect(createHash("sha256").update(p.parsed_text, "utf8").digest("hex")).toBe(p.text_hash);
      expect(toEvent(p).text_hash).toBe(p.text_hash);
    }
  });
});
