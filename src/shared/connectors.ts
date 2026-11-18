import { InvocationContext } from "@azure/functions";
import { config, inAzure } from "./config";
import { openHubPool } from "./sql";
import { findEmployment, findPerson, dateOnly } from "./employees";
import { Connector, RunResult, UkgSensitiveSource, runDeliveries } from "./delivery";
import { SqlDeliveryStore } from "./deliveryStore";
import { ClearviewClient, ClearviewCredential } from "./clearview/client";
import { ClearviewConnector } from "./clearview/connector";
import { MapperConfig } from "./clearview/mapper";
import { DiscoverReport, discover } from "./clearview/discover";
import { RosnetClient, isSandboxHost } from "./rosnet/client";
import { RosnetConnector } from "./rosnet/connector";
import { RosnetMapperConfig } from "./rosnet/mapper";
import { RosnetDiscoverReport, discoverRosnet } from "./rosnet/discover";

/*
  Wires a destination's connector to the hub: pool, SQL delivery store, client with the per-company credentials, the UKG
  send-time reads, and the generic runner. Each destination has one REGISTRY entry (its switches, limits and how to build
  its connector); runConnector is the same for all. Log lines go out as [<destination>] ...; the runner's own [delivery]
  lines are passed through unchanged (they are what the alerts match on).

  Billing guard: Clearview bills each API connection from its first call, so the client only gets credentials when
  CLEARVIEW_ENABLED is true. With it off, every run is shadow and discovery / the diagnostics probe refuse to call.
*/

export type Destination = "clearview" | "rosnet";
export const isDestination = (v: unknown): v is Destination => v === "clearview" || v === "rosnet";

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

// ---------------------------------------------------------------- Rosnet ----------------------------------------------------------------
export interface RosnetCredentialsReport {
  status: "present" | "partial" | "missing";      // base URL, token URL, client id and secret all set and resolved
  sandbox: boolean;                               // a rosnetqa.com host is configured
  callable: boolean;                              // present, and not the sandbox while running in Azure
  secretExpires: string | null;
}

export function rosnetCredentials(): RosnetCredentialsReport {
  const parts = [config.rosnetBaseUrl, config.rosnetTokenUrl, config.rosnetClientId, config.rosnetClientSecret];
  const n = parts.filter(Boolean).length;
  const status = n === 0 ? "missing" : n === parts.length ? "present" : "partial";
  const sandbox = isSandboxHost(config.rosnetBaseUrl) || isSandboxHost(config.rosnetTokenUrl);
  return { status, sandbox, callable: status === "present" && !(sandbox && inAzure()), secretExpires: config.rosnetSecretExpires };
}

/** The Rosnet client. It has credentials only when all four settings are present, and never for the SANDBOX while running
 *  in Azure: the deployed app handles real employee data, which must not reach the sandbox (every store then runs as shadow). */
export function buildRosnetClient(opts: { log?: (m: string) => void } = {}): RosnetClient {
  const c = rosnetCredentials();
  const credential = c.callable ? { tokenUrl: config.rosnetTokenUrl!, scope: config.rosnetScope, clientId: config.rosnetClientId!, clientSecret: config.rosnetClientSecret! } : null;
  return new RosnetClient({ baseUrl: config.rosnetBaseUrl, apiVersion: config.rosnetApiVersion, credential, timeoutMs: config.rosnetTimeoutMs,
                            userAgent: config.rosnetUserAgent, allowSandboxWrites: !inAzure(), log: opts.log ?? (m => console.log(m)) });
}

export const rosnetMapperConfig = (): RosnetMapperConfig =>
  ({ companies: config.rosnetCompanies, clientCode: config.rosnetClientCode, termCode: config.rosnetTermCode, sendSin: config.rosnetSendSin, minAge: 15 });

const num = (v: any): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

/** Send-time reads from UKG. Values go straight to the connector's plan() and are never logged. */
export const ukgSensitive: UkgSensitiveSource = {
  async person(id) {
    const { record: p } = await findPerson(id);
    return p ? { sin: p.nationalId || p.ssn || null, dateOfBirth: dateOnly(p.dateOfBirth), email: p.emailAddress ?? null } : null;
  },
  async pay(id, companyId) {
    const { record: e } = await findEmployment(id, companyId);
    return e ? { salaryOrHourly: e.salaryOrHourly ?? null, hourlyPayRate: num(e.hourlyPayRate), annualSalary: num(e.annualSalary) } : null;
  }
};

interface Logger { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void; }

