import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODELS,
  extractJson,
  FallbackModelClient,
  NemotronClient,
  NightshiftClient,
  normaliseRuntimeUrl,
} from "../app/adapters/model.js";

const API_KEY = "test-nvidia-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("NemotronClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns fallback when no API key and does not call fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = new NemotronClient("");
    const res = await client.complete({
      tier: "small",
      agent_name: "analyst",
      system: "sys",
      user: "hello",
    });

    expect(res.fallback).toBe(true);
    expect(res.error).toBe("no NVIDIA_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reasoning tier with thinking sends enable_thinking and ultra model, returns reasoning_excerpt", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        choices: [
          {
            message: {
              content: "answer text",
              reasoning_content: "step one ".repeat(40),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new NemotronClient(API_KEY);
    const res = await client.complete({
      tier: "reasoning",
      agent_name: "decider",
      system: "You decide",
      user: "Supplier X?",
      thinking: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedBody?.model).toBe(DEFAULT_MODELS.reasoning);
    expect(capturedBody?.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(res.fallback).toBe(false);
    expect(res.thinking).toBe(true);
    expect(res.model).toBe(DEFAULT_MODELS.reasoning);
    expect(res.text).toBe("answer text");
    expect(res.reasoning_excerpt).toHaveLength(300);
    expect(res.reasoning_excerpt).toBe("step one ".repeat(40).slice(0, 300));
  });

  it("guard tier sends only the user message", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        choices: [{ message: { content: "User Safety: safe" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new NemotronClient(API_KEY);
    const res = await client.complete({
      tier: "guard",
      agent_name: "risk_officer",
      system: "ignored system prompt",
      user: "check this output",
    });

    expect(res.fallback).toBe(false);
    expect(capturedBody?.messages).toEqual([{ role: "user", content: "check this output" }]);
    expect(capturedBody?.chat_template_kwargs).toBeUndefined();
  });

  it("HTTP 400 with json=true retries once without response_format", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.response_format) {
        return jsonResponse({ error: "bad format" }, 400);
      }
      return jsonResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new NemotronClient(API_KEY);
    const res = await client.complete({
      tier: "small",
      agent_name: "analyst",
      system: "sys",
      user: "give json",
      json: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0]?.response_format).toEqual({ type: "json_object" });
    expect(bodies[1]?.response_format).toBeUndefined();
    expect(res.fallback).toBe(false);
    expect(res.text).toBe('{"ok":true}');
  });

  it("HTTP 500 returns fallback with error and never throws", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "boom" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    const client = new NemotronClient(API_KEY);
    await expect(
      client.complete({
        tier: "small",
        agent_name: "analyst",
        system: "sys",
        user: "hi",
      }),
    ).resolves.toMatchObject({
      fallback: true,
      error: "HTTP 500",
      text: "",
    });
  });
});

describe("extractJson", () => {
  it("pulls a JSON object out of fenced text", () => {
    const text = `Here is the result:
\`\`\`json
{"score": 42, "label": "keep"}
\`\`\`
Thanks.`;
    expect(extractJson<{ score: number; label: string }>(text)).toEqual({
      score: 42,
      label: "keep",
    });
  });
});

describe("NightshiftClient", () => {
  const req = { tier: "small" as const, agent_name: "planner", system: "sys", user: "hi" };

  it("normalises pasted runtime URLs to <host>/v1 and never /v1/v1", () => {
    for (const raw of ["127.0.0.1:8088", "http://127.0.0.1:8088/", "http://127.0.0.1:8088/v1", "http://127.0.0.1:8088/v1/chat/completions", "http://127.0.0.1:8088/v1/models", "http://127.0.0.1:8088/healthz"]) {
      expect(normaliseRuntimeUrl(raw)).toBe("http://127.0.0.1:8088/v1");
    }
  });

  it("sends the bearer token, app and scope headers, and records the served model and receipt", async () => {
    let url = "";
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (u: string, init?: RequestInit) => {
      url = u;
      headers = init?.headers as Record<string, string>;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model: "nvidia/nemotron-3.5-lightning-30b-a3b",
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
        meterless: { receipt_id: "rcpt_1", routed_model: "nvidia/nemotron-3.5-lightning-30b-a3b", winning_route: { provider: "nvidia", kind: "cloud" } },
      }), { status: 200, headers: { "content-type": "application/json", "meterless-route": "nvidia" } });
    });
    const client = new NightshiftClient({ baseUrl: "127.0.0.1:8088/v1/", token: "rt-test", appId: "Tripwire" }, fetchMock as unknown as typeof fetch);
    const res = await client.complete(req);

    expect(url).toBe("http://127.0.0.1:8088/v1/chat/completions");
    expect(headers.Authorization).toBe("Bearer rt-test");
    expect(headers["meterless-app"]).toBe("tripwire");
    expect(headers["meterless-scope"]).toBe("user");
    expect(body.model).toBe(DEFAULT_MODELS.small);
    expect(res).toMatchObject({ fallback: false, text: "ok", provider: "meterless-nightshift", model: "nvidia/nemotron-3.5-lightning-30b-a3b", tokens_in: 7 });
    expect(res.receipt).toMatchObject({ receipt_id: "rcpt_1", "winning_route.provider": "nvidia", "header.meterless-route": "nvidia" });
  });

  it("reports a wrong token as unauthorized, not offline", async () => {
    const fetchMock = vi.fn(async () => new Response("no", { status: 401 }));
    const client = new NightshiftClient({ token: "bad", baseUrl: "http://127.0.0.1:8088" }, fetchMock as unknown as typeof fetch);
    expect((await client.discover()).status).toBe("unauthorized");
    expect(await client.complete(req)).toMatchObject({ fallback: true, error: "unauthorized (HTTP 401)" });
  });

  it("discovers an online runtime from GET /v1/models and an absent one as offline", async () => {
    const online = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "meterless/fast" }, { id: "meterless/deep" }] }), { status: 200 }));
    expect(await new NightshiftClient({ token: "t", baseUrl: "http://x:1" }, online as unknown as typeof fetch).discover())
      .toMatchObject({ status: "online", models: ["meterless/fast", "meterless/deep"] });
    const down = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    expect((await new NightshiftClient({ token: "t", baseUrl: "http://x:1" }, down as unknown as typeof fetch).discover()).status).toBe("offline");
  });
});

