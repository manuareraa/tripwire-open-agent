import { describe, it, expect, vi } from "vitest";
import type { Decision } from "../app/types.js";
import {
  ZetarisClient,
  ZetarisGateway,
  canonicalHash,
} from "../app/adapters/zetaris.js";
import { TABLE_PREFIX } from "../app/sql/zetaris_tables.js";
import { TABLES } from "../app/sql/templates.js";

const FIXED_NOW = () => new Date("2026-10-22T15:00:00.000Z");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sqlTable(headers: string[], data: (string | null)[][], total?: number): Response {
  return jsonResponse({ headers, data, total: total ?? data.length });
}

function parseRunQueryBody(init?: RequestInit): { sql: string; limit: number } {
  const body = JSON.parse(String(init?.body)) as { sql: string; limit: number };
  return body;
}

type SqlHandler = (sql: string, init: RequestInit) => Response | Promise<Response>;

function createLoginAndSqlFetch(onSql: SqlHandler): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    if (path === "/api/auth/login") {
      return jsonResponse({ idToken: "tok", orgId: 7 });
    }
    if (path === "/api/proxy/sql-editor/sqls/run-query") {
      const { sql } = parseRunQueryBody(init);
      return onSql(sql, init ?? {});
    }
    throw new Error(`unexpected fetch URL: ${url}`);
  });
}

function clientAndGateway(fetchImpl: ReturnType<typeof vi.fn>, timeoutMs = 2000) {
  const client = new ZetarisClient({
    baseUrl: "http://zetaris.test",
    username: "u",
    password: "p",
    timeoutMs,
    fetchImpl,
  });
  const gateway = new ZetarisGateway({ client, now: FIXED_NOW });
  return { client, gateway };
}

const minimalDecision = (): Decision => ({
  decision_id: "dec-test-001",
  subject_id: "SUP-06",
  decision: "dual_source",
  confidence: 0.85,
  status: "approved",
  findings: [
    {
      claim: "high concentration",
      metric: "spend_share",
      value: 0.58,
      evidence: {
        template_id: "supplier_spend_row",
        params: { supplier_id: "SUP-06" },
        sql: "SELECT 1",
        table: "supplier_spend",
        result_hash: "0".repeat(64),
        depends_on: [{ table: "supplier_spend", key: "SUP-06" }],
      },
    },
  ],
  evidence: [],
  tripwires: [],
  limitations: [],
  escalated: false,
  created_at: "2026-10-22T10:00:00.000Z",
  approved_by_reason: "reviewer ok",
});

