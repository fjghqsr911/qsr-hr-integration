/*
  Clearview Connect API v2 client. One authorizationKey per Clearview organization = per UKG company
  (CLEARVIEW_AUTH_KEY_<COMPANY>), passed as a query parameter on every call.
  Errors never carry the key, the query string or request / response values: ClearviewError.message is the status,
  method, path and Clearview's own message (truncated, digit runs masked).
*/

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const GET_ATTEMPTS = 3;                 // GET only: 1 try + 2 retries (1 s, 2 s); writes are never retried blindly
const MESSAGE_MAX = 200;

export class ClearviewError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface ClearviewClientOptions {
  baseUrl: string;
  keys: Map<string, string>;                      // company id -> authorizationKey
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH";

/** Clearview's own message from an error body, safe for logs: short, no 9+ digit runs (SIN-like), no newlines. */
export function safeMessage(text: string): string {
  let msg = text.trim();
  try {
    const j = JSON.parse(msg);
    const pick = j?.message ?? j?.title ?? j?.error ?? j?.detail ?? (Array.isArray(j?.errors) ? j.errors.map((e: any) => e?.message ?? e).join("; ") :
                 (j?.errors && typeof j.errors === "object" ? Object.entries(j.errors).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(" ") : v}`).join("; ") : null));
    if (pick) msg = String(pick);
  } catch { /* plain text */ }
  msg = msg.replace(/\s+/g, " ").replace(/\d{9,}/g, m => "*".repeat(m.length));
  return msg.length > MESSAGE_MAX ? msg.slice(0, MESSAGE_MAX - 1) + "…" : msg;
}

export class ClearviewClient {
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  constructor(private opts: ClearviewClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  }

  hasKey(company: string | null | undefined): boolean { return !!company && this.opts.keys.has(company.toUpperCase()); }
  companies(): string[] { return [...this.opts.keys.keys()]; }

  get<T = any>(company: string, path: string, query?: Record<string, string | number | boolean>): Promise<T> { return this.call<T>(company, "GET", path, undefined, query); }
  post<T = any>(company: string, path: string, body: unknown): Promise<T> { return this.call<T>(company, "POST", path, body); }
  put<T = any>(company: string, path: string, body: unknown): Promise<T> { return this.call<T>(company, "PUT", path, body); }
  patch<T = any>(company: string, path: string, body: unknown): Promise<T> { return this.call<T>(company, "PATCH", path, body); }

  /** GET that returns null on 404 instead of throwing (lookups). */
  async getOrNull<T = any>(company: string, path: string, query?: Record<string, string | number | boolean>): Promise<T | null> {
    try { return await this.get<T>(company, path, query); }
    catch (e) { if (e instanceof ClearviewError && e.status === 404) return null; throw e; }
  }

  private async call<T>(company: string, method: Method, path: string, body?: unknown, query?: Record<string, string | number | boolean>): Promise<T> {
    const key = this.opts.keys.get(company.toUpperCase());
    if (!key) throw new ClearviewError(0, `Clearview: no authorizationKey for company ${company}`);
    const q = new URLSearchParams({ ...(Object.fromEntries(Object.entries(query ?? {}).map(([k, v]) => [k, String(v)]))), authorizationKey: key });
    const base = this.opts.baseUrl.replace(/\/+$/, "");
    const url = `${base}/api/v2${path}?${q.toString()}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const attempts = method === "GET" ? GET_ATTEMPTS : 1;
    const label = `${method} ${path}`;

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.opts.timeoutMs) });
      } catch (e: any) {
        if (attempt < attempts) { await this.sleep(1000 * attempt); continue; }
        throw new ClearviewError(0, `Clearview request failed on ${label}: ${e?.name ?? "error"}`);
      }
      if (RETRYABLE.has(res.status) && attempt < attempts) { await this.sleep(1000 * attempt); continue; }
      const text = await res.text();
      if (!res.ok) throw new ClearviewError(res.status, `Clearview ${res.status} on ${label}${text ? `: ${safeMessage(text)}` : ""}`);
      if (!text) return null as T;
      try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
    }
  }
}
