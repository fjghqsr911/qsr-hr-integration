import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authorize, Caller, describeCaller, Roles, Scopes } from "../shared/auth";
import { config, KEY_VAULT_PREFIX } from "../shared/config";
import { getSharedHubPool, resetSharedHubPool, sql } from "../shared/sql";
import { ukgGet, UkgError } from "../shared/ukg";
import { probeAudit } from "../shared/audit";
import { buildClearviewClient, clearviewCredentials } from "../shared/connectors";
import { STATS_SQL } from "../shared/deliveryStore";
import { buildGraphClient } from "../shared/graph";
import { torontoToday } from "../shared/entra/compare";

// GET /api/hub/diagnostics - component health for the monitor's Diagnostics tab.
//
// Read-only: no audit record, no SQL writes. ALWAYS answers 200; every problem is a component status in the body,
// so the monitor can show "which link in the chain is broken" instead of a bare 503.
// Scope Employees.Summary.Write + role Summary.Read (Admin implies Read). Setting / grant NAMES are listed for
// Summary.Admin callers only; setting VALUES are never returned.

const NO_STORE = { "Cache-Control": "no-store", "Pragma": "no-cache" };

export type ComponentStatus = "pass" | "warn" | "fail";
export interface Component { status: ComponentStatus; ms?: number; detail?: string; [extra: string]: unknown; }

export const REQUIRED_SETTINGS = [
  "UKG_BASE_URL", "UKG_USERNAME", "UKG_PASSWORD", "UKG_CUSTOMER_API_KEY",
  "HUB_SQL_SERVER", "HUB_SQL_DATABASE", "AUDIT_STORAGE_ACCOUNT"
] as const;

/** The grants the admin endpoints, the sync and the Clearview connector need (provisioning/15 and 16). Column -> object + permission. */
export const GRANTS: ReadonlyArray<{ column: string; object: string; permission: string }> = [
  { column: "storeModesInsert", object: "ref.store_modes", permission: "INSERT" },
  { column: "storeModesUpdate", object: "ref.store_modes", permission: "UPDATE" },
  { column: "deliveriesUpdate", object: "[out].[deliveries]", permission: "UPDATE" },
  { column: "syncRunsInsert", object: "stage.sync_runs", permission: "INSERT" },
  { column: "lastSentInsert", object: "[out].[last_sent]", permission: "INSERT" },
  { column: "lastSentUpdate", object: "[out].[last_sent]", permission: "UPDATE" },
  { column: "shadowPayloadsInsert", object: "[out].[shadow_payloads]", permission: "INSERT" },
  { column: "shadowPayloadsDelete", object: "[out].[shadow_payloads]", permission: "DELETE" },
  { column: "xrefInsert", object: "xref.employees", permission: "INSERT" },
  { column: "xrefUpdate", object: "xref.employees", permission: "UPDATE" },
  { column: "destinationCodesInsert", object: "ref.destination_codes", permission: "INSERT" },
  { column: "workforceEventsSelect", object: "rpt.workforce_events", permission: "SELECT" },
  { column: "employmentCurrentSelect", object: "stage.employment_current", permission: "SELECT" },
  // Entra sync (provisioning/18, 19, 20)
  { column: "entraUsersInsert", object: "entra.users", permission: "INSERT" },
  { column: "entraProposalsUpdate", object: "entra.proposals", permission: "UPDATE" },
  { column: "entraLinksDelete", object: "entra.links", permission: "DELETE" },
  { column: "entraSyncRunsInsert", object: "entra.sync_runs", permission: "INSERT" },
  { column: "storesSelect", object: "ref.stores", permission: "SELECT" },
  { column: "directorySelect", object: "rpt.v_directory", permission: "SELECT" }
];
export const GRANTS_SQL = `SELECT ${GRANTS.map(g => `HAS_PERMS_BY_NAME('${g.object}','OBJECT','${g.permission}') AS ${g.column}`).join(", ")};`;
export const CODES_COUNT_SQL = `SELECT code_type, COUNT(*) AS n FROM ref.destination_codes WHERE destination = @destination GROUP BY code_type;`;