describe("ZetarisClient and ZetarisGateway (mocked)", () => {
  describe("auth and request shape", () => {
    it("logs in once; SQL calls carry Bearer, org id, unique X-Request-ID, and {sql, limit}", async () => {
      const sqlCalls: RequestInit[] = [];
      const fetchImpl = createLoginAndSqlFetch((sql, init) => {
        sqlCalls.push(init);
        if (/SELECT 1 AS one/i.test(sql)) {
          return sqlTable(["one"], [["1"]]);
        }
        return sqlTable(["supplier_id"], [["SUP-01"]]);
      });

      const { gateway } = clientAndGateway(fetchImpl);
      await gateway.health();
      await gateway.runTemplate("supplier_spend_row", { supplier_id: "SUP-01" });

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      const loginCalls = fetchImpl.mock.calls.filter((c) =>
        String(c[0]).includes("/api/auth/login"),
      );
      expect(loginCalls).toHaveLength(1);

      const requestIds: string[] = [];
      for (const init of sqlCalls) {
        expect(init.headers).toMatchObject({
          Authorization: "Bearer tok",
          "X-Org-ID": "7",
        });
        const rid = (init.headers as Record<string, string>)["X-Request-ID"];
        expect(rid).toMatch(UUID_RE);
        requestIds.push(rid);
        const body = parseRunQueryBody(init);
        expect(body).toHaveProperty("sql");
        expect(body.limit).toBe(1000);
      }
      expect(new Set(requestIds).size).toBe(requestIds.length);
    });
  });

  describe("runTemplate supplier_spend_row", () => {
    it("types DOUBLE columns, evidence, and result_hash", async () => {
      const fetchImpl = createLoginAndSqlFetch((sql) => {
        expect(sql).toContain(`${TABLE_PREFIX}${TABLES.spend}`);
        expect(sql).toContain("supplier_id = 'SUP-06'");
        return sqlTable(
          [
            "supplier_id",
            "cik",
            "category",
            "spend_share",
            "lead_time_weeks",
            "open_po_value",
            "contract_end",
            "updated_at",
          ],
          [
            [
              "SUP-06",
              "320193",
              "semiconductors",
              "0.42",
              "8.5",
              "1200000",
              "2027-06-30",
              "2026-10-21T08:00:00.000Z",
            ],
          ],
        );
      });

      const { gateway } = clientAndGateway(fetchImpl);
      const result = await gateway.runTemplate("supplier_spend_row", { supplier_id: "SUP-06" });

      expect(result.sample).toBe(false);
      expect(result.rows).toHaveLength(1);
      const row = result.rows[0]!;
      expect(row.supplier_id).toBe("SUP-06");
      expect(row.spend_share).toBe(0.42);
      expect(row.lead_time_weeks).toBe(8.5);
      expect(row.open_po_value).toBe(1200000);

      expect(result.evidence.template_id).toBe("supplier_spend_row");
      expect(result.evidence.params).toEqual({ supplier_id: "SUP-06" });
      expect(result.evidence.sql).toContain("tripwire.");
      expect(result.evidence.depends_on).toEqual([{ table: "supplier_spend", key: "SUP-06" }]);
      expect(result.evidence.result_hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("canonicalHash", () => {
    it("is stable across row order and key order; changes when a value changes", () => {
      const a = [{ x: 1, y: 2 }];
      const b = [{ y: 2, x: 1 }];
      expect(canonicalHash(a)).toBe(canonicalHash(b));

      const rows1 = [{ id: "1", v: 10 }, { id: "2", v: 20 }];
      const rows2 = [{ v: 20, id: "2" }, { v: 10, id: "1" }];
      expect(canonicalHash(rows1)).toBe(canonicalHash(rows2));

      expect(canonicalHash([{ n: 1 }])).not.toBe(canonicalHash([{ n: 2 }]));
    });
  });

  describe("template param validation", () => {
    it("rejects invalid supplier_id before any fetch", async () => {
      const fetchImpl = vi.fn();
      const { gateway } = clientAndGateway(fetchImpl);
      await expect(
        gateway.runTemplate("supplier_spend_row", { supplier_id: "x'; DROP" }),
      ).rejects.toThrow(/invalid supplier_id/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("writeDecision", () => {
    it("exports with append + base64 literals, read-back COUNT, written true/false paths", async () => {
      let exportSqlSeen = "";
      let countSqlSeen = "";
      const fetchImpl = createLoginAndSqlFetch((sql) => {
        if (/^RUN EXPORT TO STORAGE/i.test(sql)) {
          exportSqlSeen = sql;
          expect(sql).toContain("saveMode = 'append'");
          expect(sql).not.toMatch(/'dual_source'/);
          expect(sql).toContain('unbase64("');
          return sqlTable(["status"], [["SUCCESS"]]);
        }
        if (/SELECT COUNT\(\*\) AS n/i.test(sql)) {
          countSqlSeen = sql;
          return sqlTable(["n"], [["1"]]);
        }
        return sqlTable(["one"], [["1"]]);
      });

      const { gateway } = clientAndGateway(fetchImpl);
      const out = await gateway.writeDecision(minimalDecision());
      expect(out.written).toBe(true);
      expect(exportSqlSeen.length).toBeGreaterThan(0);
      expect(countSqlSeen).toContain("dec-test-001");
      expect(countSqlSeen).toContain("2026-10-22T15:00:00.000Z");
    });

    it("returns written:false when read-back COUNT is 0", async () => {
      const fetchImpl = createLoginAndSqlFetch((sql) => {
        if (/^RUN EXPORT TO STORAGE/i.test(sql)) {
          return sqlTable(["status"], [["SUCCESS"]]);
        }
        if (/SELECT COUNT\(\*\) AS n/i.test(sql)) {
          return sqlTable(["n"], [["0"]]);
        }
        return sqlTable(["one"], [["1"]]);
      });

      const { gateway } = clientAndGateway(fetchImpl);
      const out = await gateway.writeDecision(minimalDecision());
      expect(out.written).toBe(false);
      expect(out.detail).toMatch(/read-back found 0 rows/);
    });

    it("returns written:false when export responds HTTP 400", async () => {
      const fetchImpl = createLoginAndSqlFetch((sql) => {
        if (/^RUN EXPORT TO STORAGE/i.test(sql)) {
          return jsonResponse({ msg: "ParseException: bad export" }, 400);
        }
        return sqlTable(["n"], [["1"]]);
      });

      const { gateway } = clientAndGateway(fetchImpl);
      const out = await gateway.writeDecision(minimalDecision());
      expect(out.written).toBe(false);
      expect(out.detail).toMatch(/sql:/);
    });
  });

  describe("readDecisions", () => {
    it("keeps the latest written_at row per decision_id and parses payload JSON", async () => {
      const payloadOld: Decision = {
        ...minimalDecision(),
        status: "proposed",
        confidence: 0.5,
      };
      const payloadNew: Decision = {
        ...minimalDecision(),
        status: "approved",
        confidence: 0.95,
      };

      const fetchImpl = createLoginAndSqlFetch((sql) => {
        expect(sql).toContain(`${TABLE_PREFIX}${TABLES.decisions}`);
        return sqlTable(
          [
            "decision_id",
            "supplier_id",
            "decision",
            "confidence",
            "status",
            "tripwires",
            "evidence",
            "supersedes",
            "created_at",
            "approved_by_reason",
            "payload",
            "written_at",
          ],
          [
            [
              "dec-test-001",
              "SUP-06",
              "keep",
              "0.5",
              "proposed",
              "[]",
              "[]",
              "",
              "2026-10-22T10:00:00.000Z",
              "",
              JSON.stringify(payloadOld),
              "2026-10-22T11:00:00.000Z",
            ],
            [
              "dec-test-001",
              "SUP-06",
              "dual_source",
              "0.95",
              "approved",
              "[]",
              "[]",
              "",
              "2026-10-22T10:00:00.000Z",
              "reviewer ok",
              JSON.stringify(payloadNew),
              "2026-10-22T14:00:00.000Z",
            ],
          ],
        );
      });

      const { gateway } = clientAndGateway(fetchImpl);
      const decisions = await gateway.readDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.decision_id).toBe("dec-test-001");
      expect(decisions[0]!.status).toBe("approved");
      expect(decisions[0]!.confidence).toBe(0.95);
      expect(decisions[0]!.approved_by_reason).toBe("reviewer ok");
    });
  });

  describe("changesSince", () => {
    const FIN_V1 = [
      ["1001", "2025-12-31", "1000000", "0.4", "1.2", "0.5"],
    ] as (string | null)[][];

    function finHandler(data: (string | null)[][]): SqlHandler {
      return (sql) => {
        if (/MAX\(updated_at\)/i.test(sql)) {
          return sqlTable(["m"], [["2026-10-20T12:00:00.000Z"]]);
        }
        if (/updated_at >/i.test(sql)) {
          return sqlTable(
            ["supplier_id", "updated_at"],
            [["SUP-99", "2026-10-21T09:00:00.000Z"]],
          );
        }
        if (/FROM tripwire\.supplier_financials/i.test(sql)) {
          return sqlTable(
            ["cik", "period_end", "revenue", "gross_margin", "current_ratio", "debt_to_equity"],
            data,
          );
        }
        return sqlTable(["x"], [[]]);
      };
    }

    it("initialises marker with no changes; later spend + financials diffs", async () => {
      let finData = FIN_V1;
      const fetchImpl = createLoginAndSqlFetch((sql, init) => finHandler(finData)(sql, init));
      const { gateway } = clientAndGateway(fetchImpl);

      const init = await gateway.changesSince("");
      expect(init.changes).toEqual([]);
      expect(init.marker).toBe("2026-10-20T12:00:00.000Z");

      const second = await gateway.changesSince(init.marker);
      expect(second.changes).toContainEqual({ table: "supplier_spend", key: "SUP-99" });
      expect(second.changes.some((c) => c.table === "supplier_financials")).toBe(false);

      finData = [["1001", "2025-12-31", "2000000", "0.4", "1.2", "0.5"]];
      const third = await gateway.changesSince(second.marker);
      expect(third.changes).toContainEqual({ table: "supplier_financials", key: "1001" });
    });
  });

  describe("errors and retries", () => {
    it("maps HTTP 401 on SQL to ZetarisError kind auth", async () => {
      const fetchImpl = createLoginAndSqlFetch(() => jsonResponse({ msg: "unauthorized" }, 401));
      const { client } = clientAndGateway(fetchImpl);
      await expect(client.sql("SELECT 1")).rejects.toMatchObject({
        name: "ZetarisError",
        kind: "auth",
        status: 401,
      });
    });

    it("maps hung fetch to timeout kind", async () => {
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new DOMException("The operation was aborted.", "AbortError");
            reject(err);
          });
        });
      });
      const { client } = clientAndGateway(fetchImpl, 50);
      await expect(client.sql("SELECT 1")).rejects.toMatchObject({
        name: "ZetarisError",
        kind: "timeout",
      });
    });

    it("retries SELECT once on network TypeError; does not retry RUN EXPORT", async () => {
      let selectAttempts = 0;
      let exportAttempts = 0;
      const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/auth/login")) {
          return jsonResponse({ idToken: "tok", orgId: 7 });
        }
        const { sql } = parseRunQueryBody(init);
        if (/^SELECT/i.test(sql)) {
          selectAttempts += 1;
          if (selectAttempts === 1) {
            throw new TypeError("fetch failed");
          }
          return sqlTable(["one"], [["1"]]);
        }
        if (/^RUN EXPORT/i.test(sql)) {
          exportAttempts += 1;
          throw new TypeError("fetch failed");
        }
        return sqlTable(["x"], [["x"]]);
      });

      const { client, gateway } = clientAndGateway(fetchImpl);
      const res = await client.sql("SELECT 1 AS one");
      expect(res.rows[0]?.one).toBe("1");
      expect(selectAttempts).toBe(2);

      const writeOut = await gateway.writeDecision(minimalDecision());
      expect(writeOut.written).toBe(false);
      expect(exportAttempts).toBe(1);
    });

    it("health returns ok:false instead of throwing", async () => {
      const fetchImpl = createLoginAndSqlFetch(() => jsonResponse({ msg: "denied" }, 401));
      const { gateway } = clientAndGateway(fetchImpl);
      const h = await gateway.health();
      expect(h.ok).toBe(false);
      expect(h.detail).toMatch(/auth/);
    });
  });
});

