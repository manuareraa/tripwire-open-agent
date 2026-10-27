// Numbered run logs for the long live-recording scripts, so a run that goes wrong can be debugged afterwards.
//
// Every run gets the next number and its own file, logs/runs/run-0007-record_live.log (logs/ is gitignored).
// Everything the script prints goes there with a timestamp, plus one line per model call (written by the recorder),
// plus any crash with its stack, plus the exit code. Keys and tokens are blanked out before anything is written.
//
// --resume [N] continues run N (default: the newest run in the recordings file) in the same log file: calls that
// run already got an answer for are reused, so only the missing ones are asked again.
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { readRecordings } from "../app/adapters/recording.js";

export interface RunLog {
  run: number;
  file: string;
  /** Set when this attempt continues an earlier run. */
  resumed: boolean;
}

const RUN_FILE = /^run-(\d+)-.*\.log$/;

/** The run to resume: `--resume N`, or `--resume` alone for the newest run found in the recordings file. */
export function resumeArg(argv: string[], recordFile?: string): number | undefined {
  const i = argv.indexOf("--resume");
  if (i < 0) return undefined;
  const n = argv[i + 1];
  if (n && /^\d+$/.test(n)) return Number(n);
  const runs = recordFile ? readRecordings(recordFile).map((r) => r.run ?? 0) : [];
  const last = Math.max(0, ...runs);
  if (!last) throw new Error(`--resume: no numbered run found in ${recordFile}; start a new run without --resume`);
  return last;
}

/** The next free run number, across every run log and the numbered records in the recordings file. */
export function nextRun(dir: string, recordFile?: string): number {
  const fromLogs = existsSync(dir) ? readdirSync(dir).map((f) => Number(RUN_FILE.exec(f)?.[1] ?? 0)) : [];
  const fromRecs = recordFile ? readRecordings(recordFile).map((r) => r.run ?? 0) : [];
  return Math.max(0, ...fromLogs, ...fromRecs) + 1;
}

/** Blanks out anything that looks like a credential, and the values of the credential env vars themselves. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text.replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-[redacted]").replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= 8 && /TOKEN|KEY|SECRET|PASSWORD/i.test(k)) out = out.split(v).join("[redacted]");
  }
  return out;
}

/**
 * Starts the numbered log for this run: tees console output to the file and records crashes and the exit code.
 * Sets MODEL_RECORD_RUN, MODEL_RECORD_RESUME and RUN_LOG_FILE so the recorder (app/runtime.ts) tags and logs calls.
 * Call it before the runtime is imported.
 */
export function startRunLog(script: string, root: string, recordFile?: string, argv = process.argv): RunLog {
  const dir = join(root, "logs", "runs");
  mkdirSync(dir, { recursive: true });
  const resume = recordFile ? resumeArg(argv, recordFile) : undefined;
  const run = resume ?? nextRun(dir, recordFile);
  const prefix = `run-${String(run).padStart(4, "0")}-`;
  const file = (resume !== undefined && readdirSync(dir).find((f) => f.startsWith(prefix))) || `${prefix}${script}.log`;
  const path = join(dir, file);

  const write = (line: string) => {
    try { appendFileSync(path, redact(line) + "\n"); } catch { /* a log that cannot be written must not stop the run */ }
  };
  const stamp = () => new Date().toISOString();
  write(`\n=== run ${run} (${script}) ${resume !== undefined ? "resumed" : "started"} ${stamp()}`);
  write(`args: ${argv.slice(2).join(" ") || "(none)"}; node ${process.version}; ${process.platform}; cwd ${process.cwd()}`);

  for (const level of ["log", "info", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...a: unknown[]) => {
      try { orig(...a); } catch { /* a closed console window or pipe must not stop a long run; the file still gets it */ }
      write(`[${stamp()}] ${level === "log" || level === "info" ? "" : `${level.toUpperCase()} `}${format(...a)}`);
    };
  }
  const started = Date.now();
  // A closed console (EPIPE) is not a crash: keep running and keep logging to the file.
  for (const s of [process.stdout, process.stderr]) s.on("error", (e: NodeJS.ErrnoException) => { if (e.code !== "EPIPE") throw e; });
  process.on("uncaughtException", (e) => { write(`[${stamp()}] CRASH ${e.stack ?? e}`); console.error(e); process.exit(1); });
  process.on("unhandledRejection", (e) => { write(`[${stamp()}] CRASH (unhandled promise) ${e instanceof Error ? e.stack : String(e)}`); console.error(e); process.exit(1); });
  process.on("exit", (code) => write(`=== run ${run} ended with exit code ${code} after ${((Date.now() - started) / 1000).toFixed(0)} s`));

  if (recordFile) process.env.MODEL_RECORD_RUN = String(run);
  if (resume !== undefined) process.env.MODEL_RECORD_RESUME = String(resume);
  process.env.RUN_LOG_FILE = path;
  console.log(`run ${run}${resume !== undefined ? " (resumed)" : ""}: full log in ${path}`);
  return { run, file: path, resumed: resume !== undefined };
}