const logger = (ctx: InvocationContext, prefix: string): Logger => ({
  log: (m: string) => ctx.log(m.startsWith("[delivery]") || m.startsWith(prefix) ? m : `${prefix} ${m}`),
  warn: (m: string) => ctx.warn(m.startsWith("[delivery]") ? m : `${prefix} ${m}`),
  error: (m: string) => ctx.error(m.startsWith("[delivery]") ? m : `${prefix} ${m}`)
});

/** What the generic wiring needs to know about one destination. Settings are read at run time, never cached. */
interface DestinationEntry {
  prefix: string;                         // log prefix, "[clearview]"
  enabled: () => boolean;                 // timer and after-sync / after-nightly runs
  liveEnabled: () => boolean;             // kill switch: false = every store behaves as shadow
  liveSettingName: string;                // named in the runner's "live stores run as shadow" warning
  maxPerRun: () => number;
  waitingAlertDays: () => number;
  build: (l: Logger) => Connector;        // once per run
}

const REGISTRY: Partial<Record<Destination, DestinationEntry>> = {
  clearview: {
    prefix: "[clearview]", enabled: () => config.clearviewEnabled, liveEnabled: () => config.clearviewLiveEnabled, liveSettingName: "CLEARVIEW_LIVE_ENABLED",
    maxPerRun: () => config.clearviewMaxPerRun, waitingAlertDays: () => config.clearviewWaitingAlertDays,
    build: l => {
      if (!config.clearviewEnabled && clearviewCredentials().status !== "missing")
        l.warn("CLEARVIEW_ENABLED is not true: Clearview is not called (the first call starts billing); every store runs as shadow");
      return new ClearviewConnector(buildClearviewClient({ log: l.log }), clearviewMapperConfig(), l.log);
    }
  },
  rosnet: {
    prefix: "[rosnet]", enabled: () => config.rosnetEnabled, liveEnabled: () => config.rosnetLiveEnabled, liveSettingName: "ROSNET_LIVE_ENABLED",
    maxPerRun: () => config.rosnetMaxPerRun, waitingAlertDays: () => config.rosnetWaitingAlertDays,
    build: l => {
      const c = rosnetCredentials();
      if (c.status === "present" && !c.callable) l.warn("ROSNET_BASE_URL / ROSNET_TOKEN_URL point at the sandbox: the deployed app never calls it; every store runs as shadow");
      return new RosnetConnector(buildRosnetClient({ log: l.log }), rosnetMapperConfig(), l.log);
    }
  }
};

/** Destinations whose timer / after-sync runs are switched on, in the order they are drained after a sync. */
export function enabledDestinations(): Destination[] {
  return (Object.keys(REGISTRY) as Destination[]).filter(d => REGISTRY[d]!.enabled());
}

export async function runConnector(destination: Destination, ctx: InvocationContext, trigger: string): Promise<RunResult> {
  const entry = REGISTRY[destination];
  if (!entry) throw new Error(`destination ${destination} is not configured`);
  const pool = await openHubPool();
  try {
    const l = logger(ctx, entry.prefix);
    const connector = entry.build(l);
    const result = await runDeliveries(new SqlDeliveryStore(pool, destination), connector, ukgSensitive, {
      liveEnabled: entry.liveEnabled(), liveSettingName: entry.liveSettingName, maxPerRun: entry.maxPerRun(), waitingAlertDays: entry.waitingAlertDays(),
      shadowRetentionDays: config.hubShadowRetentionDays, ...l
    });
    ctx.log(`${entry.prefix} ${trigger}: ${JSON.stringify(result)}`);
    if (result.status === "failed") ctx.error(`${entry.prefix} failed: ${result.message}`);
    return result;
  } finally {
    await pool.close().catch(() => {});
  }
}

/** Rosnet discovery: read-only against Rosnet; writes store pairs / xref rows to the hub unless the host is the sandbox. */
export async function runRosnetDiscovery(ctx: InvocationContext, what: "codes" | "employees"): Promise<RosnetDiscoverReport> {
  if (!rosnetCredentials().callable) throw new Error("Rosnet credentials are not configured (or point at the sandbox in Azure)");
  const pool = await openHubPool();
  try {
    const store = new SqlDeliveryStore(pool, "rosnet");
    const log = (m: string) => ctx.log(m.startsWith("[rosnet]") ? m : `[rosnet] ${m}`);
    const report = await discoverRosnet(buildRosnetClient({ log }), store, { companies: config.rosnetCompanies, what, log });
    ctx.log(`[rosnet] discover ${what}: ${report.error ? "error" : "ok"} locations=${report.locations.rosnet} paired=${report.locations.paired} written=${report.written} sandbox=${report.sandbox}`);
    return report;
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
