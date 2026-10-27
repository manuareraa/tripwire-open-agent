// Proving Ground stage 3 · Crash-test. Owner: the "crash" stream. Stub until it lands.
import type { Decision } from "../types";

export function CrashStage({ d }: { d: Decision }) {
  const done = d.proving?.crash !== undefined;
  return (
    <div className={`pg-stage${done ? "" : " skipped"}`}>
      <div className="pg-step">3 · Crash-test</div>
      <div className="pg-title">Lightning pushes each tripwire past its line</div>
      {!done && <div className="pg-note muted">Not run for this decision.</div>}
    </div>
  );
}
