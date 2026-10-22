// Nemotron via build.nvidia.com (OpenAI-compatible). Three tiers; thinking is switched per call
// (the Risk Officer decides). With no key, or on timeout/error, returns fallback: true and the
// calling agent uses its rule-based path. Never throws.
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

type FetchLike = typeof fetch;

export class NemotronClient implements ModelClient {
  constructor(
    private apiKey = config.nvidia.apiKey,
    private baseUrl = config.nvidia.baseUrl,
    private timeoutMs = config.nvidia.timeoutMs,
    private fetchImpl: FetchLike = fetch,
  ) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const model = modelFor(req.tier);
    const thinking = req.tier !== "guard" && !!req.thinking;
    const started = Date.now();
    if (!this.apiKey) return fallback(model, thinking, started, "no NVIDIA_API_KEY");

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
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      let res = await this.post(body, ctrl.signal);
      // Some models reject response_format; retry once without it.
      if (res.status === 400 && body.response_format) {
        delete body.response_format;
        res = await this.post(body, ctrl.signal);
      }
      if (!res.ok) return fallback(model, thinking, started, `HTTP ${res.status}`);
      const data = (await res.json()) as {
        choices?: { message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const msg = data.choices?.[0]?.message ?? {};
      const text = msg.content ?? "";
      if (!text.trim()) return fallback(model, thinking, started, "empty response");
      const reasoning = msg.reasoning_content ?? msg.reasoning ?? "";
      return {
        text,
        model,
        thinking,
        tokens_in: data.usage?.prompt_tokens ?? 0,
        tokens_out: data.usage?.completion_tokens ?? 0,
        latency_ms: Date.now() - started,
        fallback: false,
        reasoning_excerpt: reasoning ? reasoning.slice(0, 300) : undefined,
      };
    } catch (e) {
      const reason = (e as Error).name === "AbortError" ? `timeout after ${this.timeoutMs} ms` : (e as Error).message;
      return fallback(model, thinking, started, reason);
    } finally {
      clearTimeout(timer);
    }
  }

  private post(body: Record<string, unknown>, signal: AbortSignal) {
    return this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }
}

/** Used in SAMPLE_MODE: every call reports fallback so agents run their rule-based paths. */
export class RulesOnlyClient implements ModelClient {
  async complete(req: ModelRequest): Promise<ModelResponse> {
    return fallback(modelFor(req.tier), false, Date.now(), "SAMPLE_MODE: rules only");
  }
}

function fallback(model: string, thinking: boolean, started: number, error: string): ModelResponse {
  return { text: "", model, thinking, tokens_in: 0, tokens_out: 0, latency_ms: Date.now() - started, fallback: true, error };
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
