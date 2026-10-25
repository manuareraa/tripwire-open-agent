// Line icons, drawn the same way as the rest of the site.

const P = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  wire: '<path d="M2 16h6M16 16h6M8 16l4-9 4 9"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  bulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2Z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8M15 7h6v6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  agents: '<circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M2 20c0-3.3 2.7-6 6-6s6 2.7 6 6M14 20c0-2.5 1.3-4.5 3-4.5s3 2 3 4.5"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6Z"/><path d="m9 12 2 2 4-4"/>',
  empty: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 10h18M8 15h5"/>',
  exit: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  done: '<circle cx="12" cy="12" r="10"/><path d="m7 12.5 3.2 3.2L17 9"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
};
const WIDTH: Partial<Record<keyof typeof P, number>> = { check: 3, wire: 2.4, empty: 1.8, done: 2.4, pulse: 1.8 };
export type IconName = keyof typeof P;

export function Ic({ n, className }: { n: IconName; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={WIDTH[n] ?? 2} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: P[n] }} />;
}
export const Play = () => <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.2-6.5a1 1 0 0 0 0-1.7L9.5 4.6A1 1 0 0 0 8 5.5Z" /></svg>;
export const VICON: Record<string, IconName> = { keep: "shield", dual_source: "agents", exit: "exit" };
