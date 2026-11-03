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

  // ---- Audit log (Azure Table Storage, via managed identity) ----
  get auditStorageAccount() { return (process.env.AUDIT_STORAGE_ACCOUNT ?? "").trim(); },
  get auditTable() { return (process.env.AUDIT_TABLE ?? "AccessAudit").trim(); }
};
