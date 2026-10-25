import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HmemMemoryStore,
  callHmem,
  checkStale,
  parseLineageRef,
  rowKey,
} from "../app/adapters/hmem.js";
import type { MemoryClaim, RowRef } from "../app/types.js";

const FIXED_CLOCK = () => 1_750_000_000_000;

function memoryStore(): HmemMemoryStore {
  return new HmemMemoryStore({ persistDir: null, clock: FIXED_CLOCK });
}

const SHARED_FINANCIALS: RowRef = { table: "supplier_financials", key: "parent-acme" };
const SHARED_HASH = "hash-parent-acme-v1";

async function seedPortfolio(store: HmemMemoryStore): Promise<void> {
  for (let i = 1; i <= 20; i++) {
    const n = String(i).padStart(2, "0");
    const subject_id = `sup-${n}`;
    const decision_id = `dec-${n}`;
    const spendRow: RowRef = { table: "supplier_spend", key: subject_id };
    const derivedFrom = [{ row: spendRow, result_hash: `hash-spend-${n}` }];
    if (n === "03" || n === "11" || n === "17") {
      derivedFrom.push({ row: SHARED_FINANCIALS, result_hash: SHARED_HASH });
    }
    await store.remember({
      subject_id,
      decision_id,
      text: `Annual spend for ${subject_id} is within tolerance`,
      metric: "annual_spend",
      value: 1_000 * i,
      derivedFrom,
    });
  }
}

function claimForDecision(store: HmemMemoryStore, decision_id: string): MemoryClaim {
  const claims = store.claimsForDecision(decision_id);
  expect(claims).toHaveLength(1);
  return claims[0]!;
}

