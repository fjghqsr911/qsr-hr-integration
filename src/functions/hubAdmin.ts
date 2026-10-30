import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authorize, describeCaller, Roles, Scopes } from "../shared/auth";
import { getSharedHubPool, resetSharedHubPool, sql } from "../shared/sql";
import { writeAudit } from "../shared/audit";

// Admin actions for the delivery queue (used by the read-only monitor UI, which never writes to the database itself).
//
//   PUT  /api/hub/stores/{destination}/{store}/mode   { "mode": "off" | "shadow" | "live" }   upsert ref.store_modes
//   POST /api/hub/deliveries/{id}/retry                failed / dead -> pending, next attempt now (attempts kept)
//   POST /api/hub/deliveries/{id}/resolve              review -> resolved
//
// All three: scope Employees.Summary.Write + role Summary.Admin (same pair as /api/hub/sync). No app-only callers.
// Every call is audited as a write (who, which app, which delivery's employee, which field - never values).
// The audit record is written BEFORE the change; if it cannot be written, nothing changes and the caller gets 503.

const NO_STORE = { "Cache-Control": "no-store", "Pragma": "no-cache" };
const DESTINATIONS = ["clearview", "rosnet"] as const;
const MODES = ["off", "shadow", "live"] as const;
const STORE_PATTERN = /^[A-Za-z0-9]{1,20}$/;
const DELIVERY_ID_PATTERN = /^\d{1,15}$/;          // bigint identity; stays a safe JS integer

export const STORE_MODE_SQL = `
MERGE ref.store_modes WITH (HOLDLOCK) AS t
USING (SELECT @destination AS destination, @store AS store) AS s
   ON t.destination = s.destination AND t.store = s.store
WHEN MATCHED THEN UPDATE SET mode = @mode, changed_utc = SYSUTCDATETIME(), changed_by = @changedBy
WHEN NOT MATCHED THEN INSERT (destination, store, mode, changed_utc, changed_by)
                      VALUES (@destination, @store, @mode, SYSUTCDATETIME(), @changedBy)
OUTPUT inserted.destination, inserted.store, inserted.mode, inserted.changed_utc, inserted.changed_by;`;

const DELIVERY_COLUMNS = `delivery_id, destination, kind, employee_id, event_type, action, effective_date, store, status,
       attempts, next_attempt_utc, queued_utc, finished_utc, last_error`;

export const DELIVERY_SELECT_SQL = `SELECT ${DELIVERY_COLUMNS} FROM [out].deliveries WHERE delivery_id = @id;`;

export const DELIVERY_RETRY_SQL = `
UPDATE [out].deliveries SET status = 'pending', next_attempt_utc = SYSUTCDATETIME()
OUTPUT ${DELIVERY_COLUMNS.replace(/(\w+)/g, "inserted.$1")}
WHERE delivery_id = @id AND status IN ('failed', 'dead');`;

export const DELIVERY_RESOLVE_SQL = `
UPDATE [out].deliveries SET status = 'resolved', finished_utc = SYSUTCDATETIME()
OUTPUT ${DELIVERY_COLUMNS.replace(/(\w+)/g, "inserted.$1")}
WHERE delivery_id = @id AND status = 'review';`;

const iso = (d: any) => (d ? new Date(d).toISOString() : null);
const dateOnly = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : null);

export function mapStoreModeRow(r: any) {
  return { destination: r.destination, store: r.store, mode: r.mode, changedUtc: iso(r.changed_utc), changedBy: r.changed_by ?? null };
}

export function mapDeliveryRow(r: any) {
  return {
    deliveryId: Number(r.delivery_id), destination: r.destination, kind: r.kind, employeeId: r.employee_id,
    eventType: r.event_type, action: r.action ?? null, effectiveDate: dateOnly(r.effective_date), store: r.store ?? null,
    status: r.status, attempts: r.attempts, nextAttemptUtc: iso(r.next_attempt_utc), queuedUtc: iso(r.queued_utc),
    finishedUtc: iso(r.finished_utc), lastError: r.last_error ?? null
  };
}

const unavailable = (): HttpResponseInit => ({ status: 503, jsonBody: { error: "Temporarily unavailable" }, headers: NO_STORE });

// ---------------------------------------------------------------- store mode ----------------------------------------------------------------
const STORE_MODE_ENDPOINT = "PUT /hub/stores/{destination}/{store}/mode";

