// Decision section: which model answered each agent's step, through which provider, with its receipt.
// A replayed answer and a swapped model are both said out loud, never passed off as something else.
import { pretty } from "./format";
import { MODEL_TIER } from "./labels";
import type { ModelCall, SourceFreshness } from "./types";

const PROVIDER: Record<string, string> = { "meterless-nightshift": "Meterless Nightshift", nvidia: "NVIDIA direct (backup)" };
const short = (m: string) => m.replace(/^nvidia\//, "");
const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

export function ModelCalls({ calls }: { calls: ModelCall[] }) {
  const answered = calls.filter((c) => !c.fallback);
  const replayed = answered.filter((c) => c.replayed_from);
  const tokens = answered.reduce((n, c) => n + c.tokens_in + c.tokens_out, 0);
  const head = answered.length
    ? `${answered.length} of ${calls.length} steps answered by a model · ${tokens.toLocaleString()} tokens` +
      (replayed.length ? ` · replayed from a live run recorded ${replayed[0].replayed_from!.slice(0, 10)}` : "")
    : "No model answered: every step used its rule-based path";
  return (
    <div className="sec"><div className="sec-h"><h3>Which model handled each step</h3><span className="line" /></div>
      <p className="hint" style={{ marginTop: 0 }}>{head}</p>
      <div className="calls" role="table" aria-label="Model calls">
        <div className="call h" role="row"><span>Agent</span><span>Model that answered</span><span>Via</span><span>Tokens</span><span>Time</span></div>
        {calls.map((c, i) => (
          <div key={i} className={`call${c.fallback ? " fb" : ""}`} role="row">
            <span><b>{pretty(c.agent)}</b><small>{MODEL_TIER[c.tier] ?? c.tier}{c.thinking ? ", thinking on" : ""}</small></span>
            {c.fallback
              ? <span className="m" title={c.fallback}>rule-based path<small>{c.fallback}</small></span>
              : <span className="m">{short(c.model)}{c.requested_model && <small className="swap" title="The router served a different model from the one Tripwire asked for.">asked for {short(c.requested_model)}</small>}</span>}
            <span>{c.fallback ? "–" : PROVIDER[c.provider ?? ""] ?? c.provider}{c.replayed_from && <small className="rp">replay of {c.replayed_from.slice(0, 16).replace("T", " ")} UTC</small>}{c.receipt_id && <small className="mono">receipt {c.receipt_id}</small>}</span>
            <span>{c.fallback ? "–" : `${c.tokens_in} / ${c.tokens_out}`}</span>
            <span>{c.fallback ? "–" : secs(c.latency_ms)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const STATE: Record<string, string> = { fresh: "within its line", stale: "past its line", missing: "missing" };

export function Sources({ sources }: { sources: SourceFreshness[] }) {
  return (
    <div className="sec"><div className="sec-h"><h3>How current each source was</h3><span className="line" /></div>
      <div className="srcs">{sources.map((s) => (
        <div key={s.table} className={`src-f ${s.status}`} tabIndex={0} data-tip={`${s.note}. Policy: ${s.basis}.`}>
          <b>{s.label}</b><span className="st">{STATE[s.status]}</span>
          <small>{s.age_days != null ? `${s.age_days} days old · line ${s.max_age_days}` : s.note}</small>
          <small className="muted">{s.system}{s.as_of ? ` · as of ${s.as_of}` : ""}</small>
        </div>))}</div>
    </div>
  );
}
