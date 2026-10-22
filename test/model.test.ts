import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODELS,
  extractJson,
  NemotronClient,
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
