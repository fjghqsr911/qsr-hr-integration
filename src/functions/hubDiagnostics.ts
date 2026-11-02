import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authorize, Caller, describeCaller, Roles, Scopes } from "../shared/auth";
import { config } from "../shared/config";
import { getSharedHubPool, resetSharedHubPool } from "../shared/sql";
import { ukgGet, UkgError } from "../shared/ukg";
import { probeAudit } from "../shared/audit";

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
const KEY_VAULT_PREFIX = "@Microsoft.KeyVault(";                  // an unresolved Key Vault reference is still the literal text

/** The grants the admin endpoints and the sync need (provisioning/15-admin-endpoint-grants.sql). Column -> object + permission. */
export const GRANTS: ReadonlyArray<{ column: string; object: string; permission: string }> = [
  { column: "storeModesInsert", object: "ref.store_modes", permission: "INSERT" },
  { column: "storeModesUpdate", object: "ref.store_modes", permission: "UPDATE" },
  { column: "deliveriesUpdate", object: "[out].[deliveries]", permission: "UPDATE" },
  { column: "syncRunsInsert", object: "stage.sync_runs", permission: "INSERT" }
];
export const GRANTS_SQL = `SELECT ${GRANTS.map(g => `HAS_PERMS_BY_NAME('${g.object}','OBJECT','${g.permission}') AS ${g.column}`).join(", ")};`;

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

// ---------------------------------------------------------------- endpoint ----------------------------------------------------------------
export async function hubDiagnostics(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = authorize(req, { scope: Scopes.SummaryWrite, anyRole: [Roles.SummaryRead] });
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;
  const admin = caller.roles.has(Roles.SummaryAdmin);

  // Each check catches its own errors; a rejected promise here would be a bug, so still guard the whole set.
  const guard = async (p: Promise<Component> | Component): Promise<Component> => {
    try { return await p; } catch (e: any) { return { status: "fail", detail: errText(e) }; }
  };
  const [settings, sql, grants, audit, ukg, sync, callerStatus] = await Promise.all([
    guard(checkSettings(admin)), guard(checkSql()), guard(checkGrants(admin)), guard(checkAudit()),
    guard(checkUkg()), guard(checkSync()), guard(checkCaller(caller))
  ]);

  const body = {
    checkedUtc: new Date().toISOString(),
    caller: callerStatus, settings, sql, grants, audit, ukg, sync,
    destinations: [] as Component[]                                   // placeholder for the Clearview / Rosnet connectors
  };
  const statuses = [callerStatus, settings, sql, grants, audit, ukg, sync].map(c => c.status);
  const ok = statuses.filter(s => s === "pass").length, fail = statuses.filter(s => s === "fail").length;
  ctx.log(`[diagnostics] by=${describeCaller(caller)} ok=${ok} fail=${fail}`);
  return { status: 200, headers: NO_STORE, jsonBody: body };
}

app.http("hubDiagnostics", { methods: ["GET"], authLevel: "anonymous", route: "hub/diagnostics", handler: hubDiagnostics });
