import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authorize, describeCaller, Roles, Scopes } from "../shared/auth";
import { getSharedHubPool, resetSharedHubPool, sql } from "../shared/sql";
import { parseRosterFilters, mapRosterRow, ROSTER_SQL } from "../shared/roster";

// GET /api/hub/roster
//   Optional, comma-separated: jobCodes, store, district, company, status (A,L; default both)
//   e.g. /api/hub/roster?jobCodes=GM,RM,RMH&district=T2
// Scope Employees.Summary.Read + role Summary.Read/Admin, or app role Integration.Run / Roster.Read.All
// (app-only callers such as the directory app's server; the app enforces which of its users may see the roster).
// Returns names, store, job and dates only - no pay or personal data. Served from sqldb-hrint (kept current by the hub sync).
export async function hubRoster(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = authorize(req, { scope: Scopes.SummaryRead, anyRole: [Roles.SummaryRead], appRole: [Roles.IntegrationRun, Roles.RosterReadApp] });
  if (!auth.ok) return auth.response!;

  const parsed = parseRosterFilters(req.query);
  if (parsed.error) return { status: 400, jsonBody: { error: parsed.error } };
  const f = parsed.filters!;
  const j = (v: string[] | null) => (v ? JSON.stringify(v) : null);

  try {
    const pool = await getSharedHubPool();
    const result: any = await pool.request()
      .input("statuses", sql.NVarChar(sql.MAX), JSON.stringify(f.statuses))
      .input("jobCodes", sql.NVarChar(sql.MAX), j(f.jobCodes))
      .input("stores", sql.NVarChar(sql.MAX), j(f.stores))
      .input("districts", sql.NVarChar(sql.MAX), j(f.districts))
      .input("companies", sql.NVarChar(sql.MAX), j(f.companies))
      .query(ROSTER_SQL);
    const rows = result.recordsets[0] as any[];
    const asOf = result.recordsets[1]?.[0]?.data_as_of_utc;
    ctx.log(`roster by=${describeCaller(auth.caller!)} rows=${rows.length}`);   // counts only
    return {
      headers: { "Cache-Control": "private, no-store" },
      jsonBody: {
        count: rows.length,
        dataAsOfUtc: asOf ? new Date(asOf).toISOString() : null,
        filters: f,
        employees: rows.map(mapRosterRow)
      }
    };
  } catch (e: any) {
    resetSharedHubPool();
    ctx.error(`roster failed: ${String(e?.message ?? "error").slice(0, 200)}`);
    return { status: 503, jsonBody: { error: "Roster temporarily unavailable" } };
  }
}

app.http("hubRoster", { methods: ["GET"], authLevel: "anonymous", route: "hub/roster", handler: hubRoster });
