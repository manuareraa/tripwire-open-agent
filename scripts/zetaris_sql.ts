// Run ONE SQL statement against Zetaris through the REST API and print the JSON response.
// Usage: tsx scripts/zetaris_sql.ts "SELECT 1"
// Credentials come from the environment only (ZETARIS_API_KEY, or ZETARIS_USERNAME + ZETARIS_PASSWORD);
// tokens are never printed.
import { ZetarisClient } from "../app/adapters/zetaris.js";

const sql = process.argv.slice(2).join(" ").trim();
if (!sql) {
  console.error('usage: tsx scripts/zetaris_sql.ts "<one statement>"');
  process.exit(2);
}

const client = ZetarisClient.fromEnv();
const t0 = Date.now();
try {
  const res = await client.sql(sql);
  console.log(JSON.stringify({ ms: Date.now() - t0, rows: res.rows, raw: res.raw }, null, 2));
} catch (e) {
  const err = e as Error & { kind?: string; status?: number };
  console.error(JSON.stringify({ ms: Date.now() - t0, kind: err.kind, status: err.status, error: err.message }, null, 2));
  process.exit(1);
}
