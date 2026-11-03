import { InvocationContext } from "@azure/functions";
import { config } from "./config";
import { openHubPool } from "./sql";
import { findEmployment, findPerson, dateOnly } from "./employees";
import { RunResult, UkgSensitiveSource, runDeliveries } from "./delivery";
import { SqlDeliveryStore } from "./deliveryStore";
import { ClearviewClient } from "./clearview/client";
import { ClearviewConnector } from "./clearview/connector";
import { MapperConfig } from "./clearview/mapper";
import { DiscoverReport, discover } from "./clearview/discover";

/*
  Wires a destination's connector to the hub: pool, SQL delivery store, client with the per-company keys, the UKG
  send-time reads, and the generic runner. Log lines go out as [clearview] ...; the runner's own [delivery] lines are
  passed through unchanged (they are what the alerts match on).
*/

export type Destination = "clearview";

export function clearviewCredentials(): { status: "present" | "partial" | "missing"; companies: Record<string, boolean> } {
  const companies: Record<string, boolean> = {};
  for (const c of config.clearviewCompanies) companies[c] = config.clearviewAuthKey(c) !== null;
  const present = Object.values(companies).filter(Boolean).length;
  return { status: present === 0 ? "missing" : present === Object.keys(companies).length ? "present" : "partial", companies };
}

export function buildClearviewClient(): ClearviewClient {
  const keys = new Map<string, string>();
  for (const c of config.clearviewCompanies) { const k = config.clearviewAuthKey(c); if (k) keys.set(c, k); }
  return new ClearviewClient({ baseUrl: config.clearviewBaseUrl, keys, timeoutMs: config.clearviewTimeoutMs });
}

export const clearviewMapperConfig = (): MapperConfig =>
  ({ companies: config.clearviewCompanies, excludedJobs: config.clearviewExcludedJobs, terminationReasonId: config.clearviewTerminationReasonId });

const num = (v: any): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

/** Send-time reads from UKG. Values go straight to the connector's plan() and are never logged. */
export const ukgSensitive: UkgSensitiveSource = {
  async person(id) {
    const { record: p } = await findPerson(id);
    return p ? { sin: p.nationalId || p.ssn || null, dateOfBirth: dateOnly(p.dateOfBirth), email: p.emailAddress ?? null } : null;
  },
  async pay(id) {
    const { record: e } = await findEmployment(id);
    return e ? { salaryOrHourly: e.salaryOrHourly ?? null, hourlyPayRate: num(e.hourlyPayRate), annualSalary: num(e.annualSalary) } : null;
  }
};

const logger = (ctx: InvocationContext, prefix: string) => ({
  log: (m: string) => ctx.log(m.startsWith("[delivery]") ? m : `${prefix} ${m}`),
  warn: (m: string) => ctx.warn(m.startsWith("[delivery]") ? m : `${prefix} ${m}`),
  error: (m: string) => ctx.error(m.startsWith("[delivery]") ? m : `${prefix} ${m}`)
});

export async function runConnector(destination: Destination, ctx: InvocationContext, trigger: string): Promise<RunResult> {
  if (destination !== "clearview") throw new Error(`unknown destination ${destination}`);
  const pool = await openHubPool();
  try {
    const l = logger(ctx, "[clearview]");
    const connector = new ClearviewConnector(buildClearviewClient(), clearviewMapperConfig(), l.log);
    const result = await runDeliveries(new SqlDeliveryStore(pool, destination), connector, ukgSensitive, {
      liveEnabled: config.clearviewLiveEnabled, maxPerRun: config.clearviewMaxPerRun, waitingAlertDays: config.clearviewWaitingAlertDays,
      shadowRetentionDays: config.hubShadowRetentionDays, ...l
    });
    ctx.log(`[clearview] ${trigger}: ${JSON.stringify(result)}`);
    if (result.status === "failed") ctx.error(`[clearview] failed: ${result.message}`);
    return result;
  } finally {
    await pool.close().catch(() => {});
  }
}

export async function runDiscovery(ctx: InvocationContext, what: "codes" | "employees"): Promise<DiscoverReport> {
  const pool = await openHubPool();
  try {
    const store = new SqlDeliveryStore(pool, "clearview");
    const report = await discover(buildClearviewClient(), store, { companies: config.clearviewCompanies, what, log: m => ctx.log(`[clearview] ${m}`) });
    ctx.log(`[clearview] discover ${what}: ${report.organizations.map(o => `${o.company}=${o.error ? "error" : "ok"}`).join(" ")} stores paired=${report.stores.paired} unpaired_hub=${report.stores.unpairedHub.length}`);
    return report;
  } finally {
    await pool.close().catch(() => {});
  }
}
