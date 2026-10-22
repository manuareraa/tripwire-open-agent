// Canonical result hashing shared by every DataGateway, so the same rows hash the same in sample and Zetaris mode.
import { createHash } from "node:crypto";

type Row = Record<string, unknown>;

function canonical(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Row;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

/** Canonical JSON of a row set: each row with sorted keys, rows sorted by their canonical text. */
export function canonicalRows(rows: Row[]): string {
  return `[${rows.map(canonical).sort().join(",")}]`;
}

/** SHA-256 hex of canonicalRows(rows). The Evidence Critic recomputes this to "prove" a number. */
export function resultHash(rows: Row[]): string {
  return createHash("sha256").update(canonicalRows(rows)).digest("hex");
}

/** Alias kept for callers written against the Zetaris adapter's name. */
export const canonicalHash = resultHash;
