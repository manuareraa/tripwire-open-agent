import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SampleDataGateway, resultHash } from "../app/adapters/sample_data.js";
import { ROW_KEY, TABLES, TEMPLATES, renderTemplate } from "../app/sql/templates.js";
import type { Decision } from "../app/types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_SAMPLE = join(REPO_ROOT, "data/sample");

const templateParams: Record<string, Record<string, string | number>> = {
  supplier_spend_row: { supplier_id: "SUP-18" },
  supplier_financials_latest: { cik: "898293" },
  supplier_financials_history: { cik: "898293", periods: 4 },
  category_concentration: { category: "electronic_components" },
  decisions_for_supplier: { supplier_id: "SUP-18" },
  supplier_events_recent: { cik: "898293" },
  sanctions_screen_row: { cik: "898293" },
  source_status: {},
};

function makeDecision(partial: Partial<Decision> & Pick<Decision, "decision_id" | "subject_id">): Decision {
  return {
    decision: "keep",
    confidence: 0.75,
    status: "proposed",
    findings: [],
    evidence: [],
    tripwires: [],
    limitations: [],
    escalated: false,
    created_at: "2026-10-22T12:00:00.000Z",
    ...partial,
  };
}

function freshLedger(): string {
  return mkdtempSync(join(tmpdir(), "tripwire-ledger-"));
}

function copySampleDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tripwire-sample-"));
  cpSync(BUNDLED_SAMPLE, dir, { recursive: true });
  return dir;
}

const tmpDirs: string[] = [];