export async function hubStoreMode(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = authorize(req, { scope: Scopes.SummaryWrite, anyRole: [Roles.SummaryAdmin] });
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;

  const destination = (req.params.destination ?? "").toLowerCase();
  const store = (req.params.store ?? "").toUpperCase();          // store codes are stored upper-case (e.g. T01647)
  if (!(DESTINATIONS as readonly string[]).includes(destination)) return { status: 400, jsonBody: { error: "Invalid destination" } };
  if (!STORE_PATTERN.test(store)) return { status: 400, jsonBody: { error: "Invalid store" } };

  let body: any;
  try { body = await req.json(); } catch { return { status: 400, jsonBody: { error: "Body must be JSON" } }; }
  const mode = typeof body?.mode === "string" ? body.mode.toLowerCase() : "";
  if (!(MODES as readonly string[]).includes(mode)) return { status: 400, jsonBody: { error: "mode must be off, shadow or live" } };

  ctx.log(`store-mode ${destination}/${store} -> ${mode} by=${describeCaller(caller)}`);
  const audit = { caller, endpoint: STORE_MODE_ENDPOINT, employeeId: "", action: "write" as const, fields: ["mode"] };

  // Audit BEFORE changing anything. If this throws, nothing is written and the caller gets 503.
  try { await writeAudit({ ...audit, outcome: "allowed" }); }
  catch (e: any) { ctx.error(`store-mode audit failed: ${String(e?.message ?? "error").slice(0, 200)}`); return unavailable(); }

  try {
    const pool = await getSharedHubPool();
    const result: any = await pool.request()
      .input("destination", sql.VarChar(20), destination)
      .input("store", sql.VarChar(20), store)
      .input("mode", sql.VarChar(10), mode)
      .input("changedBy", sql.NVarChar(200), describeCaller(caller).slice(0, 200))
      .query(STORE_MODE_SQL);
    const row = result.recordset?.[0];
    if (!row) throw new Error("upsert returned no row");
    return { headers: NO_STORE, jsonBody: mapStoreModeRow(row) };
  } catch (e: any) {
    resetSharedHubPool();
    ctx.error(`store-mode failed ${destination}/${store}: ${String(e?.message ?? "error").slice(0, 200)}`);
    try { await writeAudit({ ...audit, outcome: "error" }); } catch { /* already failing */ }
    return unavailable();
  }
}

// ---------------------------------------------------------------- deliveries ----------------------------------------------------------------
interface Transition { endpoint: string; label: string; from: readonly string[]; sql: string; }

const RETRY: Transition = { endpoint: "POST /hub/deliveries/{id}/retry", label: "retry", from: ["failed", "dead"], sql: DELIVERY_RETRY_SQL };
const RESOLVE: Transition = { endpoint: "POST /hub/deliveries/{id}/resolve", label: "resolve", from: ["review"], sql: DELIVERY_RESOLVE_SQL };

async function deliveryTransition(req: HttpRequest, ctx: InvocationContext, t: Transition): Promise<HttpResponseInit> {
  const auth = authorize(req, { scope: Scopes.SummaryWrite, anyRole: [Roles.SummaryAdmin] });
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;

  const idText = req.params.id ?? "";
  if (!DELIVERY_ID_PATTERN.test(idText)) return { status: 400, jsonBody: { error: "Invalid delivery id" } };
  const id = Number(idText);
  ctx.log(`delivery ${t.label} id=${id} by=${describeCaller(caller)}`);

  const audit = { caller, endpoint: t.endpoint, action: "write" as const, fields: ["status"] };
  let employeeId = "";
  const conflict = (status: string): HttpResponseInit =>
    ({ status: 409, headers: NO_STORE, jsonBody: { error: `Delivery is ${status}; ${t.label} needs ${t.from.join(" or ")}`, status } });

  try {
    const pool = await getSharedHubPool();
    const current: any = await pool.request().input("id", sql.BigInt, id).query(DELIVERY_SELECT_SQL);
    const row = current.recordset?.[0];
    if (!row) {
      await writeAudit({ ...audit, employeeId, outcome: "not_found" });
      return { status: 404, jsonBody: { error: "Delivery not found" }, headers: NO_STORE };
    }
    employeeId = String(row.employee_id ?? "");
    if (!t.from.includes(row.status)) return conflict(row.status);     // nothing changes, nothing to audit

    // Audit BEFORE the update. If this throws, the delivery is left as it is and the caller gets 503.
    try { await writeAudit({ ...audit, employeeId, outcome: "allowed" }); }
    catch (e: any) { ctx.error(`delivery ${t.label} audit failed id=${id}: ${String(e?.message ?? "error").slice(0, 200)}`); return unavailable(); }

    const updated: any = await pool.request().input("id", sql.BigInt, id).query(t.sql);
    const after = updated.recordset?.[0];
    if (!after) {                                                        // status changed between the read and the update
      const again: any = await pool.request().input("id", sql.BigInt, id).query(DELIVERY_SELECT_SQL);
      return again.recordset?.[0] ? conflict(again.recordset[0].status) : { status: 404, jsonBody: { error: "Delivery not found" }, headers: NO_STORE };
    }
    return { headers: NO_STORE, jsonBody: mapDeliveryRow(after) };
  } catch (e: any) {
    resetSharedHubPool();
    ctx.error(`delivery ${t.label} failed id=${id}: ${String(e?.message ?? "error").slice(0, 200)}`);
    try { await writeAudit({ ...audit, employeeId, outcome: "error" }); } catch { /* already failing */ }
    return unavailable();
  }
}

export const hubDeliveryRetry = (req: HttpRequest, ctx: InvocationContext) => deliveryTransition(req, ctx, RETRY);
export const hubDeliveryResolve = (req: HttpRequest, ctx: InvocationContext) => deliveryTransition(req, ctx, RESOLVE);

app.http("hubStoreMode", { methods: ["PUT"], authLevel: "anonymous", route: "hub/stores/{destination}/{store}/mode", handler: hubStoreMode });
app.http("hubDeliveryRetry", { methods: ["POST"], authLevel: "anonymous", route: "hub/deliveries/{id}/retry", handler: hubDeliveryRetry });
app.http("hubDeliveryResolve", { methods: ["POST"], authLevel: "anonymous", route: "hub/deliveries/{id}/resolve", handler: hubDeliveryResolve });
