// Proving Ground stage 4 · Backtest. Owner: the "backtest" stream. Stub until it lands.
import type { Decision } from "../types";

export function BacktestStage({ d }: { d: Decision }) {
  const done = d.proving?.track_record !== undefined;
  return (
    <div className={`pg-stage${done ? "" : " skipped"}`}>
      <div className="pg-step">4 · Backtest</div>
      <div className="pg-title">How these tripwires did on real SEC history</div>
      {!done && <div className="pg-note muted">Not run for this decision.</div>}
    </div>
  );
}
