// Bottom action bar: shown only while a decision waits for a person.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Spin } from "./bits";
import { pct } from "./format";
import { Ic } from "./icons";
import { LABEL, TIP } from "./labels";
import { supName } from "./names";
import { suggestReason } from "./plain";
import type { Decision } from "./types";

export function ActionBar({ d, onApprove, onReject }: { d: Decision; onApprove: (reason: string) => Promise<void>; onReject: () => Promise<void> }) {
  const tip = suggestReason(d);
  const bar = useRef<HTMLDivElement>(null);
  const reasonEl = useRef<HTMLTextAreaElement>(null);
  const useEl = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState(false);
  // Open on wide screens; on phones it starts folded so the page stays readable (Approve unfolds it if a reason is missing).
  const [open, setOpen] = useState(() => innerWidth > 720);
  const [writing, setWriting] = useState(false);
  const [reason, setReason] = useState("");
  const [src, setSrc] = useState("Your reason");
  const [err, setErr] = useState({ msg: "", n: 0 });
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const focusAfter = useRef<"end" | "use" | "reason" | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => setShown(true));
    const el = bar.current!;
    const fit = () => document.body.style.setProperty("--ab-h", `${el.offsetHeight}px`);
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => { ro.disconnect(); document.body.style.removeProperty("--ab-h"); };
  }, []);
  useLayoutEffect(() => {
    const f = focusAfter.current; focusAfter.current = null;
    if (f === "use") useEl.current?.focus();
    else if (f) { const r = reasonEl.current; if (!r) return; r.focus(); if (f === "end") r.setSelectionRange(r.value.length, r.value.length); }
  });

  const fail = (msg: string) => setErr((e) => ({ msg, n: e.n + 1 }));
  const showWrite = (text: string, from: string) => { setErr({ msg: "", n: err.n }); setWriting(true); setReason(text); setSrc(from); focusAfter.current = "end"; };
  const approve = async () => {
    const r0 = writing ? reason.trim() : "";
    if (d.escalated && !r0) { setOpen(true); fail("Escalated decisions need a reason. Use the suggestion or write your own."); focusAfter.current = writing ? "reason" : "use"; return; }
    setBusy("approve");
    try { await onApprove(r0); } catch (e) { fail((e as Error).message); setBusy(null); }
  };
  const reject = async () => { setBusy("reject"); await onReject(); };

  return (
    <div className={`actionbar${shown ? " in" : ""}`} id="actionbar" role="region" aria-label="Your decision" ref={bar}>
      <div className="ab-in">
        <div className="ab-top">
          <div className="ab-sum"><span className="ab-dot" /><div><div className="eyebrow">Needs your decision</div>
            <b>{supName(d.subject_id)}: <span className={`verdict ${d.decision}`}>{LABEL[d.decision] ?? d.decision}</span> at {pct(d.confidence ?? 0)}</b>{d.escalated && <span className="st esc" tabIndex={0} data-tip={TIP.escalated}>escalated<span className="ab-req"> · reason required</span></span>}</div></div>
          <button className={`ab-toggle${open ? " open" : ""}`} id="ab-toggle" type="button" aria-expanded={open} aria-controls="ab-body" onClick={() => setOpen(!open)}>Reason<Ic n="chev" /></button>
          <div className="ab-act">
            <button className="btn ghost" id="reject" type="button" disabled={!!busy} onClick={reject}>{busy === "reject" ? <><Spin />Rejecting…</> : "Reject"}</button>
            <button className="btn primary" id="approve" type="button" disabled={!!busy} onClick={approve}>{busy === "approve" ? <><Spin />Writing to the ledger…</> : <><Ic n="check" />Approve and write to ledger</>}</button>
          </div>
        </div>
        <div className="ab-body" id="ab-body" hidden={!open}>
          <div className="ab-sug" id="ab-sug" hidden={writing}>
            <div className="ab-sug-h"><Ic n="bulb" /><span>Suggested reason</span><span className="info" tabIndex={0} data-tip="Drafted in your browser from what the agents found: the verdict, the risk flags and the tripwires. No extra model call. Use it, edit it or write your own.">i</span></div>
            <p>{tip}</p>
            <div className="row"><button className="btn sm primary" id="ab-use" type="button" ref={useEl} onClick={() => showWrite(tip, "Suggested reason, yours to edit")}><Ic n="check" />Use this reason</button><button className="btn sm ghost" id="ab-own" type="button" onClick={() => showWrite("", "Your reason")}>Write my own</button></div>
          </div>
          <div className="ab-write" id="ab-write" hidden={!writing}>
            <label className="field" htmlFor="reason"><span id="ab-src">{src}</span> {d.escalated ? "(required)" : "(optional)"}</label>
            <textarea className="input" id="reason" rows={2} ref={reasonEl} value={reason} placeholder={d.escalated ? "Why you agree, in a sentence. It goes on the record." : "Optional note for the record"}
              onChange={(e) => { setReason(e.target.value); if (src.startsWith("Suggested") && e.target.value !== tip) setSrc("Suggested reason, edited by you"); }} />
            <button className="linkbtn" id="ab-back" type="button" onClick={() => { setWriting(false); setReason(""); }}>Show the suggestion again</button>
          </div>
          <div className="err" id="writeres" role="alert" key={err.n}>{err.msg}</div>
        </div>
      </div>
    </div>
  );
}