describe.skipIf(process.env.ZETARIS_LIVE !== "1")("live zetaris", () => {
  it("health, supplier_spend_row, and changesSince marker (read-only)", async () => {
    const gateway = new ZetarisGateway();
    const health = await gateway.health();
    expect(health.ok).toBe(true);

    const row = await gateway.runTemplate("supplier_spend_row", { supplier_id: "SUP-01" });
    expect(row.rows.length).toBeGreaterThanOrEqual(1);

    const cs = await gateway.changesSince("");
    expect(typeof cs.marker).toBe("string");
  });
});

describe("ZetarisGateway row changes", () => {
  const SPEND_COLS = ["supplier_id", "cik", "category", "spend_share", "lead_time_weeks", "open_po_value", "contract_end", "updated_at"];
  const FIN_COLS = ["cik", "ticker", "name", "sic", "period_end", "revenue", "gross_margin", "current_ratio", "debt_to_equity", "source_url"];
  const spend = (id: string, share: string): (string | null)[] => [id, "1", "chemicals", share, "7", "100000", "2027-06-30", "2026-10-01T09:00:00Z"];
  const fin = (period: string): (string | null)[] => ["1306830", "CE", "CELANESE", "2820", period, "100", "0.2", "1.4", "4.1", "https://sec.example/"];

  /** A fake Zetaris holding two tables; records every export, drop and register it is sent. */
  function fakeTables(data: { spend: (string | null)[][]; fin: (string | null)[][] }, readTotal?: number) {
    const writes: string[] = [];
    const fetchImpl = createLoginAndSqlFetch((sql) => {
      if (sql === `SELECT * FROM ${TABLE_PREFIX}${TABLES.spend}`) return sqlTable(SPEND_COLS, data.spend, readTotal);
      if (sql === `SELECT * FROM ${TABLE_PREFIX}${TABLES.financials}`) return sqlTable(FIN_COLS, data.fin, readTotal);
      if (/^RUN EXPORT TO STORAGE/i.test(sql)) {
        const table = /path = '[^']*\/([a-z_]+)'/.exec(sql)?.[1] ?? /path = '([^']*)'/.exec(sql)?.[1];
        writes.push(`export ${/saveMode = '(\w+)'/.exec(sql)?.[1]} ${table} rows=${(sql.match(/UNION ALL/g)?.length ?? 0) + (/WHERE 1 = 0/.test(sql) ? 0 : 1)}`);
        return sqlTable(["status"], [["SUCCESS"]]);
      }
      if (/^DROP /i.test(sql)) { writes.push("drop"); return sqlTable(["status"], [["SUCCESS"]]); }
      if (/^CREATE LIGHTNING FILESTORE TABLE/i.test(sql)) { writes.push("register"); return sqlTable(["status"], [["SUCCESS"]]); }
      return sqlTable(["one"], [["1"]]);
    });
    return { writes, ...clientAndGateway(fetchImpl) };
  }

  it("appends a new filing without rewriting the table", async () => {
    const { gateway, writes } = fakeTables({ spend: [spend("SUP-06", "0.35")], fin: [fin("2026-06-30")] });
    const refs = await gateway.applyChangeRows([{ table: TABLES.financials, key: "1306830", row: { cik: "1306830", period_end: "2026-09-30", revenue: 90 } }]);
    expect(refs).toEqual([{ table: TABLES.financials, key: "1306830" }]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^export append .* rows=1$/);
  });

  it("rewrites and re-registers a table when a change replaces a row, keeping every other row", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => spend(`SUP-${String(i + 1).padStart(2, "0")}`, "0.01"));
    const { gateway, writes } = fakeTables({ spend: rows, fin: [] });
    const refs = await gateway.applyChangeRows([
      { table: TABLES.spend, key: "SUP-06", row: { supplier_id: "SUP-06", spend_share: 0.55 } },
      { table: TABLES.spend, key: "SUP-05", row: { supplier_id: "SUP-05", spend_share: 0.1 } },
    ]);
    expect(refs.map((r) => r.key)).toEqual(["SUP-06", "SUP-05"]);
    // 30 rows in chunks of 25: overwrite the first chunk, append the rest, then drop and register again.
    expect(writes).toEqual([expect.stringMatching(/^export overwrite .* rows=25$/), expect.stringMatching(/^export append .* rows=5$/), "drop", "register"]);
  });

  it("rejects an invalid change before sending anything", async () => {
    const { gateway, writes } = fakeTables({ spend: [spend("SUP-06", "0.35")], fin: [] });
    await expect(gateway.applyChangeRows([{ table: TABLES.spend, key: "SUP-07", row: { supplier_id: "SUP-06" } }])).rejects.toThrow(/key/);
    await expect(gateway.applyChangeRows([{ table: TABLES.spend, key: "SUP-06", row: { supplier_id: "SUP-06", hack: "x" } }])).rejects.toThrow(/unknown column/);
    expect(writes).toEqual([]);
  });

  it("refuses to rewrite from a read that may have been cut off", async () => {
    const big = Array.from({ length: 100000 }, (_, i) => spend(`SUP-${i}`, "0"));
    const { gateway, writes } = fakeTables({ spend: big, fin: [] });
    await expect(gateway.applyChangeRows([{ table: TABLES.spend, key: "SUP-1", row: { supplier_id: "SUP-1", spend_share: 0.5 } }])).rejects.toThrow(/truncated/);
    expect(writes).toEqual([]);
  });

  it("restores only the tables that differ from the base and reports their changed rows", async () => {
    const base = {
      [TABLES.spend]: [{ supplier_id: "SUP-06", cik: "1", category: "chemicals", spend_share: 0.35, lead_time_weeks: 7, open_po_value: 100000, contract_end: "2027-06-30", updated_at: "2026-10-01T09:00:00Z" }],
      [TABLES.financials]: [{ cik: "1306830", ticker: "CE", name: "CELANESE", sic: "2820", period_end: "2026-06-30", revenue: 100, gross_margin: 0.2, current_ratio: 1.4, debt_to_equity: 4.1, source_url: "https://sec.example/" }],
    };
    const changed = fakeTables({ spend: [spend("SUP-06", "0.55")], fin: [fin("2026-06-30")] });
    expect(await changed.gateway.restoreTables(base)).toEqual([{ table: TABLES.spend, key: "SUP-06" }]);
    expect(changed.writes).toEqual([expect.stringMatching(/^export overwrite .* rows=1$/), "drop", "register"]);

    const same = fakeTables({ spend: [spend("SUP-06", "0.35")], fin: [fin("2026-06-30")] });
    expect(await same.gateway.restoreTables(base)).toEqual([]);
    expect(same.writes).toEqual([]);

    const extra = fakeTables({ spend: [spend("SUP-06", "0.35")], fin: [fin("2026-06-30"), fin("2026-09-30")] });
    expect(await extra.gateway.restoreTables(base)).toEqual([{ table: TABLES.financials, key: "1306830" }]);
    expect(extra.writes).toEqual([expect.stringMatching(/^export overwrite .* rows=1$/), "drop", "register"]);
  });
});
