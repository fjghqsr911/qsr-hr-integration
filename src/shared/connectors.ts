import { InvocationContext } from "@azure/functions";
import { config } from "./config";
import { openHubPool } from "./sql";
import { findEmployment, findPerson, dateOnly } from "./employees";
import { RunResult, UkgSensitiveSource, runDeliveries } from "./delivery";
import { SqlDeliveryStore } from "./deliveryStore";
import { ClearviewClient, ClearviewCredential } from "./clearview/client";
import { ClearviewConnector } from "./clearview/connector";
import { MapperConfig } from "./clearview/mapper";
import { DiscoverReport, discover } from "./clearview/discover";

/*
  Wires a destination's connector to the hub: pool, SQL delivery store, client with the per-company credentials, the UKG
  send-time reads, and the generic runner. Log lines go out as [clearview] ...; the runner's own [delivery] lines are
  passed through unchanged (they are what the alerts match on).

  Billing guard: Clearview bills each API connection from its first call, so the client only gets credentials when
  CLEARVIEW_ENABLED is true. With it off, every run is shadow and discovery / the diagnostics probe refuse to call.
*/

export type Destination = "clearview";

export interface CredentialsReport {
  mode: "oauth" | "key";
  status: "present" | "partial" | "missing";
  companies: Record<string, boolean>;                 // settings present and resolved per company
  secretExpires: Record<string, string | null>;       // CLEARVIEW_SECRET_EXPIRES_<COMPANY> per company (ISO date or null)
}

/** The credential for one company in the configured mode, or null when any of its settings is missing or unresolved. */
export function companyCredential(company: string): ClearviewCredential | null {
  if (config.clearviewAuthMode === "key") {
    const key = config.clearviewAuthKey(company);
    return key ? { mode: "key", key } : null;
  }
  const tokenUrl = config.clearviewTokenUrl, clientId = config.clearviewClientId(company), clientSecret = config.clearviewClientSecret(company);
  return tokenUrl && clientId && clientSecret ? { mode: "oauth", tokenUrl, scope: config.clearviewScope, clientId, clientSecret } : null;
}

export function clearviewCredentials(): CredentialsReport {
  const companies: Record<string, boolean> = {}, secretExpires: Record<string, string | null> = {};
  for (const c of config.clearviewCompanies) { companies[c] = companyCredential(c) !== null; secretExpires[c] = config.clearviewSecretExpires(c); }
  const present = Object.values(companies).filter(Boolean).length;
  return { mode: config.clearviewAuthMode, status: present === 0 ? "missing" : present === Object.keys(companies).length ? "present" : "partial", companies, secretExpires };
}

/** A client for every company whose credentials are present. Without CLEARVIEW_ENABLED it has no credentials at all,
 *  so nothing can call Clearview (the first call starts billing). */
export function buildClearviewClient(opts: { log?: (m: string) => void } = {}): ClearviewClient {
  const credentials = new Map<string, ClearviewCredential>();
  if (config.clearviewEnabled) for (const c of config.clearviewCompanies) { const cred = companyCredential(c); if (cred) credentials.set(c, cred); }
  return new ClearviewClient({ baseUrl: config.clearviewBaseUrl, credentials, timeoutMs: config.clearviewTimeoutMs, log: opts.log ?? (m => console.log(m)) });
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
  log: (m: string) => ctx.log(m.startsWith("[delivery]") || m.startsWith("[clearview]") ? m : `${prefix} ${m}`),
  warn: (m: string) => ctx.warn(m.startsWith("[delivery]") ? m : `${prefix} ${m}`),
  error: (m: string) => ctx.error(m.startsWith("[delivery]") ? m : `${prefix} ${m}`)
});

export async function runConnector(destination: Destination, ctx: InvocationContext, trigger: string): Promise<RunResult> {
  if (destination !== "clearview") throw new Error(`unknown destination ${destination}`);
  const pool = await openHubPool();
  try {
    const l = logger(ctx, "[clearview]");
    if (!config.clearviewEnabled && clearviewCredentials().status !== "missing")
      l.warn("CLEARVIEW_ENABLED is not true: Clearview is not called (the first call starts billing); every store runs as shadow");
    const connector = new ClearviewConnector(buildClearviewClient({ log: l.log }), clearviewMapperConfig(), l.log);
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
  if (!config.clearviewEnabled) throw new Error("CLEARVIEW_ENABLED is not true: discovery would make the first billable Clearview call");
  const pool = await openHubPool();
  try {
    const store = new SqlDeliveryStore(pool, "clearview");
    const log = (m: string) => ctx.log(m.startsWith("[clearview]") ? m : `[clearview] ${m}`);
    const report = await discover(buildClearviewClient({ log }), store, { companies: config.clearviewCompanies, what, log });
    ctx.log(`[clearview] discover ${what}: ${report.organizations.map(o => `${o.company}=${o.error ? "error" : "ok"}`).join(" ")} stores paired=${report.stores.paired} unpaired_hub=${report.stores.unpairedHub.length}`);
    return report;
  } finally {
    await pool.close().catch(() => {});
  }
}
