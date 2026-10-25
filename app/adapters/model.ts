// Nemotron through Meterless Nightshift (the primary provider, an OpenAI-compatible runtime on the user's machine),
// with build.nvidia.com as a labelled direct backup. Three tiers; thinking is switched per call (the Risk Officer
// decides). With no provider, or on timeout/error, returns fallback: true and the calling agent uses its rule-based
// path. Never throws.
import { readFileSync } from "node:fs";
import { config } from "../config.js";
import type { ModelClient, ModelRequest, ModelResponse, ModelTier } from "../types.js";

export const DEFAULT_MODELS: Record<ModelTier, string> = {
  reasoning: "nvidia/nemotron-3-ultra-550b-a55b",
  small: "nvidia/nemotron-3.5-lightning-30b-a3b",
  guard: "nvidia/nemotron-3.5-content-safety",
};

export function modelFor(tier: ModelTier): string {
  const n = config.nvidia;
  const set = { reasoning: n.reasoningModel, small: n.smallModel, guard: n.guardModel }[tier];
  return set || DEFAULT_MODELS[tier];
}

/** Model id asked of Nightshift. Nemotron ids by default; a meterless/* routing mode can be set per tier. */
export function nightshiftModelFor(tier: ModelTier): string {
  const n = config.nightshift;
  const set = { reasoning: n.reasoningModel, small: n.smallModel, guard: n.guardModel }[tier];
  return set || DEFAULT_MODELS[tier];
}

/** Any pasted runtime URL (with or without scheme, /v1, /v1/chat/completions, /v1/models, /healthz) → <host>/v1. */
export function normaliseRuntimeUrl(raw: string): string {
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  u = u.replace(/\/+$/, "").replace(/\/(v1\/chat\/completions|v1\/models|healthz|v1)$/i, "").replace(/\/+$/, "");
  return `${u}/v1`;
}

type FetchLike = typeof fetch;

interface Wire {
  /** Provider name written to traces. */
  provider: string;
  baseUrl: string;
  token: string;
  timeoutMs: number;
  headers: Record<string, string>;
  modelFor: (tier: ModelTier) => string;
  /** Message shown when the client has no credential. */
  missing: string;
}

class OpenAICompatClient implements ModelClient {
  constructor(protected wire: Wire, private fetchImpl: FetchLike = fetch) {}

  get enabled(): boolean {
    return !!this.wire.token;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const w = this.wire;
    const model = w.modelFor(req.tier);
    const thinking = req.tier !== "guard" && !!req.thinking;
    const started = Date.now();
    if (!w.token) return fallback(model, thinking, started, w.missing, w.provider);

    const messages = req.tier === "guard"
      ? [{ role: "user", content: req.user }]
      : [{ role: "system", content: req.system }, { role: "user", content: req.user }];
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: req.max_tokens ?? (thinking ? 4000 : 800),
      temperature: req.tier === "guard" ? 0 : 0.2,
    };
    if (req.tier !== "guard") body.chat_template_kwargs = { enable_thinking: thinking };
    if (req.json && req.tier !== "guard") body.response_format = { type: "json_object" };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), w.timeoutMs);
    try {
      let res = await this.post(body, ctrl.signal);
      // Some models reject response_format; retry once without it.
      if (res.status === 400 && body.response_format) {
        delete body.response_format;
        res = await this.post(body, ctrl.signal);
      }
      if (res.status === 401 || res.status === 403) return fallback(model, thinking, started, `unauthorized (HTTP ${res.status})`, w.provider);
      if (!res.ok) return fallback(model, thinking, started, `HTTP ${res.status}`, w.provider);
      const data = (await res.json()) as {
        model?: string;
        choices?: { message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        meterless?: unknown;
      };
      const msg = data.choices?.[0]?.message ?? {};
      const text = msg.content ?? "";
      if (!text.trim()) return fallback(model, thinking, started, "empty response", w.provider);
      const reasoning = msg.reasoning_content ?? msg.reasoning ?? "";
      const receipt = receiptOf(data.meterless, res.headers);
      // The model that really answered: the provider's own report wins over the id we asked for.
      const served = receipt.routed_model || receipt.provider_model || receipt["winning_route.model"] || data.model || model;
      return {
        text,
        model: served,
        requested_model: model,
        thinking,
        tokens_in: data.usage?.prompt_tokens ?? 0,
        tokens_out: data.usage?.completion_tokens ?? 0,
        latency_ms: Date.now() - started,
        fallback: false,
        reasoning_excerpt: reasoning ? reasoning.slice(0, 300) : undefined,
        provider: w.provider,
        ...(Object.keys(receipt).length ? { receipt } : {}),
      };
    } catch (e) {
      const reason = (e as Error).name === "AbortError" ? `timeout after ${w.timeoutMs} ms` : (e as Error).message;
      return fallback(model, thinking, started, reason, w.provider);
    } finally {
      clearTimeout(timer);
    }
  }

  private post(body: Record<string, unknown>, signal: AbortSignal) {
    return this.fetchImpl(`${this.wire.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.wire.token}`, "content-type": "application/json", ...this.wire.headers },
      body: JSON.stringify(body),
      signal,
    });
  }

  /** GET /v1/models decides status: 401/403 unauthorized, 200 online, anything else offline. */
  async discover(): Promise<{ status: "online" | "unauthorized" | "offline"; detail: string; models: string[] }> {
    if (!this.wire.token) return { status: "offline", detail: this.wire.missing, models: [] };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(this.wire.timeoutMs, 10000));
    try {
      const res = await this.fetchImpl(`${this.wire.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.wire.token}`, ...this.wire.headers }, signal: ctrl.signal,
      });
      if (res.status === 401 || res.status === 403) return { status: "unauthorized", detail: `HTTP ${res.status}`, models: [] };
      if (!res.ok) return { status: "offline", detail: `HTTP ${res.status}`, models: [] };
      const data = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
      const models = (data.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
      return { status: "online", detail: `${models.length} model ids`, models };
    } catch (e) {
      return { status: "offline", detail: (e as Error).name === "AbortError" ? "timeout" : (e as Error).message, models: [] };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Nightshift's receipt: scalar fields of the body's `meterless` object (nested ones as a.b) plus meterless-* headers. */
export function receiptOf(meterless: unknown, headers?: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (o: unknown, prefix: string, depth: number) => {
    if (!o || typeof o !== "object" || depth > 2) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "object") walk(v, `${prefix}${k}.`, depth + 1);
      else out[`${prefix}${k}`] = String(v).slice(0, 200);
    }
  };
  walk(meterless, "", 0);
  headers?.forEach((v, k) => {
    if (k.toLowerCase().startsWith("meterless-")) out[`header.${k.toLowerCase()}`] = v.slice(0, 200);
  });
  return out;
}

