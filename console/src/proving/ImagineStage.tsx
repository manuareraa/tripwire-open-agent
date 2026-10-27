// Proving Ground stage 2. Owner: the "imagine" stream. Stub until it lands.
import type { Decision } from "../types";

export function ImagineStage({ d }: { d: Decision }) {
  const done = d.proving?.stories !== undefined;
  return (
    <div className={`pg-stage${done ? "" : " skipped"}`}>
      <div className="pg-step">2 · Imagine</div>
      <div className="pg-title">Ultra's pre-mortem: how this call could fail</div>
      {!done && <div className="pg-note muted">Not run for this decision.</div>}
    </div>
  );
}
