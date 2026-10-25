// The shared site script (web/assets/brand.js) loads before the console and sets window.TW.
interface TourStep { el: string | null; title: string; body: string }

interface Window {
  TW: {
    mountNav(page: string): void;
    renderModes(el: HTMLElement | null): void;
    tour(steps: TourStep[], opts?: { finishLabel?: string }): void;
    countUp(el: Element | null, to: number, opts?: { from?: number; ms?: number; fmt?: (v: number) => string }): void;
    reduced(): boolean;
    LOADER: string;
  };
}