function readToken(token: string, file: string): string {
  if (token) return token;
  if (!file) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/** Meterless Nightshift runtime (the hotspot): the primary provider. */
export class NightshiftClient extends OpenAICompatClient {
  constructor(
    opts: Partial<{ baseUrl: string; token: string; tokenFile: string; appId: string; timeoutMs: number }> = {},
    fetchImpl: FetchLike = fetch,
  ) {
    const n = config.nightshift;
    super({
      provider: "meterless-nightshift",
      baseUrl: normaliseRuntimeUrl(opts.baseUrl ?? n.baseUrl),
      token: readToken(opts.token ?? n.token, opts.tokenFile ?? n.tokenFile),
      timeoutMs: opts.timeoutMs ?? n.timeoutMs,
      headers: { "meterless-app": (opts.appId ?? n.appId).toLowerCase(), "meterless-scope": "user" },
      modelFor: nightshiftModelFor,
      missing: "no METERLESS_RUNTIME_TOKEN",
    }, fetchImpl);
  }
}

/** build.nvidia.com directly. Only a backup: the hackathon's primary provider is Nightshift. */
export class NemotronClient extends OpenAICompatClient {
  constructor(apiKey = config.nvidia.apiKey, baseUrl = config.nvidia.baseUrl, timeoutMs = config.nvidia.timeoutMs, fetchImpl: FetchLike = fetch) {
    super({ provider: "nvidia", baseUrl, token: apiKey, timeoutMs, headers: {}, modelFor, missing: "no NVIDIA_API_KEY" }, fetchImpl);
  }
}

/**
 * Primary first; when it gives no answer (offline, timeout, error), the backup is tried and the trace says so.
 * The primary's failure reason travels with the backup's answer.
 */
export class FallbackModelClient implements ModelClient {
  constructor(private primary: ModelClient, private backup: ModelClient) {}

  get enabled(): boolean {
    return !!(this.primary.enabled || this.backup.enabled);
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const first = await this.primary.complete(req);
    if (!first.fallback) return first;
    const second = await this.backup.complete(req);
    const why = `${first.provider ?? "primary"}: ${first.error}`;
    return second.fallback
      ? { ...second, error: `${why}; ${second.provider ?? "backup"}: ${second.error}` }
      : { ...second, receipt: { ...(second.receipt ?? {}), primary_failed: why } };
  }
}

/** Used in SAMPLE_MODE: every call reports fallback so agents run their rule-based paths. */
export class RulesOnlyClient implements ModelClient {
  readonly enabled = false;
  async complete(req: ModelRequest): Promise<ModelResponse> {
    return fallback(modelFor(req.tier), false, Date.now(), "SAMPLE_MODE: rules only");
  }
}

function fallback(model: string, thinking: boolean, started: number, error: string, provider?: string): ModelResponse {
  return { text: "", model, requested_model: model, thinking, tokens_in: 0, tokens_out: 0, latency_ms: Date.now() - started, fallback: true, error, ...(provider ? { provider } : {}) };
}

/** Pull the first JSON object out of a model reply (handles ```json fences and stray prose). */
export function extractJson<T = unknown>(text: string): T | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}

/** Guard models answer like "User Safety: safe" / "unsafe". */
export function guardVerdict(text: string): "safe" | "unsafe" | "unknown" {
  const t = text.toLowerCase();
  if (/\bunsafe\b/.test(t)) return "unsafe";
  if (/\bsafe\b/.test(t)) return "safe";
  return "unknown";
}
