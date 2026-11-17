import { app, HttpRequest, HttpResponseInit, InvocationContext, Timer } from "@azure/functions";
import { config } from "../shared/config";
import { authorize, describeCaller, Roles, Scopes } from "../shared/auth";
import { writeAudit } from "../shared/audit";
import { rosnetCredentials, runConnector, runRosnetDiscovery } from "../shared/connectors";

// Rosnet connector: drains out.deliveries for destination 'rosnet' (Employee Data Transfer API -> NCR HR Bridge -> Aloha).
//
//   timer       hourly at :45 (ROSNET_ENABLED = true): retries and manual retries / queued events. New events never wait
//               for it: every enabled connector also runs after each succeeded / partial intraday sync and nightly
//   GET|POST    /api/hub/rosnet/run                       run now (always allowed, even with the timer off)
//   POST        /api/hub/rosnet/discover?what=codes       locations / job codes / termination codes -> report + store pairs in ref.destination_codes
//   POST        /api/hub/rosnet/discover?what=employees   seed xref.employees from Rosnet's per-location employee lists
// Without Rosnet credentials (or with the sandbox host configured in Azure) nothing calls Rosnet: the run works as shadow
// and discover answers 409.
// Manual routes: scope Employees.Summary.Write + role Summary.Admin, or app role Integration.Run. Audited as a write BEFORE
// anything runs (fail-closed: 503 and nothing runs when the audit record cannot be written). Responses carry counts,
// codes and location numbers only; never employee names, SIN, dates of birth or pay.

const NO_STORE = { "Cache-Control": "no-store", "Pragma": "no-cache" };
const errText = (e: any) => String(e?.message ?? "error").replace(/\?.*$/, "").slice(0, 200);

app.timer("rosnetConnectorTimer", {
  schedule: "0 45 * * * *",             // :45 keeps clear of the syncs (:05, :15) and of the Clearview timer (:30)
  handler: async (_timer: Timer, ctx: InvocationContext) => {
    if (!config.rosnetEnabled) { ctx.log("[rosnet] disabled (ROSNET_ENABLED is not 'true') - skipping"); return; }
    await runConnector("rosnet", ctx, "timer");
  }
});

export async function rosnetRun(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = authorize(req, { scope: Scopes.SummaryWrite, anyRole: [Roles.SummaryAdmin], appRole: Roles.IntegrationRun });
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;
  ctx.log(`[rosnet] manual run by ${describeCaller(caller)}`);
  const audit = { caller, endpoint: "POST /hub/rosnet/run", employeeId: "", action: "write" as const, fields: ["deliveries"] };
  try { await writeAudit({ ...audit, outcome: "allowed" }); }
  catch (e: any) { ctx.error(`[rosnet] run audit failed: ${errText(e)}`); return { status: 503, headers: NO_STORE, jsonBody: { error: "Temporarily unavailable" } }; }
  try {
    const result = await runConnector("rosnet", ctx, "manual");
    return { status: result.status === "failed" ? 502 : 200, headers: NO_STORE, jsonBody: result };
  } catch (e: any) {
    ctx.error(`[rosnet] manual run error: ${errText(e)}`);
    try { await writeAudit({ ...audit, outcome: "error" }); } catch { /* already failing */ }
    return { status: 503, headers: NO_STORE, jsonBody: { status: "failed", message: "Connector could not start (database or configuration)" } };
  }
}

export async function rosnetDiscover(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = authorize(req, { scope: Scopes.SummaryWrite, anyRole: [Roles.SummaryAdmin], appRole: Roles.IntegrationRun });
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;
  const what = (req.query.get("what") ?? "codes").toLowerCase();
  if (what !== "codes" && what !== "employees") return { status: 400, jsonBody: { error: "what must be codes or employees" } };
  const creds = rosnetCredentials();
  if (!creds.callable)
    return { status: 409, headers: NO_STORE, jsonBody: { error: creds.status === "present" ? "The Rosnet settings point at the sandbox, which is never called from Azure" : "Rosnet credentials are not configured" } };
  ctx.log(`[rosnet] discover ${what} by ${describeCaller(caller)}`);
  const audit = { caller, endpoint: "POST /hub/rosnet/discover", employeeId: "", action: "write" as const, fields: [what === "codes" ? "destination_codes" : "xref"] };
  try { await writeAudit({ ...audit, outcome: "allowed" }); }
  catch (e: any) { ctx.error(`[rosnet] discover audit failed: ${errText(e)}`); return { status: 503, headers: NO_STORE, jsonBody: { error: "Temporarily unavailable" } }; }
  try {
    const report = await runRosnetDiscovery(ctx, what);
    return { status: 200, headers: NO_STORE, jsonBody: report };
  } catch (e: any) {
    ctx.error(`[rosnet] discover error: ${errText(e)}`);
    try { await writeAudit({ ...audit, outcome: "error" }); } catch { /* already failing */ }
    return { status: 503, headers: NO_STORE, jsonBody: { error: "Discovery could not run (database or configuration)" } };
  }
}

app.http("rosnetRun", { methods: ["GET", "POST"], authLevel: "anonymous", route: "hub/rosnet/run", handler: rosnetRun });
app.http("rosnetDiscover", { methods: ["POST"], authLevel: "anonymous", route: "hub/rosnet/discover", handler: rosnetDiscover });
