import { createHash } from "node:crypto";

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** SHA-256 of rows with keys sorted and rows sorted, so equal data always hashes equal. */
export function canonicalHash(rows: Record<string, unknown>[]): string {
  const lines = rows.map((r) => JSON.stringify(canon(r))).sort();
  return createHash("sha256").update(JSON.stringify(lines)).digest("hex");
}
