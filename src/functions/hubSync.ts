import { app, HttpRequest, HttpResponseInit, InvocationContext, Timer } from "@azure/functions";
import { config } from "../shared/config";
import { ukgGetAll } from "../shared/ukg";
import { openHubPool } from "../shared/sql";
import { SqlHubStore } from "../shared/hubStore";
import { runIntradaySync, runNightly, SyncResult, NightlyResult, UkgSource } from "../shared/hubSync";
import { ContactConfig } from "../shared/contacts";

const contactConfig = (): ContactConfig => ({
  workDomains: config.hubWorkEmailDomains, emailFields: config.hubEmailFields,
  workPhoneFields: config.hubWorkPhoneFields, companyPhoneFields: config.hubCompanyPhoneFields
});
import { authorize, describeCaller, Roles, Scopes } from "../shared/auth";

const ukgSource: UkgSource = { getAll: (path, perPage) => ukgGetAll(path, perPage, 500) };

async function runSync(ctx: InvocationContext, trigger: string): Promise<SyncResult> {
  const pool = await openHubPool();
  try {
    const result = await runIntradaySync(new SqlHubStore(pool), ukgSource, {
      lookbackMonths: config.hubLookbackMonths,
      contacts: contactConfig(),
      log: (m) => ctx.log(`[hub-sync] ${m}`)          // counts and IDs only; never personal data
    });
    ctx.log(`[hub-sync] ${trigger}: ${JSON.stringify(result)}`);
    if (result.status === "failed") ctx.error(`[hub-sync] failed: ${result.message}`);
    return result;
  } finally {
    await pool.close().catch(() => {});
  }
}

// ---- Scheduled: 4x daily. Times are UTC (Flex Consumption):
//      10:05, 14:05, 18:05, 22:05 UTC = 6/10/14/18 ET in summer (EDT), one hour earlier in winter (EST).
app.timer("hubSyncTimer", {
  schedule: "0 5 10,14,18,22 * * *",
  handler: async (_timer: Timer, ctx: InvocationContext) => {
    if (!config.hubSyncEnabled) { ctx.log("[hub-sync] disabled (HUB_SYNC_ENABLED is not 'true') - skipping"); return; }
    await runSync(ctx, "timer");
  }
});

// ---- Manual run (testing / catch-up): GET or POST /api/hub/sync
//      Requires role Summary.Admin with scope Employees.Summary.Write, or app role Integration.Run (Logic Apps).
//      Runs even when the timer is disabled, so it can be tested before switching the schedule on.
app.http("hubSyncRun", {
  methods: ["GET", "POST"], authLevel: "anonymous", route: "hub/sync",
  handler: async (req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> => {
    const auth = authorize(req, { scope: Scopes.SummaryWrite, anyRole: [Roles.SummaryAdmin], appRole: Roles.IntegrationRun });
    if (!auth.ok) return auth.response!;
    ctx.log(`[hub-sync] manual run by ${describeCaller(auth.caller!)}`);
    try {
      const result = await runSync(ctx, "manual");
      return { status: result.status === "failed" ? 502 : 200, jsonBody: result };
    } catch (e: any) {
      ctx.error(`[hub-sync] manual run error: ${String(e?.message ?? "error").replace(/\?.*$/, "")}`);
      return { status: 503, jsonBody: { status: "failed", message: "Sync could not start (database or configuration)" } };
    }
  }
});

// ================= Nightly: snapshot, reconciliation, contacts refresh, monthly purge, stale-sync alert =================
async function runNightlyJob(ctx: InvocationContext, trigger: string): Promise<NightlyResult> {
  const pool = await openHubPool();
  try {
    const result = await runNightly(new SqlHubStore(pool), ukgSource, {
      lookbackMonths: config.hubLookbackMonths, contacts: contactConfig(), storeBirthday: config.hubStoreBirthday,
      log: (m) => ctx.log(`[hub-nightly] ${m}`)                // counts only; never personal data
    });
    ctx.log(`[hub-nightly] ${trigger}: ${JSON.stringify(result)}`);
    if (result.status === "failed") ctx.error(`[hub-sync] failed: nightly - ${result.message}`);
    if (result.staleAlert) ctx.error(`[hub-sync] failed: no successful intraday sync in the last 24 hours`);
    return result;
  } finally {
    await pool.close().catch(() => {});
  }
}

// 06:15 UTC = 2:15 AM Toronto in summer (EDT), 1:15 AM in winter (EST).
app.timer("hubNightlyTimer", {
  schedule: "0 15 6 * * *",
  handler: async (_t: Timer, ctx: InvocationContext) => {
    if (!config.hubSyncEnabled) { ctx.log("[hub-nightly] disabled (HUB_SYNC_ENABLED is not 'true') - skipping"); return; }
    await runNightlyJob(ctx, "timer");
  }
});

// Manual nightly run: GET/POST /api/hub/nightly (Summary.Admin + Employees.Summary.Write, or app role Integration.Run)
app.http("hubNightlyRun", {
  methods: ["GET", "POST"], authLevel: "anonymous", route: "hub/nightly",
  handler: async (req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> => {
    const auth = authorize(req, { scope: Scopes.SummaryWrite, anyRole: [Roles.SummaryAdmin], appRole: Roles.IntegrationRun });
    if (!auth.ok) return auth.response!;
    ctx.log(`[hub-nightly] manual run by ${describeCaller(auth.caller!)}`);
    try {
      const result = await runNightlyJob(ctx, "manual");
      return { status: result.status === "failed" ? 502 : 200, jsonBody: result };
    } catch (e: any) {
      ctx.error(`[hub-nightly] manual run error: ${String(e?.message ?? "error").replace(/\?.*$/, "")}`);
      return { status: 503, jsonBody: { status: "failed", message: "Nightly run could not start (database or configuration)" } };
    }
  }
});
