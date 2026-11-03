import { app, HttpRequest, HttpResponseInit, InvocationContext, Timer } from "@azure/functions";
import { config } from "../shared/config";
import { authorize, describeCaller, Roles, Scopes } from "../shared/auth";
import { writeAudit } from "../shared/audit";
import { runConnector, runDiscovery } from "../shared/connectors";

// Clearview connector: drains out.deliveries for destination 'clearview'.
//
//   timer       every 15 minutes (CLEARVIEW_ENABLED = true), plus after every successful / partial intraday sync
//   GET|POST    /api/hub/clearview/run                       run now (always allowed, even with the timer off)
//   POST        /api/hub/clearview/discover?what=codes       stores / jobs / termination reasons from Clearview -> report + ref.destination_codes
//   POST        /api/hub/clearview/discover?what=employees   seed xref.employees from Clearview's employee list
// Manual routes: scope Employees.Summary.Write + role Summary.Admin, or app role Integration.Run. Audited as a write BEFORE
// anything runs (fail-closed: 503 and nothing runs when the audit record cannot be written). Responses carry counts and
// ids only; never employee names, SIN, dates of birth or pay.

const NO_STORE = { "Cache-Control": "no-store", "Pragma": "no-cache" };
const errText = (e: any) => String(e?.message ?? "error").replace(/\?.*$/, "").slice(0, 200);

app.timer("clearviewConnectorTimer", {
  schedule: "0 */15 * * * *",
  handler: async (_timer: Timer, ctx: InvocationContext) => {
    if (!config.clearviewEnabled) { ctx.log("[clearview] disabled (CLEARVIEW_ENABLED is not 'true') - skipping"); return; }
    await runConnector("clearview", ctx, "timer");
  }
});

export async function clearviewRun(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = authorize(req, { scope: Scopes.SummaryWrite, anyRole: [Roles.SummaryAdmin], appRole: Roles.IntegrationRun });
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;
  ctx.log(`[clearview] manual run by ${describeCaller(caller)}`);
  const audit = { caller, endpoint: "POST /hub/clearview/run", employeeId: "", action: "write" as const, fields: ["deliveries"] };
  try { await writeAudit({ ...audit, outcome: "allowed" }); }
  catch (e: any) { ctx.error(`[clearview] run audit failed: ${errText(e)}`); return { status: 503, headers: NO_STORE, jsonBody: { error: "Temporarily unavailable" } }; }
  try {
    const result = await runConnector("clearview", ctx, "manual");
    return { status: result.status === "failed" ? 502 : 200, headers: NO_STORE, jsonBody: result };
  } catch (e: any) {
    ctx.error(`[clearview] manual run error: ${errText(e)}`);
    try { await writeAudit({ ...audit, outcome: "error" }); } catch { /* already failing */ }
    return { status: 503, headers: NO_STORE, jsonBody: { status: "failed", message: "Connector could not start (database or configuration)" } };
  }
}

export async function clearviewDiscover(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = authorize(req, { scope: Scopes.SummaryWrite, anyRole: [Roles.SummaryAdmin], appRole: Roles.IntegrationRun });
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;
  const what = (req.query.get("what") ?? "codes").toLowerCase();
  if (what !== "codes" && what !== "employees") return { status: 400, jsonBody: { error: "what must be codes or employees" } };
  ctx.log(`[clearview] discover ${what} by ${describeCaller(caller)}`);
  const audit = { caller, endpoint: "POST /hub/clearview/discover", employeeId: "", action: "write" as const, fields: [what === "codes" ? "destination_codes" : "xref"] };
  try { await writeAudit({ ...audit, outcome: "allowed" }); }
  catch (e: any) { ctx.error(`[clearview] discover audit failed: ${errText(e)}`); return { status: 503, headers: NO_STORE, jsonBody: { error: "Temporarily unavailable" } }; }
  try {
    const report = await runDiscovery(ctx, what);
    return { status: 200, headers: NO_STORE, jsonBody: report };
  } catch (e: any) {
    ctx.error(`[clearview] discover error: ${errText(e)}`);
    try { await writeAudit({ ...audit, outcome: "error" }); } catch { /* already failing */ }
    return { status: 503, headers: NO_STORE, jsonBody: { error: "Discovery could not run (database or configuration)" } };
  }
}

app.http("clearviewRun", { methods: ["GET", "POST"], authLevel: "anonymous", route: "hub/clearview/run", handler: clearviewRun });
app.http("clearviewDiscover", { methods: ["POST"], authLevel: "anonymous", route: "hub/clearview/discover", handler: clearviewDiscover });
