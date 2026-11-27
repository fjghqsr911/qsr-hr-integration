// Settings come from App Settings in Azure (UKG values via Key Vault references)
// and from local.settings.json when running locally.

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required setting: ${name}`);
  return v;
}

function list(name: string, fallback = ""): string[] {
  return (process.env[name] ?? fallback).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}

/** Prefix of a Key Vault reference the platform has not resolved: the setting is then present but unusable. */
export const KEY_VAULT_PREFIX = "@Microsoft.KeyVault(";

/** The trimmed value, or null when the setting is unset, blank or an unresolved Key Vault reference. */
export function presentValue(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return !t || t.startsWith(KEY_VAULT_PREFIX) ? null : t;
}

/** True when running in Azure (App Service / Functions sets WEBSITE_INSTANCE_ID). */
export const inAzure = () => !!process.env.WEBSITE_INSTANCE_ID;

export const config = {
  // ---- UKG ----
  get ukgBaseUrl() { return required("UKG_BASE_URL").replace(/\/+$/, ""); },
  get ukgUsername() { return required("UKG_USERNAME"); },
  get ukgPassword() { return required("UKG_PASSWORD"); },
  get ukgCustomerApiKey() { return required("UKG_CUSTOMER_API_KEY"); },

  // ---- Access control ----
  /** Scopes granted to direct browser sessions at the Function App URL (no client app, no scp claim).
   *  Default: summary only. Set to "none" in production to disable direct-browser data access. */
  get selfClientScopes() {
    return list("SELF_CLIENT_SCOPES", "Employees.Summary.Read").filter(s => s.toLowerCase() !== "none");
  },

  /** Optional defence-in-depth allow-list of client app IDs (Easy Auth enforces this too). Empty = rely on Easy Auth. */
  get allowedClientIds() { return list("ALLOWED_CLIENT_IDS").map(s => s.toLowerCase()); },

  // ---- Local development only (ignored in Azure) ----
  get localDevAuth() { return process.env.ALLOW_LOCAL_NO_AUTH === "true" && !inAzure(); },
  get localRoles()  { return list("LOCAL_ROLES", "Summary.Read"); },
  get localScopes() { return list("LOCAL_SCOPES", "Employees.Summary.Read"); },

  // ---- Workforce Data Hub (Azure SQL via managed identity; no passwords) ----
  get hubSqlServer() { return required("HUB_SQL_SERVER"); },              // e.g. sql-qsr-prod-cc.database.windows.net
  get hubSqlDatabase() { return required("HUB_SQL_DATABASE"); },          // e.g. sqldb-hrint
  get hubLookbackMonths() { return parseInt(process.env.HUB_LOOKBACK_MONTHS ?? "24", 10); },
  /** Seconds between the two reads of UKG's employee-changes feed in an intraday sync (0 = one read; at most 300).
   *  UKG releases changes only when the feed is called and the releasing call does not get them (hubSync.ts). */
  get hubFeedSecondReadSeconds() {
    const n = parseInt(process.env.HUB_FEED_SECOND_READ_SECONDS ?? "90", 10);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 300) : 90;
  },
  /** Wait before a scheduled intraday sync calls the feed, in seconds per position in the day (0 = no wait, at most
   *  300). See feedStaggerMs in schedules.ts. */
  get hubFeedStaggerSeconds() {
    const n = parseInt(process.env.HUB_FEED_STAGGER_SECONDS ?? "180", 10);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 300) : 180;
  },
  /** Kill switch for the scheduled sync. Off unless explicitly "true". */
  get hubSyncEnabled() { return (process.env.HUB_SYNC_ENABLED ?? "").toLowerCase() === "true"; },

  // ---- Contact details (stored only for active / on-leave employees; sensitive tier) ----
  /** Email domains treated as WORK email; any other address is treated as PERSONAL. */
  get hubWorkEmailDomains() { return list("HUB_WORK_EMAIL_DOMAINS", "qsrgroup.ca").map(s => s.toLowerCase()); },
  /** UKG fields scanned for email addresses (any of the sources: change feed, person details, employment details). */
  get hubEmailFields() { return list("HUB_EMAIL_FIELDS", "emailAddress,alternateEmailAddress,emailAddressAlternate"); },
  /** UKG fields for work phone, in priority order. */
  get hubWorkPhoneFields() { return list("HUB_WORK_PHONE_FIELDS", "workPhone,workPhoneNumber"); },
  /** UKG fields for company phone, in priority order. Empty until confirmed with ukg-contact-fields.ps1. */
  get hubCompanyPhoneFields() { return list("HUB_COMPANY_PHONE_FIELDS", "").filter(s => s.toLowerCase() !== "none"); },
  /** Store birth month + day (never the year) with contacts. On unless "false"; "false" clears them at the next nightly run. */
  get hubStoreBirthday() { return (process.env.HUB_STORE_BIRTHDAY ?? "").trim().toLowerCase() !== "false"; },

  // ---- Clearview connector (phase 4) ----
  /** Clearview API base (prod). UAT: https://api-uat-cv-api-marketplace.azurewebsites.net */
  get clearviewBaseUrl() { return (process.env.CLEARVIEW_BASE_URL ?? "https://api.clearviewconnect.com").trim().replace(/\/+$/, ""); },
  /** UKG companies sent to Clearview (one Clearview organization and one authorizationKey each). */
  get clearviewCompanies() { return list("CLEARVIEW_COMPANIES", "SWN6T,SWNGK").map(s => s.toUpperCase()); },
  /** oauth (default): self-service API connection, OAuth2 client credentials per organization. key: the partner model (authorizationKey). */
  get clearviewAuthMode(): "oauth" | "key" { return (process.env.CLEARVIEW_AUTH_MODE ?? "").trim().toLowerCase() === "key" ? "key" : "oauth"; },
  /** OAuth mode: the Access Token URL and Scope from the Clearview Connections page (shared by both organizations). */
  get clearviewTokenUrl() { return presentValue(process.env.CLEARVIEW_TOKEN_URL); },
  get clearviewScope() { return presentValue(process.env.CLEARVIEW_SCOPE); },
  /** OAuth mode: client id and secret per company (CLEARVIEW_CLIENT_ID_<COMPANY>, CLEARVIEW_CLIENT_SECRET_<COMPANY>, Key Vault);
   *  null when unset or still an unresolved Key Vault reference. */
  clearviewClientId(company: string): string | null { return presentValue(process.env[`CLEARVIEW_CLIENT_ID_${company.toUpperCase()}`]); },
  clearviewClientSecret(company: string): string | null { return presentValue(process.env[`CLEARVIEW_CLIENT_SECRET_${company.toUpperCase()}`]); },
  /** Optional, set by hand from the Clearview page: when the OAuth secret expires (ISO date). Diagnostics warns 60 days before. */
  clearviewSecretExpires(company: string): string | null {
    const v = presentValue(process.env[`CLEARVIEW_SECRET_EXPIRES_${company.toUpperCase()}`]);
    return v && !Number.isNaN(Date.parse(v)) ? v : null;
  },
  /** Key mode: authorizationKey for one company (CLEARVIEW_AUTH_KEY_<COMPANY>); null when unset or still an unresolved Key Vault reference. */
  clearviewAuthKey(company: string): string | null { return presentValue(process.env[`CLEARVIEW_AUTH_KEY_${company.toUpperCase()}`]); },
  /** Timer and after-sync runs. Off unless explicitly "true"; manual runs are always allowed. */
  get clearviewEnabled() { return (process.env.CLEARVIEW_ENABLED ?? "").toLowerCase() === "true"; },
  /** Kill switch: false = every store behaves as shadow, nothing is sent. */
  get clearviewLiveEnabled() { return (process.env.CLEARVIEW_LIVE_ENABLED ?? "").toLowerCase() === "true"; },
  /** UKG job codes never sent (MM = head office / multi-unit). */
  get clearviewExcludedJobs() { return list("CLEARVIEW_EXCLUDED_JOBS", "MM").map(s => s.toUpperCase()); },
  /** Clearview termination reason id used for every termination unless ref.destination_codes maps the category. */
  get clearviewTerminationReasonId() { return parseInt(process.env.CLEARVIEW_TERMINATION_REASON_ID ?? "13078", 10); },
  get clearviewMaxPerRun() { return parseInt(process.env.CLEARVIEW_MAX_PER_RUN ?? "200", 10); },
  get clearviewWaitingAlertDays() { return parseInt(process.env.CLEARVIEW_WAITING_ALERT_DAYS ?? "5", 10); },
  get clearviewTimeoutMs() { return parseInt(process.env.CLEARVIEW_TIMEOUT_MS ?? "20000", 10); },
  /** Days a masked shadow payload is kept in out.shadow_payloads. */
  get hubShadowRetentionDays() { return parseInt(process.env.HUB_SHADOW_RETENTION_DAYS ?? "30", 10); },

  // ---- Rosnet connector (phase 6): Employee Data Transfer API -> NCR HR Bridge -> Aloha, company SWN1U ----
  /** EDT API base, no default. Production https://wfmt-api.rosnet.com; the sandbox (https://wfmt-api.rosnetqa.com) is for
   *  local testing with synthetic data only: in Azure a sandbox host is never called. */
  get rosnetBaseUrl() { const v = presentValue(process.env.ROSNET_BASE_URL); return v ? v.replace(/\/+$/, "") : null; },
  /** Token endpoint. Production https://iam.rosnet.com/connect/token; sandbox https://iam.rosnetqa.com/connect/token. */
  get rosnetTokenUrl() { return presentValue(process.env.ROSNET_TOKEN_URL); },
  get rosnetScope() { return presentValue(process.env.ROSNET_SCOPE) ?? "wfm.write"; },
  get rosnetApiVersion() { return presentValue(process.env.ROSNET_API_VERSION) ?? "1.0"; },
  /** One OAuth client for the company (secret via Key Vault); null when unset or still an unresolved Key Vault reference. */
  get rosnetClientId() { return presentValue(process.env.ROSNET_CLIENT_ID); },
  get rosnetClientSecret() { return presentValue(process.env.ROSNET_CLIENT_SECRET); },
  /** Optional, set by hand: when the OAuth secret expires (ISO date). Diagnostics warns 60 days before. */
  get rosnetSecretExpires(): string | null {
    const v = presentValue(process.env.ROSNET_SECRET_EXPIRES);
    return v && !Number.isNaN(Date.parse(v)) ? v : null;
  },
  /** Sent on every request: Rosnet's Cloudflare zone challenges requests without a descriptive User-Agent. */
  get rosnetUserAgent() { return presentValue(process.env.ROSNET_USER_AGENT) ?? "QUICKWEN-UKG-EDT-Integration/1.0"; },
  /** Rosnet client code (GET /Location and the token's client_clientCode claim). */
  get rosnetClientCode() { return presentValue(process.env.ROSNET_CLIENT_CODE) ?? "QUICKWEN"; },
  /** UKG companies sent to Rosnet. */
  get rosnetCompanies() { return list("ROSNET_COMPANIES", "SWN1U").map(s => s.toUpperCase()); },
  /** Termination code used when ref.destination_codes has no row for the category (1 = Termination). */
  get rosnetTermCode() { return parseInt(process.env.ROSNET_TERM_CODE ?? "1", 10); },
  /** false (default): ssn is sent as null, which Rosnet accepts. true: the real SIN is sent. */
  get rosnetSendSin() { return (process.env.ROSNET_SEND_SIN ?? "").toLowerCase() === "true"; },
  /** Timer and after-sync runs. Off unless explicitly "true"; manual runs are always allowed. */
  get rosnetEnabled() { return (process.env.ROSNET_ENABLED ?? "").toLowerCase() === "true"; },
  /** Kill switch: false = every store behaves as shadow, nothing is sent. */
  get rosnetLiveEnabled() { return (process.env.ROSNET_LIVE_ENABLED ?? "").toLowerCase() === "true"; },
  /** A live delivery takes 5 to 15 s (Rosnet reads and writes are slow), so a run takes fewer than Clearview does. */
  get rosnetMaxPerRun() { return parseInt(process.env.ROSNET_MAX_PER_RUN ?? "60", 10); },
  get rosnetWaitingAlertDays() { return parseInt(process.env.ROSNET_WAITING_ALERT_DAYS ?? "5", 10); },
  get rosnetTimeoutMs() { return parseInt(process.env.ROSNET_TIMEOUT_MS ?? "90000", 10); },

  // ---- Entra ID sync (Microsoft Graph via the Function App managed identity) ----
  /** Timer and after-sync Entra snapshot / compare runs. Off unless explicitly "true"; manual runs are always allowed. */
  get entraSyncEnabled() { return (process.env.ENTRA_SYNC_ENABLED ?? "").toLowerCase() === "true"; },
  /** Kill switch for every Graph write (apply, manual group members). Off unless explicitly "true"; accept still records. */
  get entraWriteEnabled() { return (process.env.ENTRA_WRITE_ENABLED ?? "").toLowerCase() === "true"; },
  /** Account domains whose Entra users are snapshotted and linked to employees by work email. */
  get entraAccountDomains() { return list("ENTRA_ACCOUNT_DOMAINS", "qsrgroup.ca").map(s => s.toLowerCase().replace(/^@/, "")); },
  /** Microsoft Graph base URL (v1.0). */
  get entraGraphBase() { return (process.env.ENTRA_GRAPH_BASE ?? "https://graph.microsoft.com/v1.0").trim().replace(/\/+$/, ""); },
  /** officeLocation for head office staff; unset = officeLocation is left alone for them. */
  get entraHeadOfficeCity() { return presentValue(process.env.ENTRA_HEAD_OFFICE_CITY); },
  /** Maximum ids per POST /api/hub/entra/proposals/decide and per manual group member call. */
  get entraMaxDecide() { return parseInt(process.env.ENTRA_MAX_DECIDE ?? "200", 10); },

  // ---- Audit log (Azure Table Storage, via managed identity) ----
  get auditStorageAccount() { return (process.env.AUDIT_STORAGE_ACCOUNT ?? "").trim(); },
  get auditTable() { return (process.env.AUDIT_TABLE ?? "AccessAudit").trim(); }
};
