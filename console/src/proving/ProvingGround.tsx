// The Proving Ground panel: four stages in one strip, in the order they run. Each stage renders from its own file.
// Owner of this shell: the integration branch. Stage owners edit only their own file in this folder.
import type { Decision } from "../types";
import { ReadStage } from "./ReadStage";
import { ImagineStage } from "./ImagineStage";
import { CrashStage } from "./CrashStage";
import { BacktestStage } from "./BacktestStage";

export function ProvingGround({ d }: { d: Decision }) {
  const p = d.proving;
  if (!p) return null;
  return (
    <div className="sec proving">
      <div className="sec-h"><h3>Proving Ground: Nemotron attacks its own call</h3>
        <span className="info" tabIndex={0} data-tip="Before you approve, Nemotron reads the supplier's real 8-K filings, imagines how this decision could fail, and crash-tests every tripwire. A tripwire is kept only if crossing it really changes the call. The track record shows how these tripwires did on real SEC history.">i</span><span className="line" /></div>
      <ol className="pg-stages">
        <li><ReadStage d={d} /></li>
        <li><ImagineStage d={d} /></li>
        <li><CrashStage d={d} /></li>
        <li><BacktestStage d={d} /></li>
      </ol>
    </div>
  );
}
