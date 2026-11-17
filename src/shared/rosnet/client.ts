import * as http from "http";
import * as https from "https";

/*
  Rosnet Employee Data Transfer (EDT) API v1.0 client: one OAuth2 client-credentials client for the company
  (scope wfm.write, token valid one hour, cached in memory until expiry minus 60 s; a 401 refreshes it once).

  Transport: plain node https with a descriptive User-Agent on EVERY request. Rosnet's Cloudflare zone challenges
  requests without one, and (sandbox, 2026-11-17) still challenges fetch / undici even with it, while a plain https
  request passes. A challenge (403 + cf-mitigated: challenge) is reported as such: it is not a credentials problem.
  Every request asks for application/json: GET /Location and POST /PayRate list text/plain first and answer 406 otherwise.

  What the sandbox showed (write test 2026-11-17):
    success   POST add / transfer / rehire = 200 with an empty body; every PUT = 204
    failure   400 whose body is a JSON STRING holding {"errorCode": n, "errorMessage": "..."} (double-encoded)
    timing    writes 3-6 s (one took 27 s); getEmployee reads the Aloha CFC database, 3-6 s; the EDT tables (PayRate,
              getMultipleEmployeeInfo) answer in 0.2 s. HR Bridge applies writes asynchronously.
  And the follow-up test the same day:
    no profile  GET getEmployee and getEmployeeByName = 200 with [] (never an error; one such lookup took 23 s);
                POST /PayRate for nobody = 204 with an empty body
    landing     a same-location rehire or a terminate shows in EDT's list after 10-14 s and in Aloha after 13-16 s;
                a rehired profile is active before its jobs are back
    accepted is not applied: a rehire "into a different location" whose target already held a terminated profile
                answered 200 and changed nothing (the first test got error 2000 for the same call). The connector
                never sends that combination: a terminated profile at the target is rehired in place.

  Errors and log lines carry the ROUTE TEMPLATE (label), never the real path: getEmployeeByName has names in the URL.
  RosnetError.message is the status, the label and Rosnet's own message (truncated, long digit runs masked).
  Only reads are retried (GET, POST /PayRate, POST getMultipleEmployeeInfoByClientCode); a write is never repeated blindly.
*/

export const DEFAULT_USER_AGENT = "QUICKWEN-UKG-EDT-Integration/1.0";
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const READ_ATTEMPTS = 3;                // 1 try + 2 retries (1 s, 2 s)
const MESSAGE_MAX = 200;
const TOKEN_SAFETY_MS = 60_000;
const DEFAULT_TOKEN_TTL_S = 3600;

/** Rosnet error codes seen in the sandbox. */
export const ROSNET_CODES = { alreadyActive: 2000, alreadyExists: 2500, termCodeInvalid: 2800, jobCodeInvalid: 3100, noLocationAccess: 3800 } as const;

export class RosnetError extends Error {
  constructor(public status: number, message: string, public code: number | null = null, public challenge = false) { super(message); }
}

export interface TransportRequest { method: string; url: string; headers: Record<string, string>; body?: string; timeoutMs: number; }
export interface TransportResponse { status: number; headers: Record<string, string>; text: string; }
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** Plain node http(s) request: the client type Rosnet's Cloudflare zone lets through (fetch is challenged). */
export const nodeTransport: Transport = req => new Promise((resolve, reject) => {
  const u = new URL(req.url);
  const lib = u.protocol === "http:" ? http : https;
  const headers: Record<string, string> = { ...req.headers };
  if (req.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(req.body));
  const r = lib.request({ method: req.method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers }, res => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("error", reject);
    res.on("end", () => {
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) flat[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
      resolve({ status: res.statusCode ?? 0, headers: flat, text: Buffer.concat(chunks).toString("utf8") });
    });
  });
  r.setTimeout(req.timeoutMs, () => r.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
  r.on("error", reject);
  if (req.body !== undefined) r.write(req.body);
  r.end();
});