describe("FallbackModelClient", () => {
  const req = { tier: "small" as const, agent_name: "planner", system: "sys", user: "hi" };
  const answer = (provider: string) => ({ text: "a", model: "m", thinking: false, tokens_in: 1, tokens_out: 1, latency_ms: 1, fallback: false, provider });
  const miss = (provider: string, error: string) => ({ text: "", model: "m", thinking: false, tokens_in: 0, tokens_out: 0, latency_ms: 1, fallback: true, provider, error });

  it("uses the primary when it answers and never calls the backup", async () => {
    const backup = { complete: vi.fn() };
    const res = await new FallbackModelClient({ complete: async () => answer("meterless-nightshift") }, backup).complete(req);
    expect(res.provider).toBe("meterless-nightshift");
    expect(backup.complete).not.toHaveBeenCalled();
  });

  it("falls back to the backup and keeps the primary's failure reason", async () => {
    const res = await new FallbackModelClient({ complete: async () => miss("meterless-nightshift", "timeout") }, { complete: async () => answer("nvidia") }).complete(req);
    expect(res).toMatchObject({ fallback: false, provider: "nvidia", receipt: { primary_failed: "meterless-nightshift: timeout" } });
  });

  it("reports both failures when neither answers", async () => {
    const res = await new FallbackModelClient({ complete: async () => miss("meterless-nightshift", "offline") }, { complete: async () => miss("nvidia", "HTTP 500") }).complete(req);
    expect(res).toMatchObject({ fallback: true, error: "meterless-nightshift: offline; nvidia: HTTP 500" });
  });
});
