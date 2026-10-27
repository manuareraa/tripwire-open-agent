// Proving Ground stage 3 · Crash-test. Owner: the "crash" stream.
// Each tripwire was pushed just past its line and just short of it, and the decision made again. Kept tripwires carry
// their own result; dropped ones are listed in proving.crash.dropped as "<tripwire> (<verdict>): <why>".
import type { CrashTest, Decision, Tripwire } from "../types";

type Verdict = CrashTest["verdict"] | "already_true";
const LABEL: Record<Verdict, string> = { verified: "verified", decorative: "decorative", mis_set: "mis-set", untested: "untested", already_true: "already true" };
const TIP: Record<Verdict, string> = {
  verified: "Holds just short of the line and changes just past it: this line really guards the call.",
  decorative: "Crossing the line does not change the call, so it would reopen the decision for nothing.",
  mis_set: "The call already changes before the line is reached: the line is set too far out.",
  untested: "Could not be crash-tested; kept as proposed.",
  already_true: "The line is already crossed today, so it could never fire: dropped.",
};
const ORIGIN: Record<string, string> = { decider: "Decider", rules: "rules", premortem: "pre-mortem" };

const words = (m: string) => m.replace(/_/g, " ");
const what = (d: string | undefined, orig: string) => (d === undefined ? "" : d === orig ? `still ${words(orig)}` : `${words(d)}`);

interface Row { key: string; tripwire: string; verdict: Verdict; origin?: string; detail?: string; why?: string; kept: boolean }

function rows(d: Decision): Row[] {
  const out: Row[] = [];
  (d.tripwires ?? []).forEach((t: Tripwire, i) => {
    const c = t.crash_test;
    if (!c || t.origin === "backup" || t.origin === "stale") return;
    const detail = c.verdict === "untested" ? undefined
      : `past ${c.past_value}: ${what(c.past_decision, d.decision)}${c.short_decision ? ` · short ${c.short_value}: ${what(c.short_decision, d.decision)}` : ""}`;
    out.push({ key: `k${i}`, tripwire: `${words(t.metric)} ${t.op} ${t.threshold ?? ""}`, verdict: c.verdict, origin: t.origin, detail, why: c.verdict === "untested" ? c.reason : c.why, kept: true });
  });
  (d.proving?.crash?.dropped ?? []).forEach((s, i) => {
    const m = /^(.*?) \(([^)]*)\)(?:: (.*))?$/.exec(s);
    const v = m?.[2] === "decorative" ? "decorative" : m?.[2] === "mis-set" ? "mis_set" : undefined;
    const already = !v && /^already true today/.test(m?.[2] ?? "");
    out.push({ key: `d${i}`, tripwire: m?.[1] ?? s, verdict: v ?? (already ? "already_true" : "untested"), why: v ? m?.[3] : m?.[2], kept: false });
  });
  return out;
}

export function CrashStage({ d }: { d: Decision }) {
  const c = d.proving?.crash;
  const list = c ? rows(d) : [];
  const survived = list.filter((r) => r.kept && r.verdict === "verified").length;
  return (
    <div className={`pg-stage pg-crash${c && c.tested ? "" : " skipped"}`}>
      <div className="pg-step">3 · Crash-test</div>
      <div className="pg-title">Lightning pushes each tripwire past its line</div>
      {!c && <div className="pg-note muted">Not run for this decision.</div>}
      {c && (
        <>
          <div className="pg-crash-head">
            {c.tested
              ? <><b>{survived} of {c.tested}</b> tripwires survived the crash test</>
              : <>Not crash-tested: {list.find((r) => r.verdict === "untested")?.why ?? "no model answered"}. Tripwires kept as proposed.</>}
          </div>
          <ul className="pg-crash-rows">
            {list.map((r) => (
              <li key={r.key} className={r.kept ? "" : "dropped"}>
                <div className="pg-crash-line">
                  <span className={`pg-crash-badge ${r.verdict}`} title={TIP[r.verdict]}>{LABEL[r.verdict]}</span>
                  <span className="pg-crash-tw">{r.tripwire}</span>
                  {r.origin && ORIGIN[r.origin] && <span className="pg-crash-origin muted">{ORIGIN[r.origin]}</span>}
                  {!r.kept && <span className="pg-crash-origin muted">dropped</span>}
                </div>
                {r.detail && <div className="pg-note muted">{r.detail}</div>}
                {r.why && <div className="pg-note">{r.why}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
