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

  // ---- Audit log (Azure Table Storage, via managed identity) ----
  get auditStorageAccount() { return (process.env.AUDIT_STORAGE_ACCOUNT ?? "").trim(); },
  get auditTable() { return (process.env.AUDIT_TABLE ?? "AccessAudit").trim(); }
};
