// Proving Ground stage 4 · Backtest: how Tripwire's tripwires did on real SEC history (scripts/backtest.ts).
// Shows measured numbers only; the note names the arm (rule-based or a Nemotron arm) they came from.
import type { Decision } from "../types";

const years = (window: string) => {
  const m = window.match(/(\d{4})Q\d\D+(\d{4})Q\d/);
  return m ? `${m[1]}–${m[2]}` : window;
};

export function BacktestStage({ d }: { d: Decision }) {
  const t = d.proving?.track_record;
  return (
    <div className={`pg-stage pg-backtest${t ? "" : " skipped"}`}>
      <div className="pg-step">4 · Backtest</div>
      <div className="pg-title">How tripwires like these did on real SEC history</div>
      {!t && <div className="pg-note muted">Not run for this decision.</div>}
      {t && (
        <>
          <div className="pg-backtest-headline">
            On real history {years(t.window)}: caught <b>{t.caught_early}</b> of <b>{t.trouble_events}</b> trouble event{t.trouble_events === 1 ? "" : "s"} before they were filed, <b>{t.false_alarms}</b> false alarm{t.false_alarms === 1 ? "" : "s"}
          </div>
          <div className="pg-note muted">This supplier only. {t.note}</div>
        </>
      )}
    </div>
  );
}
