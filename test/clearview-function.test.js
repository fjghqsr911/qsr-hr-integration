/* Clearview endpoints (run / discover): permissions, fail-closed audit, responses; the after-sync hook; config settings. */
const path = require("path");
const { DIST, test, report, assert, eq, stubModule, fakePool } = require("./helpers");

module.exports = async () => {
  // Own stubs: connectors.js (the real one opens a pool and calls Clearview) and the shared sync (so the hook can be driven).
  const audits = [];
  let auditFails = false;
  const connectorRuns = [];
  let connectorResult = () => ({ status: "succeeded", destination: "clearview", claimed: 2, sent: 0, shadow: 2, unchanged: 0, skipped: 0, review: 0, failed: 0, dead: 0, waiting: 0, resolved: 0, purged: 0 });
  const discoveries = [];
  let syncResult = { status: "succeeded", employeesInScope: 1 };
  const realSql = require(path.join(DIST, "shared", "sql.js")).sql;
  // the real credential helpers, grabbed before connectors.js is stubbed for the endpoint tests
  const { companyCredential, clearviewCredentials, buildClearviewClient } = require(path.join(DIST, "shared", "connectors.js"));
  stubModule("shared/sql.js", { getSharedHubPool: async () => fakePool(), resetSharedHubPool() {}, openHubPool: async () => fakePool(), sql: realSql });
  stubModule("shared/audit.js", { writeAudit: async (e) => { if (auditFails) throw new Error("down"); audits.push(e); }, probeAudit: async () => 1 });
  stubModule("shared/connectors.js", {
    runConnector: async (destination, _ctx, trigger) => { connectorRuns.push(`${destination}:${trigger}`); const r = connectorResult(); if (r instanceof Error) throw r; return r; },
    runDiscovery: async (_ctx, what) => { discoveries.push(what); return { what, organizations: [], stores: { paired: 0, written: 0, unpairedHub: [], unpairedClearview: [] }, staleMappings: [] }; }
  });
  stubModule("shared/hubSync.js", { runIntradaySync: async () => syncResult, runNightly: async () => ({ status: "succeeded" }) });
  stubModule("shared/hubStore.js", { SqlHubStore: class {} });
  delete require.cache[require.resolve(path.join(DIST, "functions", "hubSync.js"))];      // reload with the stubs above
  const { runSyncThenDeliver } = require(path.join(DIST, "functions", "hubSync.js"));
  const { clearviewRun, clearviewDiscover } = require(path.join(DIST, "functions", "clearviewConnector.js"));
  const { config, presentValue, KEY_VAULT_PREFIX } = require(path.join(DIST, "shared", "config.js"));

  const principal = (claims) => Buffer.from(JSON.stringify({ claims })).toString("base64");
  const admin = [{ typ: "scp", val: "Employees.Summary.Read Employees.Summary.Write" }, { typ: "roles", val: "Summary.Admin" }, { typ: "preferred_username", val: "fraser@qsrgroup.ca" }, { typ: "azp", val: "monitor-app" }];
  const reader = [{ typ: "scp", val: "Employees.Summary.Read Employees.Summary.Write" }, { typ: "roles", val: "Summary.Read" }];
  const noWriteScope = [{ typ: "scp", val: "Employees.Summary.Read" }, { typ: "roles", val: "Summary.Admin" }];
  const appRun = [{ typ: "idtyp", val: "app" }, { typ: "roles", val: "Integration.Run" }];
  const appOther = [{ typ: "idtyp", val: "app" }, { typ: "roles", val: "Roster.Read.All" }];
  const req = (claims, query = "") => ({ headers: new Headers(claims ? { "x-ms-client-principal": principal(claims) } : {}), params: {}, query: new URLSearchParams(query) });
  const logs = [];
  const ctx = { log(...a) { logs.push(a.join(" ")); }, error(...a) { logs.push("ERROR " + a.join(" ")); }, warn(...a) { logs.push("WARN " + a.join(" ")); } };
  const reset = () => { audits.length = 0; auditFails = false; connectorRuns.length = 0; discoveries.length = 0; logs.length = 0; delete process.env.CLEARVIEW_ENABLED; };
  const CLEARVIEW_KEYS = ["CLEARVIEW_BASE_URL", "CLEARVIEW_COMPANIES", "CLEARVIEW_AUTH_MODE", "CLEARVIEW_TOKEN_URL", "CLEARVIEW_SCOPE", "CLEARVIEW_CLIENT_ID_SWN6T", "CLEARVIEW_CLIENT_SECRET_SWN6T",
    "CLEARVIEW_CLIENT_ID_SWNGK", "CLEARVIEW_CLIENT_SECRET_SWNGK", "CLEARVIEW_SECRET_EXPIRES_SWN6T", "CLEARVIEW_SECRET_EXPIRES_SWNGK", "CLEARVIEW_AUTH_KEY_SWN6T", "CLEARVIEW_AUTH_KEY_SWNGK",
    "CLEARVIEW_ENABLED", "CLEARVIEW_LIVE_ENABLED", "CLEARVIEW_EXCLUDED_JOBS", "CLEARVIEW_MAX_PER_RUN", "CLEARVIEW_WAITING_ALERT_DAYS", "CLEARVIEW_TIMEOUT_MS", "HUB_SHADOW_RETENTION_DAYS", "CLEARVIEW_TERMINATION_REASON_ID"];
  const withEnv = async (values, fn) => {
    const saved = {}; for (const k of CLEARVIEW_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    for (const [k, v] of Object.entries(values)) process.env[k] = v;
    try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };

  await test("clearview run: permissions (Summary.Admin + write scope, or app role Integration.Run); nothing runs or is audited when denied", async () => {
    reset();
    eq((await clearviewRun(req(null), ctx)).status, 401);
    eq((await clearviewRun(req(reader), ctx)).jsonBody.detail, "insufficient_role");
    eq((await clearviewRun(req(noWriteScope), ctx)).jsonBody.detail, "insufficient_scope");
    eq((await clearviewRun(req(appOther), ctx)).jsonBody.detail, "app_only_not_allowed");
    eq(connectorRuns, []); eq(audits, []);
    eq((await clearviewRun(req(appRun), ctx)).status, 200); eq(connectorRuns, ["clearview:manual"]);
  });

  await test("clearview run: audited as a write BEFORE running (fail-closed 503), 200 with the result, 502 on a failed run, 503 when it cannot start", async () => {
    reset();
    const ok = await clearviewRun(req(admin), ctx);
    eq(ok.status, 200); eq(ok.headers["Cache-Control"], "no-store"); eq(ok.jsonBody.shadow, 2);
    eq(audits.length, 1); eq([audits[0].endpoint, audits[0].action, audits[0].fields, audits[0].outcome, audits[0].employeeId], ["POST /hub/clearview/run", "write", ["deliveries"], "allowed", ""]);
    eq(audits[0].caller.user, "fraser@qsrgroup.ca");
    reset(); auditFails = true;
    eq((await clearviewRun(req(admin), ctx)).status, 503); eq(connectorRuns, [], "no run when the audit cannot be written");
    reset(); connectorResult = () => ({ status: "failed", destination: "clearview", message: "Clearview 401" });
    eq((await clearviewRun(req(admin), ctx)).status, 502);
    reset(); connectorResult = () => new Error("Missing required setting: HUB_SQL_SERVER?x=1");
    const r = await clearviewRun(req(admin), ctx);
    eq(r.status, 503); eq(r.jsonBody.status, "failed"); eq(audits.map(a => a.outcome), ["allowed", "error"]);
    assert(logs.some(l => l.startsWith("ERROR [clearview] manual run error: Missing required setting: HUB_SQL_SERVER") && !l.includes("x=1")), logs.join("\n"));
    connectorResult = () => ({ status: "succeeded" });
  });

  await test("clearview discover: 409 while CLEARVIEW_ENABLED is not true (the first Clearview call starts billing); nothing audited", async () => {
    reset();
    const r = await clearviewDiscover(req(admin), ctx);
    eq(r.status, 409); assert(/CLEARVIEW_ENABLED is not true/.test(r.jsonBody.error), r.jsonBody.error);
    eq(discoveries, []); eq(audits, []);
    process.env.CLEARVIEW_ENABLED = "false";
    eq((await clearviewDiscover(req(admin), ctx)).status, 409);
    eq((await clearviewDiscover(req(reader), ctx)).status, 403, "permissions still checked first");
  });

  await test("clearview discover: what=codes (default) | employees, 400 otherwise; audited; POST only route registered", async () => {
    reset(); process.env.CLEARVIEW_ENABLED = "true";
    const r = await clearviewDiscover(req(admin), ctx);
    eq(r.status, 200); eq(r.jsonBody.what, "codes"); eq(discoveries, ["codes"]);
    eq([audits[0].endpoint, audits[0].fields], ["POST /hub/clearview/discover", ["destination_codes"]]);
    reset(); process.env.CLEARVIEW_ENABLED = "true";
    eq((await clearviewDiscover(req(admin, "what=Employees"), ctx)).jsonBody.what, "employees"); eq(audits[0].fields, ["xref"]);
    reset(); process.env.CLEARVIEW_ENABLED = "true";
    eq((await clearviewDiscover(req(admin, "what=stores"), ctx)).status, 400); eq(discoveries, []); eq(audits, []);
    eq((await clearviewDiscover(req(reader), ctx)).status, 403);
    reset(); process.env.CLEARVIEW_ENABLED = "true"; auditFails = true;
    eq((await clearviewDiscover(req(admin), ctx)).status, 503); eq(discoveries, []);
  });

  await test("after-sync hook: runs the connector after a succeeded / partial sync only when CLEARVIEW_ENABLED; connector errors never fail the sync", async () => {
    reset(); process.env.CLEARVIEW_ENABLED = "true";
    syncResult = { status: "succeeded" };
    eq((await runSyncThenDeliver(ctx, "timer")).status, "succeeded"); eq(connectorRuns, ["clearview:after-sync"]);
    reset(); process.env.CLEARVIEW_ENABLED = "true"; syncResult = { status: "partial" };
    await runSyncThenDeliver(ctx, "manual"); eq(connectorRuns, ["clearview:after-sync"]);
    reset(); process.env.CLEARVIEW_ENABLED = "true"; syncResult = { status: "failed", message: "x" };
    await runSyncThenDeliver(ctx, "manual"); eq(connectorRuns, [], "no delivery after a failed sync");
    reset(); process.env.CLEARVIEW_ENABLED = "true"; syncResult = { status: "skipped" };
    await runSyncThenDeliver(ctx, "manual"); eq(connectorRuns, []);
    reset(); syncResult = { status: "succeeded" };
    await runSyncThenDeliver(ctx, "manual"); eq(connectorRuns, [], "CLEARVIEW_ENABLED unset -> no after-sync run");
    reset(); process.env.CLEARVIEW_ENABLED = "true"; connectorResult = () => new Error("boom?key=1");
    eq((await runSyncThenDeliver(ctx, "manual")).status, "succeeded");
    assert(logs.some(l => l === "ERROR [clearview] after-sync run error: boom"), logs.join("\n"));
    connectorResult = () => ({ status: "succeeded" });
  });

  await test("credentials: oauth mode needs token url + client id + secret per company; key mode needs the key; unresolved Key Vault = missing; secret expiry parsed", async () => {
    await withEnv({}, () => {
      eq(config.clearviewAuthMode, "oauth"); eq(companyCredential("SWN6T"), null);
      eq(clearviewCredentials(), { mode: "oauth", status: "missing", companies: { SWN6T: false, SWNGK: false }, secretExpires: { SWN6T: null, SWNGK: null } });
    });
    await withEnv({ CLEARVIEW_TOKEN_URL: "https://login.example.test/token", CLEARVIEW_SCOPE: "api://cv/.default", CLEARVIEW_CLIENT_ID_SWN6T: "cid", CLEARVIEW_CLIENT_SECRET_SWN6T: " sec ", CLEARVIEW_SECRET_EXPIRES_SWN6T: "2028-11-01", CLEARVIEW_SECRET_EXPIRES_SWNGK: "soon" }, () => {
      eq(companyCredential("swn6t"), { mode: "oauth", tokenUrl: "https://login.example.test/token", scope: "api://cv/.default", clientId: "cid", clientSecret: "sec" });
      eq(companyCredential("SWNGK"), null);
      const c = clearviewCredentials();
      eq([c.mode, c.status, c.companies, c.secretExpires], ["oauth", "partial", { SWN6T: true, SWNGK: false }, { SWN6T: "2028-11-01", SWNGK: null }]);
    });
    await withEnv({ CLEARVIEW_TOKEN_URL: "https://login.example.test/token", CLEARVIEW_CLIENT_ID_SWN6T: "cid", CLEARVIEW_CLIENT_SECRET_SWN6T: `${KEY_VAULT_PREFIX}SecretUri=https://kv.vault.azure.net/secrets/cv/1)` }, () => {
      eq(companyCredential("SWN6T"), null, "unresolved Key Vault secret = missing");
    });
    await withEnv({ CLEARVIEW_TOKEN_URL: "https://login.example.test/token", CLEARVIEW_CLIENT_ID_SWN6T: "cid", CLEARVIEW_CLIENT_SECRET_SWN6T: "sec" }, () => {
      eq(companyCredential("SWN6T").scope, null, "scope optional");
    });
    await withEnv({ CLEARVIEW_AUTH_MODE: "key", CLEARVIEW_AUTH_KEY_SWN6T: "k1", CLEARVIEW_CLIENT_ID_SWNGK: "cid", CLEARVIEW_CLIENT_SECRET_SWNGK: "sec", CLEARVIEW_TOKEN_URL: "x" }, () => {
      eq(config.clearviewAuthMode, "key"); eq(companyCredential("SWN6T"), { mode: "key", key: "k1" }); eq(companyCredential("SWNGK"), null, "oauth settings do not count in key mode");
      eq(clearviewCredentials().status, "partial");
    });
  });

  await test("billing guard: the client only carries credentials when CLEARVIEW_ENABLED is true", async () => {
    const env = { CLEARVIEW_TOKEN_URL: "https://login.example.test/token", CLEARVIEW_CLIENT_ID_SWN6T: "cid", CLEARVIEW_CLIENT_SECRET_SWN6T: "sec", CLEARVIEW_CLIENT_ID_SWNGK: "cid2", CLEARVIEW_CLIENT_SECRET_SWNGK: "sec2" };
    await withEnv(env, () => { const c = buildClearviewClient(); eq(c.companies(), []); eq(c.hasKey("SWN6T"), false); });
    await withEnv({ ...env, CLEARVIEW_ENABLED: "true" }, () => eq(buildClearviewClient().companies(), ["SWN6T", "SWNGK"]));
    await withEnv({ ...env, CLEARVIEW_ENABLED: "true", CLEARVIEW_CLIENT_SECRET_SWNGK: "" }, () => eq(buildClearviewClient().companies(), ["SWN6T"]));
  });

  await test("config: Clearview settings defaults; per-company key; an unresolved Key Vault reference counts as missing", () => {
    const saved = {};
    for (const k of ["CLEARVIEW_BASE_URL", "CLEARVIEW_COMPANIES", "CLEARVIEW_AUTH_KEY_SWN6T", "CLEARVIEW_AUTH_KEY_SWNGK", "CLEARVIEW_ENABLED", "CLEARVIEW_LIVE_ENABLED", "CLEARVIEW_EXCLUDED_JOBS", "CLEARVIEW_MAX_PER_RUN", "CLEARVIEW_WAITING_ALERT_DAYS", "CLEARVIEW_TIMEOUT_MS", "HUB_SHADOW_RETENTION_DAYS", "CLEARVIEW_TERMINATION_REASON_ID"]) { saved[k] = process.env[k]; delete process.env[k]; }
    try {
      eq(config.clearviewBaseUrl, "https://api.clearviewconnect.com"); eq(config.clearviewCompanies, ["SWN6T", "SWNGK"]); eq(config.clearviewExcludedJobs, ["MM"]);
      eq([config.clearviewEnabled, config.clearviewLiveEnabled], [false, false]);
      eq([config.clearviewMaxPerRun, config.clearviewWaitingAlertDays, config.clearviewTimeoutMs, config.hubShadowRetentionDays, config.clearviewTerminationReasonId], [200, 5, 20000, 30, 13078]);
      eq(config.clearviewAuthKey("SWN6T"), null);
      process.env.CLEARVIEW_AUTH_KEY_SWN6T = " abc-key ";
      eq(config.clearviewAuthKey("swn6t"), "abc-key"); eq(config.clearviewAuthKey("SWNGK"), null);
      process.env.CLEARVIEW_AUTH_KEY_SWNGK = `${KEY_VAULT_PREFIX}SecretUri=https://kv.vault.azure.net/secrets/cv-swngk/1)`;
      eq(config.clearviewAuthKey("SWNGK"), null, "unresolved Key Vault reference = missing");
      eq(presentValue("  "), null); eq(presentValue(undefined), null); eq(presentValue("x"), "x");
      process.env.CLEARVIEW_BASE_URL = "https://api-uat-cv-api-marketplace.azurewebsites.net/"; eq(config.clearviewBaseUrl, "https://api-uat-cv-api-marketplace.azurewebsites.net");
      process.env.CLEARVIEW_COMPANIES = "swn6t"; eq(config.clearviewCompanies, ["SWN6T"]);
      process.env.CLEARVIEW_LIVE_ENABLED = "TRUE"; eq(config.clearviewLiveEnabled, true);
    } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  });

  report("clearview endpoints + hook + settings");
};
