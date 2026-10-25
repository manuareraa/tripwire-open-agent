// Tripwire brand runtime: the locked look (Deep Sea + Sora), the shared nav, live-mode pills and the guided tour.
// Loaded in <head> without defer so the theme applies before first paint.
(function () {
  const THEMES = [
    { group: "Light", items: [
      ["signal", "Signal"], ["ledger", "Ledger"], ["harbor", "Harbor"], ["clay", "Clay"], ["glacier", "Glacier"] ] },
    { group: "Dark", items: [
      ["nightwatch", "Night Watch"], ["graphite", "Graphite"], ["deepsea", "Deep Sea"], ["ember", "Ember"], ["aurora", "Aurora"] ] },
    { group: "Black and white", items: [["ink", "Ink (mostly black)"], ["paper", "Paper (mostly white)"]] },
  ];
  const GF = "https://fonts.googleapis.com/css2?display=swap&family=";
  const FONTS = [
    ["analyst", "Analyst · Inter", "Inter:wght@400;500;600;700&family=Inter+Tight:wght@600;700&family=JetBrains+Mono:wght@400;500"],
    ["control", "Control Room · Space Grotesk", "Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500"],
    ["boardroom", "Boardroom · Source Serif", "Source+Serif+4:opsz,wght@8..60,600;8..60,700&family=Source+Sans+3:wght@400;500;600;700&family=Source+Code+Pro:wght@400;500"],
    ["audit", "Audit · IBM Plex", "IBM+Plex+Serif:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500"],
    ["modern", "Modern Ops · Sora", "Sora:wght@500;600;700&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500"],
    ["briefing", "Briefing · Newsreader", "Newsreader:opsz,wght@6..72,500;6..72,600;6..72,700&family=Public+Sans:wght@400;500;600;700&family=Roboto+Mono:wght@400;500"],
  ];
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: preference just isn't kept */ } },
  };
  const root = document.documentElement;
  const prefersDark = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;
  const allThemes = THEMES.flatMap((g) => g.items.map((i) => i[0]));

  let themingT;
  function setTheme(id, animate) {
    if (!allThemes.includes(id)) id = prefersDark ? "nightwatch" : "signal";
    if (animate) { root.classList.add("theming"); clearTimeout(themingT); themingT = setTimeout(() => root.classList.remove("theming"), 420); }
    root.dataset.theme = id;
  }
  function setFont(id) {
    const f = FONTS.find((x) => x[0] === id) || FONTS[0];
    root.dataset.font = f[0];
    if (!document.getElementById(`gf-${f[0]}`)) {
      const l = document.createElement("link");
      l.id = `gf-${f[0]}`; l.rel = "stylesheet"; l.href = GF + f[2];
      document.head.appendChild(l);
    }
  }
  // The look is fixed: Deep Sea colours with the Sora / DM Sans / DM Mono pairing. No picker, nothing stored.
  setTheme("deepsea");
  setFont("modern");

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const MARK = `<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="9" fill="var(--primary)"/>
    <path d="M5 20.5h7.2" stroke="var(--on-primary)" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M19.8 20.5H27" stroke="var(--on-primary)" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M12.2 20.5 16 10.5l3.8 10" fill="none" stroke="var(--mark-accent, var(--wire))" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="16" cy="10.5" r="2.4" fill="var(--mark-accent, var(--wire))"/>
  </svg>`;
  const ICON = {
    palette: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4A5.6 5.6 0 0 0 22 9.8C22 5.5 17.5 2 12 2Z"/></svg>`,
    type: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>`,
    play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.2-6.5a1 1 0 0 0 0-1.7L9.5 4.6A1 1 0 0 0 8 5.5Z"/></svg>`,
    help: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/></svg>`,
  };

  /** Render the shared top nav into <header id="nav">. page: "home" | "console". */
  function mountNav(page) {
    const el = document.getElementById("nav");
    if (!el) return;
    el.className = "nav";
    const link = (href, label, id) => `<a href="${href}"${page === id ? ' aria-current="page"' : ""}>${label}</a>`;
    el.innerHTML = `
      <a class="brand" href="/" aria-label="Tripwire home">${MARK}<span class="brand-name">Tripwire</span></a>
      <nav class="nav-links" aria-label="Main">
        ${link("/#how", "How it works", "how")}
        ${link("/#agents", "Agents", "agents")}
        ${link("/#guide", "Guide", "guide")}
        ${link("/console", "Console", "console")}
      </nav>
      <div class="nav-tools">
        ${page === "console"
          ? `<button class="btn sm" id="tour-btn" type="button">${ICON.help}<span class="btn-label">Tour</span></button>`
          : `<a class="btn sm primary cta" href="/console?tour=1">${ICON.play}<span class="btn-label">Start demo</span></a>`}
      </div>`;
  }

  let healthP;
  const health = () => (healthP ??= fetch("/health").then((r) => r.json()).catch(() => null));

  /** Plain-language status of each sponsor technology, from GET /health. */
  async function modes() {
    const h = await health();
    const m = h?.modes ?? {};
    return [
      { key: "data", name: "Zetaris", role: "data layer", live: m.data === "zetaris",
        tip: m.data === "zetaris" ? "Live: every number is read with Zetaris SQL, and approvals are written back to a Zetaris Parquet ledger." : "Fallback: using the bundled sample files (same tables and queries) because Zetaris is not configured." },
      { key: "model", name: "NVIDIA Nemotron", role: "reasoning", live: m.model === "nemotron",
        tip: m.model === "nemotron" ? "Live: the Planner, Analyst, Decider and safety check call Nemotron models." : "Fallback: no NVIDIA key, so model steps use a simple rule-based policy. The trace and rationale say so." },
      { key: "memory", name: "Meterless H-MEM", role: "memory", live: m.memory === "meterless-hmem",
        tip: m.memory === "meterless-hmem" ? "Live: claims and their lineage are stored in Meterless H-MEM, which runs inside the app." : "Fallback: local lineage store." },
    ];
  }
  async function renderModes(el) {
    if (!el) return;
    const list = await modes();
    el.innerHTML = list.map((x) => `<span class="pill ${x.live ? "live" : "fallback"}" tabindex="0" data-tip="${esc(x.tip)}"><span class="dot"></span><b>${esc(x.name)}</b>&nbsp;${x.live ? "live" : "fallback"}</span>`).join("");
  }

  // ---------- Guided tour ----------
  // steps: [{ el: "#selector" | null, title, body, before?: () => void }]
  function tour(steps, opts = {}) {
    let i = 0;
    const blocker = Object.assign(document.createElement("div"), { className: "tour-blocker" });
    const spot = Object.assign(document.createElement("div"), { className: "tour-spot" });
    const pop = Object.assign(document.createElement("div"), { className: "tour-pop" });
    pop.setAttribute("role", "dialog"); pop.setAttribute("aria-modal", "true");
    document.body.append(blocker, spot, pop);

    function target() { const s = steps[i].el; const t = s && document.querySelector(s); return t && t.getClientRects().length ? t : null; }
    function place() {
      const t = target();
      const vw = innerWidth, vh = innerHeight, pad = 8, gap = 14;
      const pw = pop.offsetWidth, ph = pop.offsetHeight;
      if (!t) {
        spot.classList.add("center");
        Object.assign(spot.style, { top: `${vh / 2}px`, left: `${vw / 2}px` });
        Object.assign(pop.style, { top: `${Math.max(16, (vh - ph) / 2)}px`, left: `${(vw - pw) / 2}px` });
        return;
      }
      spot.classList.remove("center");
      const r = t.getBoundingClientRect();
      const top = Math.max(4, r.top - pad), left = Math.max(4, r.left - pad);
      const w = Math.min(vw - 8, r.width + pad * 2), h = Math.min(vh - 8, r.height + pad * 2);
      Object.assign(spot.style, { top: `${top}px`, left: `${left}px`, width: `${w}px`, height: `${h}px` });
      let pt, pl;
      if (vw < 640) { pt = vh - ph - 16; pl = (vw - pw) / 2; if (r.bottom > pt - 8 && r.top > ph + 32) pt = 16; }
      else if (top + h + gap + ph < vh) { pt = top + h + gap; pl = left; }
      else if (top - gap - ph > 0) { pt = top - gap - ph; pl = left; }
      else if (left + w + gap + pw < vw) { pt = Math.max(16, Math.min(vh - ph - 16, top)); pl = left + w + gap; }
      else { pt = Math.max(16, Math.min(vh - ph - 16, top)); pl = left - gap - pw; }
      pl = Math.max(16, Math.min(vw - pw - 16, pl));
      Object.assign(pop.style, { top: `${pt}px`, left: `${pl}px` });
    }
    function show() {
      const s = steps[i];
      s.before?.();
      const n = steps.length;
      pop.innerHTML = `
        <div class="tour-bar"><i style="width:${((i + 1) / n) * 100}%"></i></div>
        <div class="tour-step">Step ${i + 1} of ${n}</div>
        <h3>${s.title}</h3><p>${s.body}</p>
        <div class="tour-actions">
          <button class="btn ghost sm" data-a="skip" type="button">${i === n - 1 ? "Close" : "Skip tour"}</button>
          <span class="spacer"></span>
          ${i > 0 ? `<button class="btn sm" data-a="back" type="button">Back</button>` : ""}
          <button class="btn primary sm" data-a="next" type="button">${i === n - 1 ? (opts.finishLabel || "Start using it") : "Next"}</button>
        </div>`;
      pop.setAttribute("aria-label", s.title);
      pop.classList.remove("enter"); void pop.offsetWidth; pop.classList.add("enter");
      const t = target();
      if (t) t.scrollIntoView({ block: "center" });
      requestAnimationFrame(() => { place(); pop.querySelector('[data-a="next"]').focus(); });
    }
    function end() {
      blocker.remove(); spot.remove(); pop.remove();
      removeEventListener("resize", place); removeEventListener("scroll", place, true); removeEventListener("keydown", key);
      opts.onEnd?.();
    }
    function go(d) { const j = i + d; if (j < 0) return; if (j >= steps.length) return end(); i = j; show(); }
    function key(e) { if (e.key === "Escape") end(); else if (e.key === "ArrowRight") go(1); else if (e.key === "ArrowLeft") go(-1); }
    pop.addEventListener("click", (e) => { const a = e.target.closest("[data-a]")?.dataset.a; if (a === "next") go(1); else if (a === "back") go(-1); else if (a === "skip") end(); });
    addEventListener("resize", place); addEventListener("scroll", place, true); addEventListener("keydown", key);
    show();
  }

  // ---------- Motion helpers ----------
  const reduced = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // A thin bar under the nav whenever a same-origin request is in flight, so every action shows it is working.
  let inflight = 0, barT;
  function bar() {
    let el = document.querySelector(".tw-progress");
    if (!el && document.body) { el = Object.assign(document.createElement("div"), { className: "tw-progress", innerHTML: "<i></i>" }); document.body.appendChild(el); }
    return el;
  }
  function busy(d) {
    inflight = Math.max(0, inflight + d);
    clearTimeout(barT);
    if (inflight) barT = setTimeout(() => bar()?.classList.add("on"), 120);
    else bar()?.classList.remove("on");
  }
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url ?? "";
    const mine = url.startsWith("/") || url.startsWith(location.origin);
    if (!mine) return nativeFetch(input, init);
    busy(1);
    return nativeFetch(input, init).finally(() => busy(-1));
  };

  // Fade the page out before following an internal link, where the browser has no cross-page view transitions.
  const hasViewTransitions = "onpagereveal" in window;
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[href]");
    if (!a || hasViewTransitions || reduced() || e.metaKey || e.ctrlKey || e.shiftKey || a.target === "_blank") return;
    const u = new URL(a.href, location.href);
    if (u.origin !== location.origin || (u.pathname === location.pathname && u.hash)) return;
    e.preventDefault();
    document.body.classList.add("leaving");
    setTimeout(() => { location.href = u.href; }, 160);
  });
  addEventListener("pageshow", () => document.body?.classList.remove("leaving"));

  /** Fade elements with .reveal in as they scroll into view. */
  function reveal(scope = document) {
    const els = [...scope.querySelectorAll(".reveal:not(.in)")];
    if (!("IntersectionObserver" in window) || reduced()) { els.forEach((el) => el.classList.add("in")); return; }
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    els.forEach((el) => io.observe(el));
  }

  /** Count a number up (from 0 unless given) inside el. fmt turns the running value into text. */
  function countUp(el, to, { from = 0, ms = 700, fmt = (v) => String(Math.round(v)) } = {}) {
    if (!el) return;
    if (reduced() || !Number.isFinite(to)) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** The brand mark with its wire drawing on a loop: the shared loading animation. */
  const LOADER = `<span class="tw-loader" aria-hidden="true"><svg viewBox="0 0 32 32">
      <path d="M3 20.5h9.2" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity=".35"/>
      <path d="M19.8 20.5H29" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity=".35"/>
      <path class="w" d="M3 20.5h9.2L16 10.5l3.8 10H29" fill="none" stroke="var(--wire)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      <circle class="k" cx="16" cy="10.5" r="2.4" fill="var(--wire)"/></svg></span>`;

  /** One floating tooltip for every [data-tip] element. It lives on <body> with fixed position, so scroll
   *  areas and overflow-hidden cards can't clip it, and it is kept inside the viewport. */
  function tips() {
    const tip = Object.assign(document.createElement("div"), { className: "tw-tip", role: "tooltip", id: "tw-tip" });
    document.body.appendChild(tip);
    let cur = null;
    const show = (el) => {
      const text = el.getAttribute("data-tip");
      if (!text) return;
      cur = el; tip.textContent = text; tip.style.left = "0px"; el.setAttribute("aria-describedby", "tw-tip");
      tip.classList.add("on");
      const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect(), m = 8;
      let top = r.top - t.height - m;
      const below = top < m;
      if (below) top = r.bottom + m;
      const left = Math.max(m, Math.min(innerWidth - t.width - m, r.left + r.width / 2 - t.width / 2));
      tip.style.top = `${Math.round(top)}px`; tip.style.left = `${Math.round(left)}px`;
      tip.classList.toggle("below", below);
    };
    const hide = () => { if (cur) cur.removeAttribute("aria-describedby"); cur = null; tip.classList.remove("on"); };
    const find = (e) => e.target instanceof Element ? e.target.closest("[data-tip]") : null;
    document.addEventListener("pointerover", (e) => { const el = find(e); if (el && el !== cur) show(el); else if (!el && cur) hide(); });
    document.addEventListener("focusin", (e) => { const el = find(e); if (el) show(el); });
    document.addEventListener("focusout", hide);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  }
  if (document.body) tips(); else document.addEventListener("DOMContentLoaded", tips);

  window.TW = { THEMES, FONTS, setTheme, setFont, mountNav, health, modes, renderModes, tour, esc, store, ICON, busy, reveal, countUp, reduced, LOADER };
})();
