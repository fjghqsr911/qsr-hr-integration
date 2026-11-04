import { DefaultAzureCredential } from "@azure/identity";
import { config } from "./config";

/*
  Microsoft Graph client for the Entra sync, authenticated as this Function App (managed identity, application
  permissions granted by deploy/01-entra-graph-permissions.sh). No Graph SDK: Node 22 global fetch.

  - token: DefaultAzureCredential for https://graph.microsoft.com/.default, cached until expiry minus 60 s
  - every call: 20 s timeout, retries on 429 / 503 / 504 honouring Retry-After (at most 3 retries), @odata.nextLink paging
  - errors (GraphError) carry the HTTP status and the Graph error.code only: never the body, never the token, never a query string
  - reads: users per account domain (ConsistencyLevel eventual + $count for the endsWith filter), groups, members of a group
  - writes: PATCH a user, add / remove a group member (already there / already gone are no-ops)
*/

export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
export const USER_SELECT = "id,userPrincipalName,mail,displayName,jobTitle,department,officeLocation,accountEnabled,employeeId,userType,onPremisesSyncEnabled";
export const GROUP_SELECT = "id,displayName,description,groupTypes,securityEnabled,mailEnabled,isAssignableToRole";
export const USER_APPLY_SELECT = "id,jobTitle,department,officeLocation,accountEnabled";
const RETRYABLE = new Set([429, 503, 504]);
const MAX_RETRIES = 3;
const TOKEN_SAFETY_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 999;

export class GraphError extends Error {
  /** True when a 400 said the object reference already exists (adding a member that is already there). The message itself is not kept. */
  alreadyExists = false;
  constructor(public status: number, public code: string | null, message: string) { super(message); }
}

export interface GraphUser {
  id: string; userPrincipalName: string | null; mail: string | null; displayName: string | null;
  jobTitle: string | null; department: string | null; officeLocation: string | null; accountEnabled: boolean;
  employeeId: string | null; userType: string | null; onPremisesSyncEnabled: boolean;
}

export interface GraphGroup {
  id: string; displayName: string | null; description: string | null; groupTypes: string[];
  securityEnabled: boolean; mailEnabled: boolean; isAssignableToRole: boolean;
}

export interface GraphClientOptions {
  baseUrl: string;
  getToken?: () => Promise<string>;         // default: DefaultAzureCredential (cached here)
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  log?: (m: string) => void;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/* One credential and one cached token for the whole process (every client built without its own getToken shares it). */
let sharedCredential: DefaultAzureCredential | null = null;
let sharedToken: { token: string; expiresAt: number } | null = null;
export const _resetTokenCache = () => { sharedToken = null; };     // tests only

const nz = (v: any): string | null => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());

/** Path for error messages: relative to the Graph base, no query string (filters, select lists), no host. */
const safePath = (url: string, base: string) => {
  const u = url.startsWith(base) ? url.slice(base.length) : url.replace(/^https?:\/\/[^/]+/, "");
  const q = u.indexOf("?");
  return (q >= 0 ? u.slice(0, q) : u).slice(0, 120);
};