/** Entra counts (one row) and the latest sync run. Read-only. */
export const ENTRA_COUNTS_SQL = `
SELECT
  (SELECT COUNT(*) FROM entra.users WHERE missing_since_utc IS NULL) AS users,
  (SELECT COUNT(*) FROM entra.links) AS linked,
  (SELECT COUNT(*) FROM rpt.v_directory d WHERE d.work_email IS NOT NULL AND d.employee_status IN ('A', 'L')
     AND NOT EXISTS (SELECT 1 FROM entra.links l WHERE l.employee_id = d.employee_id)) AS unlinked_with_email,
  (SELECT COUNT(*) FROM entra.users u WHERE u.missing_since_utc IS NULL AND NOT EXISTS (SELECT 1 FROM entra.links l WHERE l.user_object_id = u.object_id)) AS orphans,
  (SELECT COUNT(*) FROM entra.proposals WHERE status = 'proposed') AS proposed,
  (SELECT COUNT(*) FROM entra.proposals WHERE status = 'accepted' AND (due_date IS NULL OR due_date <= @today)) AS due,
  (SELECT COUNT(*) FROM entra.proposals WHERE status = 'failed') AS failed,
  (SELECT COUNT(*) FROM entra.proposals WHERE status = 'blocked') AS blocked;`;
export const ENTRA_LAST_RUN_SQL = `SELECT TOP 1 run_id, started_utc, finished_utc, status, trigger_kind, error_summary FROM entra.sync_runs ORDER BY started_utc DESC;`;
export const ENTRA_RUN_WARN_HOURS = 26;

const errText = (e: any) => String(e?.message ?? "error").slice(0, 200);
const timed = async <T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> => {
  const started = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - started };
};

// ---------------------------------------------------------------- components ----------------------------------------------------------------
function checkSettings(admin: boolean): Component {
  const missing: string[] = [], unresolved: string[] = [];
  for (const name of REQUIRED_SETTINGS) {
    const v = process.env[name];                                   // by name: the config getters throw when a value is missing
    if (!v || !v.trim()) missing.push(name);
    else if (v.trim().startsWith(KEY_VAULT_PREFIX)) unresolved.push(name);
  }
  const ok = missing.length === 0 && unresolved.length === 0;
  const detail = ok ? undefined :
    [missing.length ? `${missing.length} missing` : "", unresolved.length ? `${unresolved.length} unresolved Key Vault reference(s)` : ""]
      .filter(Boolean).join(", ");
  return { status: ok ? "pass" : "fail", ...(detail ? { detail } : {}), ...(admin ? { missing, unresolved } : {}) };
}

async function checkSql(): Promise<Component> {
  try {
    const { ms } = await timed(async () => { const pool = await getSharedHubPool(); await pool.request().query("SELECT 1 AS ok;"); });
    return { status: "pass", ms };
  } catch (e: any) {
    resetSharedHubPool();
    return { status: "fail", detail: errText(e) };
  }
}

async function checkGrants(admin: boolean): Promise<Component> {
  try {
    const { result, ms } = await timed(async () => { const pool = await getSharedHubPool(); return pool.request().query(GRANTS_SQL); });
    const row: any = (result as any)?.recordset?.[0] ?? {};
    const missing = GRANTS.filter(g => Number(row[g.column]) !== 1).map(g => `${g.permission} on ${g.object}`);
    if (missing.length === 0) return { status: "pass", ms };
    return { status: "fail", ms, detail: `${missing.length} of ${GRANTS.length} grant(s) missing`, ...(admin ? { missing } : {}) };
  } catch (e: any) {
    resetSharedHubPool();
    return { status: "fail", detail: errText(e) };
  }
}

