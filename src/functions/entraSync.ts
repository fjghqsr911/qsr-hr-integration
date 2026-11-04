import { app, HttpRequest, HttpResponseInit, InvocationContext, Timer } from "@azure/functions";
import { config } from "../shared/config";
import { authorize, describeCaller, Roles, Scopes } from "../shared/auth";
import { writeAudit } from "../shared/audit";
import { runEntraSyncJob } from "../shared/entra/runner";

// Entra sync: snapshot Entra users and groups, link them to employees, turn UKG differences into PROPOSALS.
// Never writes to Entra (apply is a separate, audited admin action in entraAdmin.ts).
//
//   timer       06:45 UTC daily (after the 06:15 nightly), when ENTRA_SYNC_ENABLED = true; also after every succeeded /
//               partial intraday sync (hubSync.ts hook) when enabled
//   POST        /api/hub/entra/sync      run now: scope Employees.Summary.Write + role Entra.Admin, or app role Integration.Run;
//               409 while another run holds the lock; audited as a write BEFORE anything runs (503 when the audit fails)

const NO_STORE = { "Cache-Control": "no-store", "Pragma": "no-cache" };
const errText = (e: any) => String(e?.message ?? "error").replace(/\?.*$/, "").slice(0, 200);

app.timer("entraSyncTimer", {
  schedule: "0 45 6 * * *",
  handler: async (_timer: Timer, ctx: InvocationContext) => {
    if (!config.entraSyncEnabled) { ctx.log("[entra] disabled (ENTRA_SYNC_ENABLED is not 'true') - skipping"); return; }
    await runEntraSyncJob(ctx, "timer");
  }
});

export async function entraSyncRun(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = authorize(req, { scope: Scopes.SummaryWrite, anyRole: [Roles.EntraAdmin], appRole: Roles.IntegrationRun });
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;
  ctx.log(`[entra] manual sync by ${describeCaller(caller)}`);
  const audit = { caller, endpoint: "POST /hub/entra/sync", employeeId: "", action: "write" as const, fields: ["proposals"] };
  try { await writeAudit({ ...audit, outcome: "allowed" }); }
  catch (e: any) { ctx.error(`[entra] sync audit failed: ${errText(e)}`); return { status: 503, headers: NO_STORE, jsonBody: { error: "Temporarily unavailable" } }; }
  try {
    const result = await runEntraSyncJob(ctx, "manual");
    const status = result.status === "locked" ? 409 : result.status === "failed" ? 502 : 200;
    return { status, headers: NO_STORE, jsonBody: result };
  } catch (e: any) {
    ctx.error(`[entra] manual sync error: ${errText(e)}`);
    try { await writeAudit({ ...audit, outcome: "error" }); } catch { /* already failing */ }
    return { status: 503, headers: NO_STORE, jsonBody: { status: "failed", message: "Entra sync could not start (database or configuration)" } };
  }
}

app.http("entraSyncRun", { methods: ["POST"], authLevel: "anonymous", route: "hub/entra/sync", handler: entraSyncRun });
