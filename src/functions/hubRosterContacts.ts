import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authorize, describeCaller, Roles, Scopes } from "../shared/auth";
import { getSharedHubPool, resetSharedHubPool, sql } from "../shared/sql";
import { parseRosterFilters, mapRosterContactRow, ROSTER_CONTACTS_SQL } from "../shared/roster";
import { writeAudit } from "../shared/audit";

// GET /api/hub/roster/contacts  - roster + personal email, work email, work phone, company phone,
//   birth month + day (never the year).  SENSITIVE TIER.
//   Same optional filters as /api/hub/roster: jobCodes, store, district, company, status.
//   Access: app role RosterContacts.Read.All (e.g. rewards app managed identity), or
//           scope Employees.Sensitive.Read + role Sensitive.Read/Admin (people, e.g. HR testing).
//   Every call is audited (caller, app, record count, field names - never values). If the audit write fails,
//   no data is returned (fail closed).
const FIELDS = ["personalEmail", "workEmail", "workPhone", "companyPhone", "birthMonth", "birthDay"];
const ENDPOINT = "GET /hub/roster/contacts";

export async function hubRosterContacts(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = authorize(req, { scope: Scopes.SensitiveRead, anyRole: [Roles.SensitiveRead], appRole: Roles.RosterContactsReadApp });
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;

  const parsed = parseRosterFilters(req.query);
  if (parsed.error) return { status: 400, jsonBody: { error: parsed.error } };
  const f = parsed.filters!;
  const j = (v: string[] | null) => (v ? JSON.stringify(v) : null);
  const noStore = { "Cache-Control": "no-store", "Pragma": "no-cache" };

  let rows: any[]; let asOf: any;
  try {
    const pool = await getSharedHubPool();
    const result: any = await pool.request()
      .input("statuses", sql.NVarChar(sql.MAX), JSON.stringify(f.statuses))
      .input("jobCodes", sql.NVarChar(sql.MAX), j(f.jobCodes))
      .input("stores", sql.NVarChar(sql.MAX), j(f.stores))
      .input("districts", sql.NVarChar(sql.MAX), j(f.districts))
      .input("companies", sql.NVarChar(sql.MAX), j(f.companies))
      .query(ROSTER_CONTACTS_SQL);
    rows = result.recordsets[0] as any[];
    asOf = result.recordsets[1]?.[0]?.data_as_of_utc;
  } catch (e: any) {
    resetSharedHubPool();
    ctx.error(`roster contacts query failed: ${String(e?.message ?? "error").slice(0, 200)}`);
    return { status: 503, jsonBody: { error: "Temporarily unavailable" }, headers: noStore };
  }

  try {
    // Audit BEFORE returning data (one record per call: who, which app, how many rows, which fields).
    await writeAudit({ caller, endpoint: ENDPOINT, employeeId: `bulk:${rows.length}`, action: "read", fields: FIELDS, outcome: "allowed" });
  } catch {
    ctx.error("roster contacts: audit unavailable - no data returned");
    return { status: 503, jsonBody: { error: "Temporarily unavailable" }, headers: noStore };
  }

  ctx.log(`roster contacts by=${describeCaller(caller)} rows=${rows.length}`);   // counts only
  return {
    headers: noStore,
    jsonBody: {
      count: rows.length,
      dataAsOfUtc: asOf ? new Date(asOf).toISOString() : null,
      filters: f,
      employees: rows.map(mapRosterContactRow)
    }
  };
}

app.http("hubRosterContacts", { methods: ["GET"], authLevel: "anonymous", route: "hub/roster/contacts", handler: hubRosterContacts });
