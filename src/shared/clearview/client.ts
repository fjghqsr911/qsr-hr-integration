/*
  Clearview Connect API v2 client, one credential per Clearview organization = per UKG company.

  Two authentication modes (CLEARVIEW_AUTH_MODE):
    oauth (default)  self-service API connections: OAuth2 client-credentials per organization (client id + secret from the
                     Clearview Connections page, secrets expire after 24 months). The bearer token is cached in memory until
                     expiry minus 60 s; a 401 on an API call refreshes it once, then fails.
    key              the partner model (Flexspring): authorizationKey query parameter on every call.

  Billing: every Clearview API connection is billed per active store from its FIRST call, so callers gate every use behind
  CLEARVIEW_ENABLED; this client logs one line at the first successful call of each organization in the process.
  Errors never carry the key, the secret, the token, the query string or request / response values: ClearviewError.message is
  the status, method, path and Clearview's own message (truncated, digit runs masked).
*/

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const GET_ATTEMPTS = 3;                 // GET only: 1 try + 2 retries (1 s, 2 s); writes are never retried blindly
const MESSAGE_MAX = 200;
const TOKEN_SAFETY_MS = 60_000;         // refresh this long before the token expires
const DEFAULT_TOKEN_TTL_S = 3600;

export class ClearviewError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type ClearviewCredential =
  | { mode: "key"; key: string }
  | { mode: "oauth"; tokenUrl: string; scope: string | null; clientId: string; clientSecret: string };

export interface ClearviewClientOptions {
  baseUrl: string;
  credentials: Map<string, ClearviewCredential>;  // company id -> credential
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH";

/** Organizations that have made their first (billable) call in this process. Module level: once per process, not per client. */
const firstCallLogged = new Set<string>();
export const _resetFirstCallLog = () => firstCallLogged.clear();     // tests only

/** Clearview's own message from an error body, safe for logs: short, no 9+ digit runs (SIN-like), no newlines. */
export function safeMessage(text: string): string {
  let msg = text.trim();
  try {
    const j = JSON.parse(msg);
    const pick = j?.message ?? j?.title ?? j?.error_description ?? j?.error ?? j?.detail ?? (Array.isArray(j?.errors) ? j.errors.map((e: any) => e?.message ?? e).join("; ") :
                 (j?.errors && typeof j.errors === "object" ? Object.entries(j.errors).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(" ") : v}`).join("; ") : null));
    if (pick) msg = String(pick);
  } catch { /* plain text */ }
  msg = msg.replace(/\s+/g, " ").replace(/\d{9,}/g, m => "*".repeat(m.length));
  return msg.length > MESSAGE_MAX ? msg.slice(0, MESSAGE_MAX - 1) + "…" : msg;
}

export class ClearviewClient {
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private log: (m: string) => void;
  private tokens = new Map<string, { token: string; expiresAt: number }>();
  private tokenRequests = 0;                     // for diagnostics / tests
  constructor(private opts: ClearviewClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
  }

  hasKey(company: string | null | undefined): boolean { return !!company && this.opts.credentials.has(company.toUpperCase()); }
  companies(): string[] { return [...this.opts.credentials.keys()]; }
  get tokenRequestCount() { return this.tokenRequests; }

  get<T = any>(company: string, path: string, query?: Record<string, string | number | boolean>): Promise<T> { return this.call<T>(company, "GET", path, undefined, query); }
  post<T = any>(company: string, path: string, body: unknown): Promise<T> { return this.call<T>(company, "POST", path, body); }
  put<T = any>(company: string, path: string, body: unknown): Promise<T> { return this.call<T>(company, "PUT", path, body); }
  patch<T = any>(company: string, path: string, body: unknown): Promise<T> { return this.call<T>(company, "PATCH", path, body); }

  /** GET that returns null on 404 instead of throwing (lookups). */
  async getOrNull<T = any>(company: string, path: string, query?: Record<string, string | number | boolean>): Promise<T | null> {
    try { return await this.get<T>(company, path, query); }
    catch (e) { if (e instanceof ClearviewError && e.status === 404) return null; throw e; }
  }

  // ---------------------------------------------------------------- OAuth2 client credentials ----------------------------------------------------------------
  private async token(company: string, cred: Extract<ClearviewCredential, { mode: "oauth" }>, force: boolean): Promise<string> {
    const cached = this.tokens.get(company);
    if (cached && !force && cached.expiresAt > this.now()) return cached.token;
    this.tokens.delete(company);
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: cred.clientId, client_secret: cred.clientSecret });
    if (cred.scope) form.set("scope", cred.scope);
    this.tokenRequests++;
    let res: Response;
    try {
      res = await this.fetchImpl(cred.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
                                                  body: form.toString(), signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (e: any) {
      throw new ClearviewError(0, `Clearview token request failed for ${company}: ${e?.name ?? "error"}`);
    }
    const text = await res.text();
    if (!res.ok) throw new ClearviewError(res.status, `Clearview token request ${res.status} for ${company}${text ? `: ${safeMessage(text)}` : ""}`);
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* handled below */ }
    const token = body?.access_token;
    if (!token || typeof token !== "string") throw new ClearviewError(res.status, `Clearview token response for ${company} has no access_token`);
    const ttl = Number(body?.expires_in) > 0 ? Number(body.expires_in) : DEFAULT_TOKEN_TTL_S;
    this.tokens.set(company, { token, expiresAt: this.now() + ttl * 1000 - TOKEN_SAFETY_MS });
    return token;
  }

  // ---------------------------------------------------------------- calls ----------------------------------------------------------------
  private async call<T>(companyRaw: string, method: Method, path: string, body?: unknown, query?: Record<string, string | number | boolean>): Promise<T> {
    const company = companyRaw.toUpperCase();
    const cred = this.opts.credentials.get(company);
    if (!cred) throw new ClearviewError(0, `Clearview: no credentials for company ${company}`);
    const q = new URLSearchParams(Object.fromEntries(Object.entries(query ?? {}).map(([k, v]) => [k, String(v)])));
    if (cred.mode === "key") q.set("authorizationKey", cred.key);
    const base = this.opts.baseUrl.replace(/\/+$/, "");
    const qs = q.toString();
    const url = `${base}/api/v2${path}${qs ? `?${qs}` : ""}`;
    const attempts = method === "GET" ? GET_ATTEMPTS : 1;
    const label = `${method} ${path}`;
    let refreshed = false;

    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (cred.mode === "oauth") headers.Authorization = `Bearer ${await this.token(company, cred, false)}`;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.opts.timeoutMs) });
      } catch (e: any) {
        if (attempt < attempts) { await this.sleep(1000 * attempt); continue; }
        throw new ClearviewError(0, `Clearview request failed on ${label}: ${e?.name ?? "error"}`);
      }
      if (res.status === 401 && cred.mode === "oauth" && !refreshed) {          // expired or revoked token: one refresh, then fail
        refreshed = true;
        await res.text().catch(() => "");
        await this.token(company, cred, true);
        attempt--;
        continue;
      }
      if (RETRYABLE.has(res.status) && attempt < attempts) { await this.sleep(1000 * attempt); continue; }
      const text = await res.text();
      if (!res.ok) throw new ClearviewError(res.status, `Clearview ${res.status} on ${label}${text ? `: ${safeMessage(text)}` : ""}`);
      if (!firstCallLogged.has(company)) { firstCallLogged.add(company); this.log(`[clearview] first call this process org=${company}`); }
      if (!text) return null as T;
      try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
    }
  }
}