async function checkAudit(): Promise<Component> {
  try { return { status: "pass", ms: await probeAudit() }; }
  catch (e: any) { return { status: "fail", detail: errText(e) }; }
}

async function checkUkg(): Promise<Component> {
  try {
    const { ms } = await timed(() => ukgGet("/personnel/v1/employee-employment-details?per_Page=1"));   // same one record as /api/health
    return { status: "pass", ms };
  } catch (e: any) {
    const status = e instanceof UkgError ? e.status : 0;
    const hint =                                                                                   // same hints as health.ts
      status === 401 ? "UKG rejected the credentials - check Key Vault values" :
      status === 403 ? "Login worked but the account lacks Employment Details permission" :
      e?.message?.startsWith("Missing required setting") ? e.message :
      "UKG unreachable or error";
    return { status: "fail", detail: hint, httpStatus: status || "unreachable" };
  }
}

function checkSync(): Component {
  const enabled = config.hubSyncEnabled;
  return { status: enabled ? "pass" : "warn", enabled, ...(enabled ? {} : { detail: "HUB_SYNC_ENABLED is not \"true\": the scheduled sync is off" }) };
}

function checkCaller(caller: Caller): Component {
  const allowed = config.allowedClientIds;
  const clientAllowed = allowed.length === 0 || allowed.includes(caller.clientAppId);
  return { status: clientAllowed ? "pass" : "fail", kind: caller.kind, clientAppId: caller.clientAppId, clientAllowed };
}

export const SECRET_WARN_DAYS = 60;

/** The Clearview destination: settings, credentials per company, a timed GET /organization/stores (skipped without
 *  credentials, and skipped while CLEARVIEW_ENABLED is off because the first call starts billing), secret expiry,
 *  queue counts and the mapping table counts. Never calls Clearview with a write. */