describe("HmemMemoryStore", () => {
  describe("remember and get", () => {
    it("records lineage, decision_id, metric, value and round-trips via get()", async () => {
      const store = memoryStore();
      const spend: RowRef = { table: "supplier_spend", key: "sup-99" };
      const fin: RowRef = { table: "supplier_financials", key: "parent-x" };
      const created = await store.remember({
        subject_id: "sup-99",
        decision_id: "dec-99",
        text: "Spend ratio acceptable",
        metric: "spend_ratio",
        value: 0.42,
        derivedFrom: [
          { row: spend, result_hash: "abc123" },
          { row: fin, result_hash: "def456" },
        ],
      });

      expect(created.id).toBeTruthy();
      expect(created.subject_id).toBe("sup-99");
      expect(created.decision_id).toBe("dec-99");
      expect(created.metric).toBe("spend_ratio");
      expect(created.value).toBe(0.42);
      expect(created.derivedFrom).toEqual([
        { row: spend, result_hash: "abc123" },
        { row: fin, result_hash: "def456" },
      ]);
      expect(created.created_at).toBe(new Date(FIXED_CLOCK()).toISOString());

      const loaded = store.get(created.id);
      expect(loaded).toEqual(created);
    });

    it("round-trips the query template in lineage and still reads refs written without one", async () => {
      const store = memoryStore();
      const row: RowRef = { table: "supplier_spend", key: "SUP/7@x" };
      const created = await store.remember({
        subject_id: "SUP/7@x", decision_id: "dec-7", text: "Lead time 12 weeks",
        derivedFrom: [{ row, result_hash: "h1", template_id: "supplier_spend_row" }],
      });
      expect(store.get(created.id)!.derivedFrom).toEqual([{ row, result_hash: "h1", template_id: "supplier_spend_row" }]);
      expect(parseLineageRef("row:supplier_spend/SUP-01#h2")).toEqual({ row: { table: "supplier_spend", key: "SUP-01" }, result_hash: "h2" });
    });
  });

  describe("portfolio dependentsOf", () => {
    let store: HmemMemoryStore;

    beforeEach(async () => {
      store = memoryStore();
      await seedPortfolio(store);
    });

    it("maps shared financials row to dec-03, dec-11, dec-17 only", async () => {
      await expect(store.dependentsOf(SHARED_FINANCIALS)).resolves.toEqual([
        "dec-03",
        "dec-11",
        "dec-17",
      ]);
    });

    it("maps each supplier_spend row to its single decision", async () => {
      await expect(store.dependentsOf({ table: "supplier_spend", key: "sup-07" })).resolves.toEqual([
        "dec-07",
      ]);
      await expect(store.dependentsOf({ table: "supplier_spend", key: "sup-03" })).resolves.toEqual([
        "dec-03",
      ]);
    });

    it("returns [] for an unknown row", async () => {
      await expect(store.dependentsOf({ table: "no_such_table", key: "ghost" })).resolves.toEqual([]);
    });
  });

  describe("supersede", () => {
    it("links claims, chain(), and removes superseded from dependentsOf and recall", async () => {
      const store = memoryStore();
      await seedPortfolio(store);
      const old = claimForDecision(store, "dec-05");
      const spendRow: RowRef = { table: "supplier_spend", key: "sup-05" };

      const newer = await store.supersede(old.id, {
        subject_id: "sup-05",
        decision_id: "dec-05",
        text: "Annual spend for sup-05 revised upward",
        metric: "annual_spend",
        value: 9_999,
        derivedFrom: [{ row: spendRow, result_hash: "hash-spend-05-revised" }],
      });

      expect(store.supersededBy(old.id)).toBe(newer.id);
      expect(newer.supersedes).toBe(old.id);
      expect(store.chain(newer.id)).toEqual([newer.id, old.id]);

      await expect(store.dependentsOf(spendRow)).resolves.toEqual(["dec-05"]);

      const recalled = await store.recall("sup-05", "annual spend sup-05", 20);
      const ids = recalled.map((c) => c.id);
      expect(ids).toContain(newer.id);
      expect(ids).not.toContain(old.id);
    });

    it("throws when superseding an already superseded claim", async () => {
      const store = memoryStore();
      const first = await store.remember({
        subject_id: "sup-a",
        text: "first fact",
        derivedFrom: [{ row: { table: "t", key: "k" }, result_hash: "h1" }],
      });
      const second = await store.supersede(first.id, {
        subject_id: "sup-a",
        text: "second fact",
        derivedFrom: [{ row: { table: "t", key: "k" }, result_hash: "h2" }],
      });
      await expect(
        store.supersede(first.id, {
          subject_id: "sup-a",
          text: "third fact",
          derivedFrom: [{ row: { table: "t", key: "k" }, result_hash: "h3" }],
        })
      ).rejects.toThrow(/already superseded/);
      expect(second.id).toBeTruthy();
    });

    it("throws when superseding an unknown claim id", async () => {
      const store = memoryStore();
      await expect(
        store.supersede("mem-nonexistent", {
          subject_id: "sup-z",
          text: "orphan supersede",
          derivedFrom: [],
        })
      ).rejects.toThrow(/unknown claim/);
    });
  });

  describe("checkStale", () => {
    const claim = {
      derivedFrom: [
        { row: { table: "supplier_spend", key: "sup-01" }, result_hash: "h-a" },
        { row: { table: "supplier_financials", key: "parent-acme" }, result_hash: "h-b" },
      ],
    };

    it("reports not stale when all hashes match", () => {
      const fn = (r: RowRef) => (r.key === "sup-01" ? "h-a" : "h-b");
      expect(checkStale(claim, fn)).toEqual({ stale: false, changed: [], unverified: [] });
    });

    it("reports stale with changed rows when one hash differs", () => {
      const spendRow = { table: "supplier_spend", key: "sup-01" };
      const report = checkStale(claim, (r) =>
        rowKey(r) === rowKey(spendRow) ? "h-changed" : "h-b"
      );
      expect(report.stale).toBe(true);
      expect(report.changed).toEqual([
        { row: spendRow, recorded: "h-a", current: "h-changed" },
      ]);
      expect(report.unverified).toEqual([]);
    });

    it("treats missing current hash as unverified, not stale", () => {
      const report = checkStale(claim, new Map([[rowKey(claim.derivedFrom[0]!.row), "h-a"]]));
      expect(report.stale).toBe(false);
      expect(report.changed).toEqual([]);
      expect(report.unverified).toEqual([claim.derivedFrom[1]!.row]);
    });

    it("accepts a plain object keyed by rowKey()", () => {
      const current: Record<string, string> = {
        [rowKey(claim.derivedFrom[0]!.row)]: "h-a",
        [rowKey(claim.derivedFrom[1]!.row)]: "h-b",
      };
      expect(checkStale(claim, current).stale).toBe(false);
    });
  });

  describe("recall", () => {
    it("returns only the subject's current (non-superseded) claims", async () => {
      const store = memoryStore();
      await store.remember({
        subject_id: "sup-east",
        decision_id: "dec-east-1",
        text: "East region spend stable",
        derivedFrom: [{ row: { table: "supplier_spend", key: "sup-east" }, result_hash: "e1" }],
      });
      const doomed = await store.remember({
        subject_id: "sup-east",
        text: "East region spend old estimate",
        derivedFrom: [{ row: { table: "supplier_spend", key: "sup-east" }, result_hash: "e0" }],
      });
      await store.remember({
        subject_id: "sup-west",
        decision_id: "dec-west-1",
        text: "West region spend stable",
        derivedFrom: [{ row: { table: "supplier_spend", key: "sup-west" }, result_hash: "w1" }],
      });

      await store.supersede(doomed.id, {
        subject_id: "sup-east",
        decision_id: "dec-east-2",
        text: "East region spend updated figure",
        derivedFrom: [{ row: { table: "supplier_spend", key: "sup-east" }, result_hash: "e2" }],
      });

      const east = await store.recall("sup-east", "east region spend", 10);
      expect(east.every((c) => c.subject_id === "sup-east")).toBe(true);
      expect(east.some((c) => c.decision_id === "dec-east-1")).toBe(true);
      expect(east.some((c) => c.decision_id === "dec-east-2")).toBe(true);
      expect(east.some((c) => c.id === doomed.id)).toBe(false);
      expect(east.every((c) => !store.supersededBy(c.id))).toBe(true);

      const west = await store.recall("sup-west", "west region spend", 10);
      expect(west).toHaveLength(1);
      expect(west[0]!.subject_id).toBe("sup-west");
    });
  });

  describe("persistence", () => {
    let tempDir: string;

    afterEach(() => {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    });

    it("round-trips claims, dependentsOf, supersededBy, and history across reload", async () => {
      tempDir = mkdtempSync(join(tmpdir(), "tripwire-hmem-"));
      const spendRow: RowRef = { table: "supplier_spend", key: "sup-persist" };

      const writer = new HmemMemoryStore({ persistDir: tempDir, clock: FIXED_CLOCK });
      const original = await writer.remember({
        subject_id: "sup-persist",
        decision_id: "dec-persist",
        text: "Persisted spend claim",
        metric: "annual_spend",
        value: 500,
        derivedFrom: [{ row: spendRow, result_hash: "persist-hash-1" }],
      });
      const replacement = await writer.supersede(original.id, {
        subject_id: "sup-persist",
        decision_id: "dec-persist",
        text: "Persisted spend claim revised",
        value: 600,
        derivedFrom: [{ row: spendRow, result_hash: "persist-hash-2" }],
      });
      const historyBefore = writer.history(original.id).map((e) => e.action);

      const reader = new HmemMemoryStore({ persistDir: tempDir, clock: FIXED_CLOCK });
      expect(reader.get(replacement.id)?.text).toBe("Persisted spend claim revised");
      expect(reader.supersededBy(original.id)).toBe(replacement.id);
      await expect(reader.dependentsOf(spendRow)).resolves.toEqual(["dec-persist"]);
      expect(reader.history(original.id).map((e) => e.action)).toEqual(historyBefore);
    });
  });
});

