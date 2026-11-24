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
import { enabledDestinations, runConnector } from "../shared/connectors";
import { runEntraSyncJob } from "../shared/entra/runner";
import { HUB_SYNC_CRON, HUB_NIGHTLY_CRON } from "../shared/schedules";

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

/** Drains the delivery queue of every enabled destination (CLEARVIEW_ENABLED ...), one after another. A connector failure is
 *  logged and never fails the sync or the next destination. */
async function deliverAll(ctx: InvocationContext, trigger: "after-sync" | "after-nightly"): Promise<void> {
  for (const destination of enabledDestinations()) {
    try { await runConnector(destination, ctx, trigger); }
    catch (e: any) { ctx.error(`[${destination}] ${trigger} run error: ${String(e?.message ?? "error").replace(/\?.*$/, "")}`); }
  }
}

/** Sync, then drain each enabled destination's queue and refresh the Entra proposals (ENTRA_SYNC_ENABLED). A connector or
 *  Entra failure never fails the sync. */
export async function runSyncThenDeliver(ctx: InvocationContext, trigger: string): Promise<SyncResult> {
  const result = await runSync(ctx, trigger);
  if (result.status === "succeeded" || result.status === "partial") {
    await deliverAll(ctx, "after-sync");
    if (config.entraSyncEnabled) {
      try { await runEntraSyncJob(ctx, "after-sync"); }
      catch (e: any) { ctx.error(`[entra] after-sync run error: ${String(e?.message ?? "error").replace(/\?.*$/, "")}`); }
    }
  }
  return result;
}

// ---- Scheduled: 5x daily. Times are UTC (Flex Consumption has no time zone setting):
//      09:50, 12:50, 15:50, 18:50, 21:50 UTC = 4:50, 7:50, 10:50, 13:50, 16:50 Toronto in winter (EST), one hour later
//      in summer (EDT). Chosen 2026-11-23 to run 10 minutes BEFORE Flexspring, which sends to Clearview at 5:00, 8:00,
//      11:00 and 14:00 Toronto time, so that during the parallel run our connector is the first to write. When the
//      clocks change the runs fall 50 minutes AFTER Flexspring unless the hours are moved one earlier.
app.timer("hubSyncTimer", {
  schedule: HUB_SYNC_CRON,              // "0 50 9,12,15,18,21 * * *" (src/shared/schedules.ts)
  handler: async (_timer: Timer, ctx: InvocationContext) => {
    if (!config.hubSyncEnabled) { ctx.log("[hub-sync] disabled (HUB_SYNC_ENABLED is not 'true') - skipping"); return; }
    await runSyncThenDeliver(ctx, "timer");
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
      const result = await runSyncThenDeliver(ctx, "manual");
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

/** Nightly, then drain each enabled destination's queue: the nightly rebuilds events for employees the intraday sync
 *  missed, and those should not wait for the hourly connector timers. A connector failure never fails the nightly. */
export async function runNightlyThenDeliver(ctx: InvocationContext, trigger: string): Promise<NightlyResult> {
  const result = await runNightlyJob(ctx, trigger);
  if (result.status === "succeeded" || result.status === "partial") await deliverAll(ctx, "after-nightly");
  return result;
}

// 06:15 UTC = 2:15 AM Toronto in summer (EDT), 1:15 AM in winter (EST).
app.timer("hubNightlyTimer", {
  schedule: HUB_NIGHTLY_CRON,           // "0 15 6 * * *"
  handler: async (_t: Timer, ctx: InvocationContext) => {
    if (!config.hubSyncEnabled) { ctx.log("[hub-nightly] disabled (HUB_SYNC_ENABLED is not 'true') - skipping"); return; }
    await runNightlyThenDeliver(ctx, "timer");
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
      const result = await runNightlyThenDeliver(ctx, "manual");
      return { status: result.status === "failed" ? 502 : 200, jsonBody: result };
    } catch (e: any) {
      ctx.error(`[hub-nightly] manual run error: ${String(e?.message ?? "error").replace(/\?.*$/, "")}`);
      return { status: 503, jsonBody: { status: "failed", message: "Nightly run could not start (database or configuration)" } };
    }
  }
});