/** Rosnet's error from a response body: {errorCode, errorMessage} (possibly a JSON string holding that JSON), ProblemDetails or text. */
export function problemOf(text: string): { code: number | null; message: string } {
  let msg = (text ?? "").trim(), code: number | null = null;
  try {
    let j: any = JSON.parse(msg);
    if (typeof j === "string") { try { j = JSON.parse(j); } catch { msg = j; j = null; } }
    if (j && typeof j === "object") {
      const c = Number(j.errorCode);
      if (Number.isInteger(c) && c > 0) code = c;
      const pick = j.errorMessage ?? j.detail ?? j.title ?? j.error_description ?? j.error ?? j.message ??
                   (j.errors && typeof j.errors === "object" ? Object.entries(j.errors).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(" ") : v}`).join("; ") : null);
      if (pick) msg = String(pick);
    }
  } catch { /* plain text */ }
  msg = msg.replace(/\s+/g, " ").replace(/\d{9,}/g, m => "*".repeat(m.length));
  return { code, message: msg.length > MESSAGE_MAX ? msg.slice(0, MESSAGE_MAX - 1) + "…" : msg };
}

/** True when a failed lookup means "no such employee". Rosnet answers 200 with an empty list for that, so only a 404
 *  counts: a 400 on a lookup is a real error and must never be read as "no profile" (that would lead to an add). */
export function isNotFound(e: unknown): boolean { return e instanceof RosnetError && e.status === 404; }

// ---------------------------------------------------------------- shapes ----------------------------------------------------------------
/** One employee at one location as Aloha CFC holds it (getEmployee / getEmployeeByName), reduced to what the connector
 *  needs. The full record carries ssn and birthDate: it is never kept, logged or returned. */
export interface CfcEmployee {
  uid: string;                    // employeeUniqueID = the POS provider UID the record was created with
  firstName: string | null; lastName: string | null;
  active: boolean;                // status.employmentStatus === "active"
  lastDay: string | null;         // yyyy-mm-dd, null while never terminated (Aloha's empty date is 1899-01-01)
  rehireDate: string | null;
  jobs: number[];                 // job codes on file (jobs[].payRate is always 0: rates come from POST /PayRate)
  payrollId: string | null;       // pos.alohaExportID
  posId: string | null;           // pos.posCode: the POS employee number, different at every location
}
/** One row of EDT's own employee table (getMultipleEmployeeInfo). */
export interface EdtEmployee { locationId: number; uid: string; payrollId: string | null; posId: string | null; firstName: string | null; lastName: string | null; terminated: boolean; status: string | null; }
export interface PayRateRow { jobCode: number; payRate: number; }

const day = (v: unknown): string | null => { const s = String(v ?? "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !s.startsWith("1899") ? s : null; };
const str = (v: unknown): string | null => { const s = String(v ?? "").trim(); return s ? s : null; };

export function toCfcEmployee(o: any): CfcEmployee | null {
  if (!o || typeof o !== "object") return null;
  const uid = str(o.employeeUniqueID);
  if (!uid) return null;
  return {
    uid, firstName: str(o.firstName), lastName: str(o.lastName),
    active: /^active$/i.test(String(o.status?.employmentStatus ?? "")),
    lastDay: day(o.status?.lastDay), rehireDate: day(o.status?.rehireDate),
    jobs: (Array.isArray(o.jobs) ? o.jobs : []).map((j: any) => Number(j?.jobCodeNumber)).filter((n: number) => Number.isInteger(n) && n > 0),
    payrollId: str(o.pos?.alohaExportID), posId: str(o.pos?.posCode)
  };
}
const toEdtEmployee = (o: any): EdtEmployee | null => {
  const uid = str(o?.posProviderEmployeeUID);
  return uid ? { locationId: Number(o.locationId), uid, payrollId: str(o.payrollProviderEmployeeUID), posId: str(o.posEmployeeUID), firstName: str(o.firstName),
                 lastName: str(o.lastName), terminated: o.terminatedFlag === true, status: str(o.status) } : null;
};
const list = (v: any): any[] => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []);

// ---------------------------------------------------------------- client ----------------------------------------------------------------
export interface RosnetCredential { tokenUrl: string; scope: string; clientId: string; clientSecret: string; }

export interface RosnetClientOptions {
  baseUrl: string | null;                 // https://wfmt-api.rosnet.com (production) or https://wfmt-api.rosnetqa.com (sandbox)
  apiVersion: string;                     // "1.0"
  credential: RosnetCredential | null;    // null = nothing can be called
  timeoutMs: number;
  userAgent?: string;
  /** False in Azure: the sandbox must never receive a write from the deployed app (it would carry real employee data). */
  allowSandboxWrites?: boolean;
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
}

export const isSandboxHost = (url: string | null | undefined): boolean => {
  try { const h = new URL(String(url)).hostname.toLowerCase(); return h === "rosnetqa.com" || h.endsWith(".rosnetqa.com"); } catch { return false; }
};

export class RosnetClient {
  private transport: Transport;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private log: (m: string) => void;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenRequests = 0;
  constructor(private opts: RosnetClientOptions) {
    this.transport = opts.transport ?? nodeTransport;
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
  }

  hasCredentials(): boolean { return !!this.opts.credential && !!this.opts.baseUrl; }
  get sandbox(): boolean { return isSandboxHost(this.opts.baseUrl); }
  get tokenRequestCount() { return this.tokenRequests; }
  private get userAgent() { return this.opts.userAgent || DEFAULT_USER_AGENT; }

  // ---- reference data ----
  async locations(): Promise<{ clientCode: string | null; locationNumbers: number[] }> {
    const r = list(await this.read("GET /Location", "GET", "/Location"))[0] ?? {};
    return { clientCode: str(r.clientCode), locationNumbers: list(r.locationNumbers).map(Number).filter(n => Number.isInteger(n)).sort((a, b) => a - b) };
  }
  async jobCodes(): Promise<{ jobCode: number; description: string }[]> {
    return list(await this.read("GET /JobCodes", "GET", "/JobCodes")).map(j => ({ jobCode: Number(j.jobCode), description: String(j.jobCodeDescription ?? "") }));
  }
  async termCodes(): Promise<{ terminationCode: number; description: string }[]> {
    return list(await this.read("GET /TermCodes", "GET", "/TermCodes")).map(t => ({ terminationCode: Number(t.terminationCode), description: String(t.terminationCodeDescription ?? "") }));
  }

  // ---- employee reads ----
  /** The employee at one location as Aloha CFC holds it, or null when there is no profile there. */
  async employee(uid: string, location: number): Promise<CfcEmployee | null> {
    try {
      const rows = list(await this.read("GET /Employee/getEmployee/{uid}/{location}", "GET", `/Employee/getEmployee/${encodeURIComponent(uid)}/${location}`));
      return rows.map(toCfcEmployee).find(e => e) ?? null;
    } catch (e) { if (isNotFound(e)) return null; throw e; }
  }
  /** Profiles at one location with this first and last name (zero, one or several). */
  async employeesByName(firstName: string, lastName: string, location: number): Promise<CfcEmployee[]> {
    try {
      const rows = list(await this.read("GET /Employee/getEmployeeByName/{first}/{last}/{location}", "GET",
        `/Employee/getEmployeeByName/${encodeURIComponent(firstName)}/${encodeURIComponent(lastName)}/${location}`));
      return rows.map(toCfcEmployee).filter((e): e is CfcEmployee => !!e);
    } catch (e) { if (isNotFound(e)) return []; throw e; }
  }
  /** EDT's own list for one location: only employees submitted through EDT. */
  async locationEmployees(location: number): Promise<EdtEmployee[]> {
    return list(await this.read("GET /Employee/getMultipleEmployeeInfo/{location}", "GET", `/Employee/getMultipleEmployeeInfo/${location}`))
      .map(toEdtEmployee).filter((e): e is EdtEmployee => !!e);
  }
  /** Current rate per job code from EDT's table. It keeps jobs that were removed: use it only for job codes Aloha lists. */
  async payRates(uid: string, location: number, clientCode: string): Promise<PayRateRow[]> {
    return list(await this.read("POST /PayRate", "POST", "/PayRate", { posProvider_EmployeeUID: uid, locationNumber: location, clientCode }))
      .map(r => ({ jobCode: Number(r.jobCode), payRate: Number(r.payRate) })).filter(r => Number.isInteger(r.jobCode));
  }

  // ---- writes (never retried) ----
  /** label = the route, e.g. "POST /Employee/addEmployee". Resolves on 200 / 204; throws RosnetError otherwise. */
  async write(method: "POST" | "PUT", route: string, body: unknown): Promise<void> {
    if (this.sandbox && this.opts.allowSandboxWrites === false)
      throw new RosnetError(0, `Rosnet: refusing ${method} ${route}: the configured host is the SANDBOX and this app sends real employee data`);
    await this.call(`${method} ${route}`, method, route, body, 1);
  }

  private read<T = any>(label: string, method: "GET" | "POST", route: string, body?: unknown): Promise<T> { return this.call<T>(label, method, route, body, READ_ATTEMPTS); }

  // ---------------------------------------------------------------- OAuth2 client credentials ----------------------------------------------------------------
  private async bearer(force: boolean): Promise<string> {
    const cred = this.opts.credential;
    if (!cred) throw new RosnetError(0, "Rosnet: no credentials configured");
    if (this.token && !force && this.token.expiresAt > this.now()) return this.token.value;
    this.token = null;
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: cred.clientId, client_secret: cred.clientSecret, scope: cred.scope });
    this.tokenRequests++;
    let res: TransportResponse;
    try {
      res = await this.transport({ method: "POST", url: cred.tokenUrl, timeoutMs: this.opts.timeoutMs, body: form.toString(),
                                   headers: { "User-Agent": this.userAgent, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" } });
    } catch (e: any) { throw new RosnetError(0, `Rosnet token request failed: ${e?.name ?? "error"}`); }
    if (isChallenge(res)) throw new RosnetError(res.status, challengeText("token request", res), null, true);
    if (res.status < 200 || res.status >= 300) throw new RosnetError(res.status, `Rosnet token request ${res.status}${res.text ? `: ${problemOf(res.text).message}` : ""}`);
    let body: any = null;
    try { body = JSON.parse(res.text); } catch { /* handled below */ }
    const token = body?.access_token;
    if (!token || typeof token !== "string") throw new RosnetError(res.status, "Rosnet token response has no access_token");
    const ttl = Number(body?.expires_in) > 0 ? Number(body.expires_in) : DEFAULT_TOKEN_TTL_S;
    this.token = { value: token, expiresAt: this.now() + ttl * 1000 - TOKEN_SAFETY_MS };
    return token;
  }

  // ---------------------------------------------------------------- calls ----------------------------------------------------------------
  private async call<T>(label: string, method: string, route: string, body: unknown, attempts: number): Promise<T> {
    if (!this.opts.baseUrl) throw new RosnetError(0, "Rosnet: ROSNET_BASE_URL is not set");
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/api/v${this.opts.apiVersion}${route}`;
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = { "User-Agent": this.userAgent, Accept: "application/json", Authorization: `Bearer ${await this.bearer(false)}` };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      let res: TransportResponse;
      try {
        res = await this.transport({ method, url, headers, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: this.opts.timeoutMs });
      } catch (e: any) {
        if (attempt < attempts) { await this.sleep(1000 * attempt); continue; }
        throw new RosnetError(0, `Rosnet request failed on ${label}: ${e?.name ?? "error"}`);
      }
      if (isChallenge(res)) throw new RosnetError(res.status, challengeText(label, res), null, true);
      if (res.status === 401 && !refreshed) { refreshed = true; await this.bearer(true); attempt--; continue; }     // expired or revoked token: one refresh
      if (RETRYABLE.has(res.status) && attempt < attempts) { await this.sleep(1000 * attempt); continue; }
      if (res.status < 200 || res.status >= 300) {
        const p = problemOf(res.text);
        throw new RosnetError(res.status, `Rosnet ${res.status} on ${label}${p.message ? `: ${p.message}` : ""}`, p.code);
      }
      if (!res.text) return null as T;
      try { return JSON.parse(res.text) as T; } catch { return res.text as unknown as T; }
    }
  }
}

const isChallenge = (res: TransportResponse) => res.status === 403 && (/challenge/i.test(res.headers["cf-mitigated"] ?? "") || /just a moment|cf-chl|challenge-platform/i.test(res.text.slice(0, 2000)));
const challengeText = (label: string, res: TransportResponse) =>
  `Rosnet ${label} was blocked by Cloudflare before reaching Rosnet (bot challenge; not a credentials problem)${res.headers["cf-ray"] ? `, cf-ray ${res.headers["cf-ray"]}` : ""}`;