export async function checkClearview(now: Date = new Date()): Promise<Component & { name: "clearview" }> {
  const enabled = config.clearviewEnabled, live = config.clearviewLiveEnabled;
  const creds = clearviewCredentials();
  const notes: string[] = [];
  let secretWarn = false;

  // OAuth secrets expire after 24 months: warn 60 days ahead (dates are set by hand from the Clearview page)
  const expiries = Object.entries(creds.secretExpires).filter(([, v]) => v).map(([c, v]) => ({ company: c, at: new Date(v!) })).sort((a, b) => a.at.getTime() - b.at.getTime());
  const secretExpiresUtc = expiries.length ? expiries[0].at.toISOString() : null;
  for (const e of expiries) {
    const days = Math.floor((e.at.getTime() - now.getTime()) / 86_400_000);
    if (days < 0) { notes.push(`OAuth secret for ${e.company} expired ${-days} day(s) ago: create a new secret in Clearview Connections`); secretWarn = true; }
    else if (days <= SECRET_WARN_DAYS) { notes.push(`OAuth secret for ${e.company} expires in ${days} day(s): create a new secret in Clearview Connections`); secretWarn = true; }
  }

  let api: Component | { status: "skipped"; detail?: string } = { status: "skipped" };
  if (!enabled) { api = { status: "skipped", detail: "connector disabled; first call starts billing" }; }
  else if (creds.status !== "missing") {
    const client = buildClearviewClient();
    const started = Date.now();
    const failures: string[] = [];
    for (const company of client.companies()) {
      try { await client.get(company, "/organization/stores", { includeInactiveStores: false }); }
      catch (e: any) { failures.push(`${company}: ${errText(e)}`); }
    }
    api = failures.length ? { status: "fail", ms: Date.now() - started, detail: failures.join("; ").slice(0, 300) } : { status: "pass", ms: Date.now() - started };
  }
  if (creds.status === "missing") notes.push(creds.mode === "oauth" ? "no Clearview OAuth settings (CLEARVIEW_TOKEN_URL, CLEARVIEW_CLIENT_ID_<COMPANY>, CLEARVIEW_CLIENT_SECRET_<COMPANY>): Clearview not called, live stores run as shadow"
                                                                      : "no CLEARVIEW_AUTH_KEY_<COMPANY> set: Clearview not called, live stores run as shadow");
  if (creds.status === "partial") notes.push(`credentials for ${Object.entries(creds.companies).filter(([, ok]) => !ok).map(([c]) => c).join(", ")} missing: those companies run as shadow`);
  if (!enabled) notes.push("CLEARVIEW_ENABLED is not \"true\": timer, after-sync runs and every Clearview call are off");

  let queue: Record<string, number | null> | null = null;
  const codes: Record<string, number> = { store: 0, job: 0, termination: 0 };
  let sqlError: string | null = null;
  try {
    const pool = await getSharedHubPool();
    const stats: any = await pool.request().input("destination", sql.VarChar(20), "clearview").query(STATS_SQL);
    const row = stats.recordset?.[0] ?? {};
    const n = (v: any) => Number(v ?? 0);
    queue = { pending: n(row.pending), waiting: n(row.waiting), failed: n(row.failed), dead: n(row.dead),
              oldestPendingMinutes: row.oldest_pending_minutes === null || row.oldest_pending_minutes === undefined ? null : Number(row.oldest_pending_minutes) };
    const counts: any = await pool.request().input("destination", sql.VarChar(20), "clearview").query(CODES_COUNT_SQL);
    for (const r of counts.recordset ?? []) if (r.code_type in codes) codes[r.code_type] = Number(r.n);
    if (codes.store === 0) notes.push("no store mappings yet: run POST /api/hub/clearview/discover once a key exists");
    if (codes.job === 0) notes.push("no job mappings yet: fill provisioning/17-destination-codes-clearview.sql");
  } catch (e: any) {
    resetSharedHubPool();
    sqlError = errText(e);
  }

  const status: ComponentStatus = api.status === "fail" || sqlError ? "fail" : (creds.status !== "present" || !enabled || secretWarn || codes.store === 0 || codes.job === 0) ? "warn" : "pass";
  const detail = [sqlError ? `queue unavailable: ${sqlError}` : null, ...notes].filter(Boolean).join("; ");
  return { name: "clearview", status, enabled, live, authMode: creds.mode, credentials: creds.status, secretExpiresUtc, api, queue, codes, ...(detail ? { detail } : {}) };
}

/** The Entra sync: token + GET /users?$top=1 probe (skipped unless the sync is enabled or a snapshot exists), age of the
 *  last entra.sync_runs row (warn past 26 h when enabled), counts, write switch. Never writes to Graph. */