describe("callHmem", () => {
  it("returns ok:true with success status when the fn succeeds", async () => {
    const result = await callHmem("memory-keeper", "remember", () => ({ id: "x" }), {
      input_summary: "one claim",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ id: "x" });
    expect(result.event).toMatchObject({
      event: "sponsor_call",
      sponsor: "meterless-hmem",
      agent_name: "memory-keeper",
      action: "remember",
      status: "success",
    });
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns ok:false with failed sponsor event when the fn throws", async () => {
    const result = await callHmem("memory-keeper", "recall", async () => {
      throw new Error("disk full");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("disk full");
    expect(result.event).toMatchObject({
      event: "sponsor_call",
      sponsor: "meterless-hmem",
      status: "failed",
      output_summary: "H-MEM error: disk full",
    });
  });
});

describe("flagWrong", () => {
  it("lowers confidence in hmem.store and appends a feedback ledger entry", async () => {
    const store = memoryStore();
    const claim = await store.remember({
      subject_id: "sup-flag",
      text: "Flag me if wrong",
      derivedFrom: [{ row: { table: "t", key: "k" }, result_hash: "h" }],
    });
    const rec = store.hmem.store.get(claim.id)!;
    const before = rec.confidence;

    store.flagWrong(claim.id);

    expect(store.hmem.store.get(claim.id)!.confidence).toBeCloseTo(before - 0.2, 10);
    const actions = store.history(claim.id).map((e) => e.action);
    expect(actions).toContain("create");
    expect(actions).toContain("feedback");
    const fb = store.history(claim.id).find((e) => e.action === "feedback");
    expect(fb?.details).toMatchObject({ kind: "wrong", delta: -0.2 });
  });
});

describe("edge cases (hand-written)", () => {
  it("drops the superseded decision from dependentsOf when the new claim has a new decision id", async () => {
    const store = memoryStore();
    await seedPortfolio(store);
    const old = claimForDecision(store, "dec-11");
    await store.supersede(old.id, {
      subject_id: "sup-11",
      decision_id: "dec-11b",
      text: "Annual spend for sup-11 re-decided",
      derivedFrom: [{ row: SHARED_FINANCIALS, result_hash: "hash-parent-acme-v2" }],
    });
    await expect(store.dependentsOf(SHARED_FINANCIALS)).resolves.toEqual(["dec-03", "dec-11b", "dec-17"]);
    await expect(store.dependentsOf({ table: "supplier_spend", key: "sup-11" })).resolves.toEqual([]);
  });

  it("round-trips row keys containing '/', '#' and spaces exactly", async () => {
    const store = memoryStore();
    const row: RowRef = { table: "edgar/filings", key: "ACME Corp #10-K/2025" };
    const c = await store.remember({ subject_id: "s", decision_id: "d", text: "x", derivedFrom: [{ row, result_hash: "h#1" }] });
    expect(store.get(c.id)?.derivedFrom).toEqual([{ row, result_hash: "h#1" }]);
    await expect(store.dependentsOf(row)).resolves.toEqual(["d"]);
    await expect(store.dependentsOf({ table: "edgar", key: "filings/ACME Corp #10-K/2025" })).resolves.toEqual([]);
  });

  it("does not keep H-MEM's automatic supersedes link on correction-like text", async () => {
    const store = memoryStore();
    await store.remember({ subject_id: "s", text: "supplier ships from Ohio", derivedFrom: [] });
    const c = await store.remember({ subject_id: "s", text: "actually supplier ships from Ohio", derivedFrom: [] });
    expect(c.supersedes).toBeUndefined();
    expect(store.hmem.store.get(c.id)?.supersedes).toBeUndefined();
  });
});
