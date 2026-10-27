// Proving Ground stage 1 · Read. Owner: the "read" stream. Stub until it lands.
import type { Decision } from "../types";

export function ReadStage({ d }: { d: Decision }) {
  const done = d.proving?.filings !== undefined;
  return (
    <div className={`pg-stage${done ? "" : " skipped"}`}>
      <div className="pg-step">1 · Read</div>
      <div className="pg-title">Real 8-K filings, read by Nemotron Parse</div>
      {!done && <div className="pg-note muted">Not run for this decision.</div>}
    </div>
  );
}
