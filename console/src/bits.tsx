// Small pieces shared by several views.
import { useEffect, useRef, type ReactNode } from "react";
import { Ic } from "./icons";
import { TIP } from "./labels";

export const Info = ({ k }: { k: keyof typeof TIP }) => <span className="info" tabIndex={0} data-tip={TIP[k]}>i</span>;
export const Empty = ({ children }: { children: ReactNode }) => <div className="none"><Ic n="empty" />{children}</div>;
export const Spin = () => <span className="spin" />;
export const Html = ({ html, className }: { html: string; className?: string }) => <span className={className} style={className ? undefined : { display: "contents" }} dangerouslySetInnerHTML={{ __html: html }} />;

// Radius plus half the 7-unit stroke (16 + 3.5) stays inside the 40-unit box, so the ring is never clipped square.
export const Ring = ({ v }: { v: number }) => (
  <svg viewBox="0 0 40 40"><circle className="t" cx="20" cy="20" r="16" pathLength={100} /><circle className="v" cx="20" cy="20" r="16" pathLength={100} strokeDasharray={`${v} 100`} /></svg>
);

/** A number that counts up from 0 when it first appears. */
export function CountUp({ to, ms, fmt, initial = "0" }: { to: number; ms: number; fmt?: (v: number) => string; initial?: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { window.TW.countUp(ref.current, to, { ms, fmt }); }, [to]);
  return <b ref={ref}>{initial}</b>;
}
