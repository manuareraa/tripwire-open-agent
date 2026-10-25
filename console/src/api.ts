// JSON calls to the Hono server. Errors carry the server's own message.

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.detail || body.error || r.statusText), { body });
  return body;
}

export const smooth = (): ScrollBehavior => window.TW.reduced() ? "auto" : "smooth";