export async function checkEntra(now: Date = new Date()): Promise<Component> {
  const enabled = config.entraSyncEnabled, writeEnabled = config.entraWriteEnabled;
  const notes: string[] = [];
  let counts: Record<string, number> | null = null;
  let lastRun: { runId: string; startedUtc: string; finishedUtc: string | null; status: string; trigger: string; ageHours: number } | null = null;
  let sqlError: string | null = null;
  try {
    const pool = await getSharedHubPool();
    const c: any = await pool.request().input("today", sql.Date, torontoToday(now)).query(ENTRA_COUNTS_SQL);
    const row = c.recordset?.[0] ?? {};
    const n = (v: any) => Number(v ?? 0);
    counts = { users: n(row.users), linked: n(row.linked), unlinkedWithEmail: n(row.unlinked_with_email), orphans: n(row.orphans),
               proposed: n(row.proposed), due: n(row.due), failed: n(row.failed), blocked: n(row.blocked) };
    const r: any = await pool.request().query(ENTRA_LAST_RUN_SQL);
    const run = r.recordset?.[0];
    if (run) {
      const started = new Date(run.started_utc);
      lastRun = { runId: String(run.run_id), startedUtc: started.toISOString(), finishedUtc: run.finished_utc ? new Date(run.finished_utc).toISOString() : null,
                  status: String(run.status), trigger: String(run.trigger_kind), ageHours: Math.round((now.getTime() - started.getTime()) / 36_000) / 100 };
    }
  } catch (e: any) {
    resetSharedHubPool();
    sqlError = errText(e);
  }

  const hasSnapshot = (counts?.users ?? 0) > 0;
  let api: Component | { status: "skipped"; detail?: string } = { status: "skipped", detail: "sync disabled and no snapshot yet" };
  if (enabled || hasSnapshot) {
    try { api = { status: "pass", ms: await buildGraphClient().probeDirectory() }; }
    catch (e: any) { api = { status: "fail", detail: errText(e) }; }
  }

  let runStale = false;
  if (!enabled) notes.push("ENTRA_SYNC_ENABLED is not \"true\": timer and after-sync runs are off");
  if (enabled && !lastRun && !sqlError) { notes.push("no Entra sync run yet: run POST /api/hub/entra/sync"); runStale = true; }
  if (lastRun && lastRun.ageHours > ENTRA_RUN_WARN_HOURS && enabled) { notes.push(`last Entra sync ${Math.round(lastRun.ageHours)} h ago`); runStale = true; }
  if (lastRun?.status === "failed") notes.push("last Entra sync failed");
  if (counts && counts.failed > 0) notes.push(`${counts.failed} proposal(s) failed to apply`);
  if (!writeEnabled) notes.push("ENTRA_WRITE_ENABLED is not \"true\": accepted proposals are not pushed to Entra");

  const status: ComponentStatus = api.status === "fail" || (sqlError && enabled) ? "fail"
    : (sqlError || !enabled || runStale || lastRun?.status === "failed" || (counts?.failed ?? 0) > 0) ? "warn" : "pass";
  const detail = [sqlError ? `entra tables unavailable: ${sqlError}` : null, ...notes].filter(Boolean).join("; ");
  return { status, enabled, writeEnabled, api, lastRun, counts, ...(detail ? { detail } : {}) };
}

// ---------------------------------------------------------------- endpoint ----------------------------------------------------------------
export async function hubDiagnostics(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = authorize(req, { scope: Scopes.SummaryWrite, anyRole: [Roles.SummaryRead] });
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;
  const admin = caller.roles.has(Roles.SummaryAdmin);

  // Each check catches its own errors; a rejected promise here would be a bug, so still guard the whole set.
  const guard = async <T extends Component>(p: Promise<T> | T): Promise<T | Component> => {
    try { return await p; } catch (e: any) { return { status: "fail", detail: errText(e) }; }
  };
  const [settings, sql, grants, audit, ukg, sync, callerStatus, clearview, entra] = await Promise.all([
    guard(checkSettings(admin)), guard(checkSql()), guard(checkGrants(admin)), guard(checkAudit()),
    guard(checkUkg()), guard(checkSync()), guard(checkCaller(caller)), guard(checkClearview()), guard(checkEntra())
  ]);

  const body = {
    checkedUtc: new Date().toISOString(),
    caller: callerStatus, settings, sql, grants, audit, ukg, sync, entra,
    destinations: [{ name: "clearview", ...clearview }] as Component[]      // Rosnet joins in phase 6
  };
  const statuses = [callerStatus, settings, sql, grants, audit, ukg, sync].map(c => c.status);
  const ok = statuses.filter(s => s === "pass").length, fail = statuses.filter(s => s === "fail").length;
  ctx.log(`[diagnostics] by=${describeCaller(caller)} ok=${ok} fail=${fail} clearview=${clearview.status} entra=${entra.status}`);
  return { status: 200, headers: NO_STORE, jsonBody: body };
}

app.http("hubDiagnostics", { methods: ["GET"], authLevel: "anonymous", route: "hub/diagnostics", handler: hubDiagnostics });