/** Seconds to wait from a Retry-After header (seconds or HTTP date); null when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const s = Number(header);
  if (Number.isFinite(s)) return Math.max(0, s) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export function mapGraphUser(u: any): GraphUser {
  return {
    id: String(u.id).toLowerCase(), userPrincipalName: nz(u.userPrincipalName), mail: nz(u.mail), displayName: nz(u.displayName),
    jobTitle: nz(u.jobTitle), department: nz(u.department), officeLocation: nz(u.officeLocation), accountEnabled: u.accountEnabled !== false,
    employeeId: nz(u.employeeId), userType: nz(u.userType), onPremisesSyncEnabled: u.onPremisesSyncEnabled === true
  };
}

export function mapGraphGroup(g: any): GraphGroup {
  return {
    id: String(g.id).toLowerCase(), displayName: nz(g.displayName), description: nz(g.description),
    groupTypes: Array.isArray(g.groupTypes) ? g.groupTypes.map(String) : [], securityEnabled: g.securityEnabled === true,
    mailEnabled: g.mailEnabled === true, isAssignableToRole: g.isAssignableToRole === true
  };
}

export class GraphClient {
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private timeoutMs: number;
  private log: (m: string) => void;
  private getTokenImpl: () => Promise<string>;
  private calls = 0;

  constructor(private opts: GraphClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = opts.log ?? (() => {});
    this.getTokenImpl = opts.getToken ?? (() => this.managedIdentityToken());
  }

  get callCount() { return this.calls; }

  private async managedIdentityToken(): Promise<string> {
    if (sharedToken && this.now() < sharedToken.expiresAt) return sharedToken.token;
    sharedCredential ??= new DefaultAzureCredential();
    const t = await sharedCredential.getToken(GRAPH_SCOPE);
    if (!t?.token) throw new GraphError(0, "token_unavailable", "Graph token unavailable");
    sharedToken = { token: t.token, expiresAt: (t.expiresOnTimestamp ?? this.now() + 3600_000) - TOKEN_SAFETY_MS };
    return t.token;
  }

  /** The bearer token (cached). Never log the result. */
  token(): Promise<string> { return this.getTokenImpl(); }

  private url(path: string): string { return /^https?:\/\//.test(path) ? path : `${this.opts.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`; }

  /** One Graph call with timeout and retries. Returns the parsed JSON body (or null for 204) and the status. */
  async call<T = any>(method: Method, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T | null }> {
    const url = this.url(path);
    let token: string;
    try { token = await this.token(); }
    catch (e: any) { throw e instanceof GraphError ? e : new GraphError(0, "token_unavailable", `Graph token unavailable: ${String(e?.name ?? "error").slice(0, 60)}`); }
    for (let attempt = 0; ; attempt++) {
      this.calls++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method, signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined
        });
      } catch (e: any) {
        clearTimeout(timer);
        const timeout = e?.name === "AbortError";
        if (!timeout && attempt < MAX_RETRIES) { await this.sleep(1000 * (attempt + 1)); continue; }
        throw new GraphError(0, timeout ? "timeout" : "network", `Graph ${timeout ? "timeout" : "network error"} on ${method} ${safePath(url, this.opts.baseUrl)}`);
      }
      if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
        clearTimeout(timer);
        await res.body?.cancel().catch(() => {});                              // release the socket before waiting
        const wait = retryAfterMs(res.headers.get("retry-after"), this.now()) ?? 1000 * (attempt + 1);
        this.log(`[graph] ${res.status} on ${method} ${safePath(url, this.opts.baseUrl)}: retry in ${Math.round(wait / 1000)} s`);
        await this.sleep(wait);
        continue;
      }
      let text = "";
      try { text = res.status === 204 ? "" : await res.text(); }              // the timeout covers the body read too
      catch (e: any) { clearTimeout(timer); throw new GraphError(0, e?.name === "AbortError" ? "timeout" : "network", `Graph ${e?.name === "AbortError" ? "timeout" : "network error"} on ${method} ${safePath(url, this.opts.baseUrl)}`); }
      clearTimeout(timer);
      let body: any = null;
      if (text) { try { body = JSON.parse(text); } catch { body = null; } }
      if (!res.ok) {
        const code = nz(body?.error?.code);
        const err = new GraphError(res.status, code, `Graph ${res.status} on ${method} ${safePath(url, this.opts.baseUrl)}${code ? `: ${code}` : ""}`);
        err.alreadyExists = res.status === 400 && /already exist/i.test(String(body?.error?.message ?? ""));
        throw err;
      }
      return { status: res.status, body };
    }
  }

  /** GET following @odata.nextLink until the collection ends. */
  async getAll<T = any>(path: string, headers?: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path;
    let pages = 0;
    while (next) {
      const { body } = await this.call<any>("GET", next, { headers });
      for (const v of body?.value ?? []) out.push(v as T);
      next = nz(body?.["@odata.nextLink"]);
      if (++pages > 1000) throw new GraphError(0, "paging", `Graph paging did not end on GET ${safePath(path, this.opts.baseUrl)}`);
    }
    return out;
  }

  /** Members (and guests, dropped here) whose UPN or mail ends with @domain. */
  async listUsers(domain: string): Promise<GraphUser[]> {
    const d = domain.toLowerCase().replace(/^@/, "").replace(/'/g, "");
    const filter = `endsWith(userPrincipalName,'@${d}') or endsWith(mail,'@${d}')`;
    const path = `/users?$filter=${encodeURIComponent(filter)}&$count=true&$select=${USER_SELECT}&$top=${PAGE_SIZE}`;
    const rows = await this.getAll<any>(path, { ConsistencyLevel: "eventual" });
    return rows.map(mapGraphUser).filter(u => (u.userType ?? "Member").toLowerCase() !== "guest");
  }

  async listGroups(): Promise<GraphGroup[]> {
    const rows = await this.getAll<any>(`/groups?$select=${GROUP_SELECT}&$top=${PAGE_SIZE}`);
    return rows.map(mapGraphGroup);
  }

  /** Object ids of the users that are direct members of a group (other member types ignored). */
  async listGroupMemberUserIds(groupId: string): Promise<string[]> {
    const rows = await this.getAll<any>(`/groups/${encodeURIComponent(groupId)}/members/microsoft.graph.user?$select=id&$top=${PAGE_SIZE}`, { ConsistencyLevel: "eventual" });
    return rows.map(r => String(r.id).toLowerCase());
  }

  /** One user with the given $select; null when Graph answers 404. */
  async getUser(id: string, select: string = USER_SELECT): Promise<GraphUser | null> {
    try {
      const { body } = await this.call<any>("GET", `/users/${encodeURIComponent(id)}?$select=${select}`);
      return body ? mapGraphUser(body) : null;
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) return null;
      throw e;
    }
  }

  async patchUser(id: string, body: Record<string, unknown>): Promise<void> {
    await this.call("PATCH", `/users/${encodeURIComponent(id)}`, { body });
  }

  /** Adds a user to a group. Returns "exists" when Graph says the member is already there (400 with that code). */
  async addGroupMember(groupId: string, userId: string): Promise<"added" | "exists"> {
    try {
      await this.call("POST", `/groups/${encodeURIComponent(groupId)}/members/$ref`, { body: { "@odata.id": `${this.directoryObjectBase()}/directoryObjects/${userId}` } });
      return "added";
    } catch (e) {
      if (e instanceof GraphError && e.alreadyExists) return "exists";
      throw e;
    }
  }

  /** Removes a user from a group. Returns "missing" when Graph answers 404 (not a member, or no such user). */
  async removeGroupMember(groupId: string, userId: string): Promise<"removed" | "missing"> {
    try {
      await this.call("DELETE", `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/$ref`);
      return "removed";
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) return "missing";
      throw e;
    }
  }

  /** Diagnostics: a token and one GET /users?$top=1 (covered by User.Read.All, unlike /organization). Returns elapsed ms. */
  async probeDirectory(): Promise<number> {
    const started = this.now();
    await this.call("GET", "/users?$select=id&$top=1");
    return this.now() - started;
  }

  private directoryObjectBase(): string { return this.opts.baseUrl.replace(/\/+$/, ""); }
}

/** The client every Entra code path uses: Graph base from settings, managed identity token. */
export function buildGraphClient(opts: { log?: (m: string) => void } = {}): GraphClient {
  return new GraphClient({ baseUrl: config.entraGraphBase, log: opts.log });
}