function trackDir(path: string): string {
  tmpDirs.push(path);
  return path;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe("SampleDataGateway", () => {
  it("runs every template with valid params and consistent evidence", async () => {
    const ledgerDir = trackDir(freshLedger());
    const gw = new SampleDataGateway({ ledgerDir, sampleDir: BUNDLED_SAMPLE });

    await gw.writeDecision(
      makeDecision({
        decision_id: "DEC-SUP-18-001",
        subject_id: "SUP-18",
        created_at: "2026-10-22T11:00:00.000Z",
      }),
    );

    for (const t of TEMPLATES) {
      const params = templateParams[t.id];
      expect(params).toBeDefined();

      const result = await gw.runTemplate(t.id, params);

      expect(result.sample).toBe(true);
      expect(result.evidence.template_id).toBe(t.id);
      expect(result.evidence.params).toEqual(params);
      expect(result.evidence.sql).toBe(renderTemplate(t.id, params));
      expect(result.evidence.table).toBe(t.table);
      expect(result.evidence.result_hash).toBe(resultHash(result.rows));

      const keyCol = ROW_KEY[t.table];
      const rowKeys = [...new Set(result.rows.map((r) => String(r[keyCol])))].sort();
      const depKeys = result.evidence.depends_on.map((d) => d.key).sort();
      expect(depKeys).toEqual(rowKeys);
      expect(result.evidence.depends_on.every((d) => d.table === t.table)).toBe(true);

      if (t.id === "supplier_spend_row") {
        expect(result.rows.length).toBeGreaterThan(0);
        expect(result.rows[0].supplier_id).toBe("SUP-18");
      }
      if (t.id === "decisions_for_supplier") {
        expect(result.rows.length).toBeGreaterThan(0);
      }
    }
  });

  it("result_hash is stable across instances and insensitive to row/key order", async () => {
    const ledgerDir = trackDir(freshLedger());
    const sampleDir = trackDir(copySampleDir());
    const params = { category: "chemicals" };

    const gw1 = new SampleDataGateway({ ledgerDir, sampleDir });
    const gw2 = new SampleDataGateway({ ledgerDir, sampleDir });

    const a = await gw1.runTemplate("category_concentration", params);
    const b = await gw2.runTemplate("category_concentration", params);

    expect(a.evidence.result_hash).toBe(resultHash(a.rows));
    expect(a.evidence.result_hash).toBe(b.evidence.result_hash);
    expect(a.evidence.result_hash).toBe(resultHash([...a.rows].reverse()));

    const permutedKeys = a.rows.map((row) => {
      const entries = Object.entries(row);
      return Object.fromEntries(entries.reverse());
    });
    expect(a.evidence.result_hash).toBe(resultHash(permutedKeys));

    const beforeHash = a.evidence.result_hash;
    await gw1.applyChange("02_spend_share_jump.json");
    const after = await gw1.runTemplate("category_concentration", params);
    expect(after.evidence.result_hash).not.toBe(beforeHash);
  });

  it("supplier_financials_latest for cik 103730 reflects scripted quarter change", async () => {
    const ledgerDir = trackDir(freshLedger());
    const sampleDir = trackDir(copySampleDir());
    const gw = new SampleDataGateway({ ledgerDir, sampleDir });

    const before = await gw.runTemplate("supplier_financials_latest", { cik: "103730" });
    expect(before.rows[0]?.period_end).toBe("2026-04-04");

    await gw.applyChange("01_new_quarter.json");
    const after = await gw.runTemplate("supplier_financials_latest", { cik: "103730" });
    expect(after.rows[0]?.period_end).toBe("2026-07-04");
    expect(after.rows[0]?.current_ratio).toBe(1.8022);
  });

  it("changesSince tracks applied changes, markers, replay, and reset", async () => {
    const ledgerDir = trackDir(freshLedger());
    const sampleDir = trackDir(copySampleDir());
    const gw = new SampleDataGateway({ ledgerDir, sampleDir });

    const applied = await gw.applyChange("01_new_quarter.json");
    const first = await gw.changesSince("0");
    expect(first.changes).toEqual(applied);
    expect(first.marker).not.toBe("0");

    const second = await gw.changesSince(first.marker);
    expect(second.changes).toEqual([]);

    const replayed = new SampleDataGateway({ ledgerDir, sampleDir });
    const latest = await replayed.runTemplate("supplier_financials_latest", { cik: "103730" });
    expect(latest.rows[0]?.period_end).toBe("2026-07-04");

    replayed.resetChanges();
    const restored = await replayed.runTemplate("supplier_financials_latest", { cik: "103730" });
    expect(restored.rows[0]?.period_end).toBe("2026-04-04");
  });

  it("writeDecision, readDecisions, and decisions_for_supplier behave as append-only ledger", async () => {
    const ledgerDir = trackDir(freshLedger());
    const gw = new SampleDataGateway({ ledgerDir, sampleDir: BUNDLED_SAMPLE });
    const ledgerPath = join(ledgerDir, `${TABLES.decisions}.jsonl`);

    const d1 = makeDecision({
      decision_id: "DEC-A",
      subject_id: "SUP-18",
      status: "proposed",
      created_at: "2026-09-01T10:00:00.000Z",
    });
    const d1Approved = { ...d1, status: "approved" as const, approved_by_reason: "demo" };
    const d2 = makeDecision({
      decision_id: "DEC-B",
      subject_id: "SUP-18",
      created_at: "2026-10-01T10:00:00.000Z",
    });

    await gw.writeDecision(d1);
    await gw.writeDecision(d1Approved);
    await gw.writeDecision(d2);

    expect(existsSync(ledgerPath)).toBe(true);
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);

    const decisions = await gw.readDecisions();
    expect(decisions).toHaveLength(2);
    const byId = Object.fromEntries(decisions.map((d) => [d.decision_id, d]));
    expect(byId["DEC-A"].status).toBe("approved");
    expect(byId["DEC-B"].status).toBe("proposed");

    const query = await gw.runTemplate("decisions_for_supplier", { supplier_id: "SUP-18" });
    expect(query.rows.length).toBeGreaterThanOrEqual(2);
    expect(query.rows.every((r) => r.supplier_id === "SUP-18")).toBe(true);
    const ids = query.rows.map((r) => r.decision_id);
    expect(ids.indexOf("DEC-B")).toBeLessThan(ids.indexOf("DEC-A"));
  });

  it("rejects invalid template params", async () => {
    const ledgerDir = trackDir(freshLedger());
    const gw = new SampleDataGateway({ ledgerDir, sampleDir: BUNDLED_SAMPLE });

    await expect(gw.runTemplate("supplier_spend_row", { supplier_id: "SUP-9999" })).rejects.toThrow(
      "invalid supplier_id",
    );
    await expect(gw.runTemplate("supplier_financials_latest", { cik: "not-a-cik" })).rejects.toThrow(
      "invalid cik",
    );
    await expect(gw.runTemplate("category_concentration", { category: "Bad-Category" })).rejects.toThrow(
      "invalid category",
    );
    await expect(gw.runTemplate("supplier_spend_row", {})).rejects.toThrow("missing param supplier_id");
  });
});
