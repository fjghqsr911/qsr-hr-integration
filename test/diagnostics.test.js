/* GET /api/hub/diagnostics: permissions, always-200, component statuses, admin-only names, no setting values, no audit writes. */
const path = require("path");
const { DIST, test, report, assert, eq, stubModule, fakePool } = require("./helpers");

module.exports = async () => {
  // Own stubs. hubDiagnostics.js has not loaded yet, so it picks these up (admin.test.js installed its own for hubAdmin.js).
  let pool = null;
  let ukgFails = null;          // null = UKG ok; otherwise the error to throw
  let auditFails = null;        // null = probe ok; otherwise the error to throw
  let auditWrites = 0;
  const realSql = require(path.join(DIST, "shared", "sql.js")).sql;
  const { UkgError } = require(path.join(DIST, "shared", "ukg.js"));
  let resets = 0;
  stubModule("shared/sql.js", { getSharedHubPool: async () => pool, resetSharedHubPool() { resets++; }, openHubPool: async () => pool, sql: realSql });
  stubModule("shared/ukg.js", { UkgError, ukgGet: async () => { if (ukgFails) throw ukgFails; return [{}]; }, ukgGetAll: async () => [] });
  stubModule("shared/audit.js", {
    writeAudit: async () => { auditWrites++; },
    probeAudit: async () => { if (auditFails) throw auditFails; return 7; }
  });
  const noCreds = () => ({ mode: "oauth", status: "missing", companies: { SWN6T: false, SWNGK: false }, secretExpires: { SWN6T: null, SWNGK: null } });
  const allCreds = (over = {}) => ({ mode: "oauth", status: "present", companies: { SWN6T: true, SWNGK: true }, secretExpires: { SWN6T: null, SWNGK: null }, ...over });
  let creds = noCreds();
  let clearviewFails = null;        // null = GET /organization/stores ok; otherwise the error to throw
  const clearviewCalls = [];
  let graphFails = null;            // null = GET /organization ok; otherwise the error to throw
  const graphCalls = [];
  const realGraph = require(path.join(DIST, "shared", "graph.js"));
  stubModule("shared/graph.js", { ...realGraph, buildGraphClient: () => ({ async probeDirectory() { graphCalls.push("GET /users?$top=1"); if (graphFails) throw graphFails; return 42; } }) });
  stubModule("shared/connectors.js", {
    clearviewCredentials: () => creds,
    buildClearviewClient: () => ({
      companies: () => Object.entries(creds.companies).filter(([, ok]) => ok).map(([c]) => c),
      async get(company, p, q) { clearviewCalls.push(`${company} GET ${p}`); if (clearviewFails) throw clearviewFails; return { organizationId: 18, stores: [] }; }
    }),
    runConnector: async () => { throw new Error("not in this test"); }, runDiscovery: async () => { throw new Error("not in this test"); }
  });
  const { hubDiagnostics, GRANTS_SQL, GRANTS, CODES_COUNT_SQL, ENTRA_COUNTS_SQL, ENTRA_LAST_RUN_SQL } = require(path.join(DIST, "functions", "hubDiagnostics.js"));
  const { STATS_SQL } = require(path.join(DIST, "shared", "deliveryStore.js"));

  const principal = (claims) => Buffer.from(JSON.stringify({ claims })).toString("base64");
  const admin = [{ typ: "scp", val: "Employees.Summary.Read Employees.Summary.Write" }, { typ: "roles", val: "Summary.Admin" },
                 { typ: "preferred_username", val: "fraser@qsrgroup.ca" }, { typ: "azp", val: "monitor-app" }];
  const reader = [{ typ: "scp", val: "Employees.Summary.Read Employees.Summary.Write" }, { typ: "roles", val: "Summary.Read" },
                  { typ: "preferred_username", val: "reader@qsrgroup.ca" }, { typ: "azp", val: "monitor-app" }];
  const noRole = [{ typ: "scp", val: "Employees.Summary.Read Employees.Summary.Write" }, { typ: "preferred_username", val: "nobody@qsrgroup.ca" }];
  const noWriteScope = [{ typ: "scp", val: "Employees.Summary.Read" }, { typ: "roles", val: "Summary.Admin" }];
  const appOnly = [{ typ: "idtyp", val: "app" }, { typ: "roles", val: "Integration.Run" }];
  const req = (claims) => ({ headers: new Headers(claims ? { "x-ms-client-principal": principal(claims) } : {}), params: {}, query: new URLSearchParams() });
  const logs = [];
  const ctx = { log(...a) { logs.push(a.join(" ")); }, error(...a) { logs.push("ERROR " + a.join(" ")); }, warn(...a) { logs.push("WARN " + a.join(" ")); } };

  const SETTINGS = ["UKG_BASE_URL", "UKG_USERNAME", "UKG_PASSWORD", "UKG_CUSTOMER_API_KEY", "HUB_SQL_SERVER", "HUB_SQL_DATABASE", "AUDIT_STORAGE_ACCOUNT"];
  const saved = {};
  for (const k of [...SETTINGS, "HUB_SYNC_ENABLED", "ALLOWED_CLIENT_IDS", "CLEARVIEW_ENABLED", "CLEARVIEW_LIVE_ENABLED", "ENTRA_SYNC_ENABLED", "ENTRA_WRITE_ENABLED"]) saved[k] = process.env[k];
  const granted = (over = {}) => ({ recordset: [{ ...Object.fromEntries(GRANTS.map(g => [g.column, 1])), ...over }] });
  const allGranted = (text) => /HAS_PERMS_BY_NAME/.test(text) ? granted() :
    text === STATS_SQL ? { recordset: [{ pending: 3, waiting: 1, failed: 0, dead: 2, oldest_pending_minutes: 95 }] } :
    text === CODES_COUNT_SQL ? { recordset: [{ code_type: "store", n: 2 }, { code_type: "job", n: 4 }, { code_type: "termination", n: 1 }] } : { recordset: [] };
  const reset = () => {
    for (const k of SETTINGS) process.env[k] = `test-${k.toLowerCase()}`;
    process.env.HUB_SYNC_ENABLED = "true"; delete process.env.ALLOWED_CLIENT_IDS;
    process.env.CLEARVIEW_ENABLED = "true"; process.env.CLEARVIEW_LIVE_ENABLED = "false";
    delete process.env.ENTRA_SYNC_ENABLED; delete process.env.ENTRA_WRITE_ENABLED; graphFails = null; graphCalls.length = 0;
    creds = noCreds(); clearviewFails = null; clearviewCalls.length = 0;
    pool = fakePool(allGranted); ukgFails = null; auditFails = null; auditWrites = 0; resets = 0; logs.length = 0;
  };
  const restore = () => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  const COMPONENTS = ["caller", "settings", "sql", "grants", "audit", "ukg", "sync"];

  try {
    await test("diagnostics: permissions (write scope + Summary.Read; no app-only callers)", async () => {
      reset();
      eq((await hubDiagnostics(req(null), ctx)).status, 401);
      eq((await hubDiagnostics(req(noRole), ctx)).status, 403);
      eq((await hubDiagnostics(req(noRole), ctx)).jsonBody.detail, "insufficient_role");
      eq((await hubDiagnostics(req(noWriteScope), ctx)).jsonBody.detail, "insufficient_scope");
      eq((await hubDiagnostics(req(appOnly), ctx)).jsonBody.detail, "app_only_not_allowed");
      eq(pool.calls.length, 0, "no SQL on denied requests"); eq(auditWrites, 0);
    });

    await test("diagnostics: Summary.Read caller gets every component as pass, no name arrays, 200 no-store", async () => {
      reset();
      const res = await hubDiagnostics(req(reader), ctx);
      eq(res.status, 200); eq(res.headers["Cache-Control"], "no-store");
      const b = res.jsonBody;
      assert(typeof b.checkedUtc === "string" && !Number.isNaN(Date.parse(b.checkedUtc)), "checkedUtc");
      eq(Object.keys(b).sort(), ["audit", "caller", "checkedUtc", "destinations", "entra", "grants", "settings", "sql", "sync", "ukg"]);
      eq(COMPONENTS.map(c => b[c].status), COMPONENTS.map(() => "pass"));
      eq(b.destinations.length, 1); eq(b.destinations[0].name, "clearview");
      eq(b.caller, { status: "pass", kind: "delegated", clientAppId: "monitor-app", clientAllowed: true });
      eq(b.sync, { status: "pass", enabled: true });
      eq(b.audit.ms, 7);
      assert(typeof b.sql.ms === "number" && typeof b.ukg.ms === "number", "sql / ukg carry ms");
      assert(!("missing" in b.settings) && !("unresolved" in b.settings) && !("missing" in b.grants), "readers never see setting / grant names");
      eq(pool.calls.map(c => c.text).sort(), ["SELECT 1 AS ok;", GRANTS_SQL, STATS_SQL, CODES_COUNT_SQL, ENTRA_COUNTS_SQL, ENTRA_LAST_RUN_SQL].sort());
      assert(pool.calls.every(c => /^SELECT/i.test(c.text.trim())), "read-only SQL");
      eq(auditWrites, 0, "diagnostics never writes an audit record");
      eq(logs.length, 1); assert(/^\[diagnostics\] by=delegated:reader@qsrgroup.ca ok=7 fail=0 clearview=warn entra=warn$/.test(logs[0]), logs[0]);
    });

    await test("diagnostics: admin caller gets missing / unresolved arrays (empty when all is well)", async () => {
      reset();
      const b = (await hubDiagnostics(req(admin), ctx)).jsonBody;
      eq(b.settings, { status: "pass", missing: [], unresolved: [] });
      eq(b.grants.status, "pass"); assert(!("missing" in b.grants), "no missing list when every grant is present");
    });

    await test("diagnostics: unresolved Key Vault reference -> settings fail; name for admins only; value never in the body", async () => {
      const secret = "@Microsoft.KeyVault(SecretUri=https://kv-test.vault.azure.net/secrets/ukg-password/abc123)";
      reset(); process.env.UKG_PASSWORD = secret; delete process.env.HUB_SQL_DATABASE;
      const asAdmin = await hubDiagnostics(req(admin), ctx);
      eq(asAdmin.status, 200);
      eq(asAdmin.jsonBody.settings.status, "fail");
      eq(asAdmin.jsonBody.settings.unresolved, ["UKG_PASSWORD"]);
      eq(asAdmin.jsonBody.settings.missing, ["HUB_SQL_DATABASE"]);
      const text = JSON.stringify(asAdmin.jsonBody);
      assert(!text.includes(secret) && !text.includes("SecretUri") && !text.includes("kv-test"), "setting values must never be returned");
      for (const k of SETTINGS) if (process.env[k]) assert(!text.includes(process.env[k]), `${k} value leaked`);
      const asReader = await hubDiagnostics(req(reader), ctx);
      eq(asReader.jsonBody.settings.status, "fail");
      assert(!("unresolved" in asReader.jsonBody.settings) && !("missing" in asReader.jsonBody.settings), "readers get the status only");
      assert(!JSON.stringify(asReader.jsonBody).includes("UKG_PASSWORD"), "readers do not see the setting name");
    });

    await test("diagnostics: a missing grant -> grants fail; names for admins only", async () => {
      reset(); pool = fakePool((text) => /HAS_PERMS_BY_NAME/.test(text) ? granted({ storeModesUpdate: 0 }) : allGranted(text));
      const asAdmin = (await hubDiagnostics(req(admin), ctx)).jsonBody;
      eq(asAdmin.grants.status, "fail"); eq(asAdmin.grants.missing, ["UPDATE on ref.store_modes"]);
      const asReader = (await hubDiagnostics(req(reader), ctx)).jsonBody;
      eq(asReader.grants.status, "fail"); assert(!("missing" in asReader.grants));
      assert(/HAS_PERMS_BY_NAME\('ref.store_modes','OBJECT','INSERT'\) AS storeModesInsert/.test(GRANTS_SQL));
      assert(/HAS_PERMS_BY_NAME\('\[out\]\.\[deliveries\]','OBJECT','UPDATE'\) AS deliveriesUpdate/.test(GRANTS_SQL));
      assert(/HAS_PERMS_BY_NAME\('stage.sync_runs','OBJECT','INSERT'\) AS syncRunsInsert/.test(GRANTS_SQL));
      for (const g of ["INSERT on [out].[last_sent]", "DELETE on [out].[shadow_payloads]", "INSERT on xref.employees", "INSERT on ref.destination_codes", "SELECT on rpt.workforce_events", "SELECT on stage.employment_current"])
        assert(GRANTS.some(x => `${x.permission} on ${x.object}` === g), `grant check covers ${g}`);
    });

    await test("diagnostics: audit probe throwing -> audit fail, still HTTP 200, no audit write", async () => {
      reset(); auditFails = new Error("table unreachable");
      const res = await hubDiagnostics(req(reader), ctx);
      eq(res.status, 200); eq(res.jsonBody.audit, { status: "fail", detail: "table unreachable" });
      eq(res.jsonBody.sql.status, "pass"); eq(auditWrites, 0);
      assert(/ok=6 fail=1 clearview=warn entra=warn$/.test(logs[0]), logs[0]);
    });

    await test("diagnostics: SQL down -> sql and grants fail, pool reset, other components unaffected, 200", async () => {
      reset(); pool = fakePool(() => { throw new Error("db down"); });
      const res = await hubDiagnostics(req(admin), ctx);
      eq(res.status, 200);
      eq(res.jsonBody.sql, { status: "fail", detail: "db down" }); eq(res.jsonBody.grants.status, "fail");
      assert(resets >= 1, "the shared pool is reset after a connection error");
      eq([res.jsonBody.ukg.status, res.jsonBody.audit.status, res.jsonBody.settings.status], ["pass", "pass", "pass"]);
    });

    await test("diagnostics: UKG failures carry the same hints as /api/health", async () => {
      reset(); ukgFails = new UkgError(401, "UKG 401 on /personnel/v1/employee-employment-details");
      let b = (await hubDiagnostics(req(reader), ctx)).jsonBody;
      eq(b.ukg, { status: "fail", detail: "UKG rejected the credentials - check Key Vault values", httpStatus: 401 });
      ukgFails = new UkgError(403, "UKG 403");
      eq((await hubDiagnostics(req(reader), ctx)).jsonBody.ukg.detail, "Login worked but the account lacks Employment Details permission");
      ukgFails = new UkgError(0, "UKG request failed on /x: TimeoutError");
      b = (await hubDiagnostics(req(reader), ctx)).jsonBody;
      eq(b.ukg, { status: "fail", detail: "UKG unreachable or error", httpStatus: "unreachable" });
      ukgFails = new Error("Missing required setting: UKG_BASE_URL");
      eq((await hubDiagnostics(req(reader), ctx)).jsonBody.ukg.detail, "Missing required setting: UKG_BASE_URL");
    });

    await test("diagnostics: sync disabled -> warn; caller not in ALLOWED_CLIENT_IDS is refused before any check", async () => {
      reset(); process.env.HUB_SYNC_ENABLED = "false";
      const b = (await hubDiagnostics(req(reader), ctx)).jsonBody;
      eq(b.sync.status, "warn"); eq(b.sync.enabled, false);
      assert(/ok=6 fail=0 clearview=warn entra=warn$/.test(logs[0]), logs[0]);
      reset(); process.env.ALLOWED_CLIENT_IDS = "other-app";
      eq((await hubDiagnostics(req(reader), ctx)).jsonBody.detail, "client_app_not_allowed");
      process.env.ALLOWED_CLIENT_IDS = "other-app, monitor-app";
      eq((await hubDiagnostics(req(reader), ctx)).jsonBody.caller.clientAllowed, true);
    });
    await test("diagnostics: destinations[0] clearview without credentials -> api skipped, credentials missing, warn; queue and codes from SQL; no Clearview call", async () => {
      reset();
      const b = (await hubDiagnostics(req(reader), ctx)).jsonBody;
      const d = b.destinations[0];
      eq(Object.keys(d).sort(), ["api", "authMode", "codes", "credentials", "detail", "enabled", "live", "name", "queue", "secretExpiresUtc", "status"]);
      eq([d.name, d.status, d.enabled, d.live, d.authMode, d.credentials, d.secretExpiresUtc], ["clearview", "warn", true, false, "oauth", "missing", null]);
      eq(d.api, { status: "skipped" });
      eq(d.queue, { pending: 3, waiting: 1, failed: 0, dead: 2, oldestPendingMinutes: 95 });
      eq(d.codes, { store: 2, job: 4, termination: 1 });
      assert(/no Clearview OAuth settings \(CLEARVIEW_TOKEN_URL/.test(d.detail), d.detail);
      reset(); creds = { ...noCreds(), mode: "key" };
      assert(/no CLEARVIEW_AUTH_KEY_<COMPANY> set/.test((await hubDiagnostics(req(reader), ctx)).jsonBody.destinations[0].detail));
      eq(clearviewCalls, [], "Clearview is never called without a key");
      assert(pool.calls.every(c => /^SELECT/i.test(c.text.trim())), "read-only SQL");
    });

    await test("diagnostics: clearview with credentials -> timed GET /organization/stores per company; partial keys warn; API failure -> fail; sql down -> fail with queue null", async () => {
      reset(); creds = allCreds();
      let d = (await hubDiagnostics(req(reader), ctx)).jsonBody.destinations[0];
      eq([d.status, d.credentials, d.api.status], ["pass", "present", "pass"]); assert(typeof d.api.ms === "number"); assert(!("detail" in d), d.detail);
      eq(clearviewCalls, ["SWN6T GET /organization/stores", "SWNGK GET /organization/stores"]);
      reset(); creds = allCreds({ status: "partial", companies: { SWN6T: true, SWNGK: false } });
      d = (await hubDiagnostics(req(reader), ctx)).jsonBody.destinations[0];
      eq([d.status, d.credentials, d.api.status], ["warn", "partial", "pass"]); assert(/credentials for SWNGK missing/.test(d.detail), d.detail);
      eq(clearviewCalls, ["SWN6T GET /organization/stores"]);
      reset(); creds = allCreds(); clearviewFails = new Error("Clearview 401 on GET /organization/stores: Unauthorized");
      d = (await hubDiagnostics(req(reader), ctx)).jsonBody.destinations[0];
      eq([d.status, d.api.status], ["fail", "fail"]); assert(/SWN6T: Clearview 401/.test(d.api.detail), d.api.detail);
      reset(); creds = allCreds(); process.env.CLEARVIEW_ENABLED = "false";
      d = (await hubDiagnostics(req(reader), ctx)).jsonBody.destinations[0];
      eq([d.status, d.enabled], ["warn", false]); assert(/CLEARVIEW_ENABLED is not "true"/.test(d.detail), d.detail);
      eq(d.api, { status: "skipped", detail: "connector disabled; first call starts billing" }); eq(clearviewCalls, [], "disabled: Clearview is never called, even with credentials");
      reset(); pool = fakePool(() => { throw new Error("db down"); });
      d = (await hubDiagnostics(req(reader), ctx)).jsonBody.destinations[0];
      eq([d.status, d.queue], ["fail", null]); assert(/queue unavailable: db down/.test(d.detail), d.detail);
      reset(); pool = fakePool((text) => /HAS_PERMS_BY_NAME/.test(text) ? granted() : { recordset: [] });
      d = (await hubDiagnostics(req(reader), ctx)).jsonBody.destinations[0];
      eq(d.codes, { store: 0, job: 0, termination: 0 }); assert(/no store mappings yet/.test(d.detail) && /no job mappings yet/.test(d.detail), d.detail);
    });
    await test("diagnostics: clearview OAuth secret expiry -> secretExpiresUtc (earliest) and warn within 60 days or past", async () => {
      const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), far = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
      reset(); creds = allCreds({ secretExpires: { SWN6T: far, SWNGK: soon } });
      let d = (await hubDiagnostics(req(reader), ctx)).jsonBody.destinations[0];
      eq(d.status, "warn"); eq(d.secretExpiresUtc, new Date(soon).toISOString()); assert(/OAuth secret for SWNGK expires in (29|30) day\(s\)/.test(d.detail), d.detail);
      reset(); creds = allCreds({ secretExpires: { SWN6T: "2026-01-01", SWNGK: null } });
      d = (await hubDiagnostics(req(reader), ctx)).jsonBody.destinations[0];
      eq(d.status, "warn"); assert(/OAuth secret for SWN6T expired \d+ day\(s\) ago/.test(d.detail), d.detail);
      reset(); creds = allCreds({ secretExpires: { SWN6T: far, SWNGK: far } });
      d = (await hubDiagnostics(req(reader), ctx)).jsonBody.destinations[0];
      eq(d.status, "pass"); eq(d.secretExpiresUtc, new Date(far).toISOString());
    });

    // ------------------------------------------------------------ entra ------------------------------------------------------------
    const entraPool = (counts = {}, run = null) => fakePool((text) =>
      text === ENTRA_COUNTS_SQL ? { recordset: [{ users: 0, linked: 0, unlinked_with_email: 0, orphans: 0, proposed: 0, due: 0, failed: 0, blocked: 0, ...counts }] } :
      text === ENTRA_LAST_RUN_SQL ? { recordset: run ? [run] : [] } : allGranted(text));
    const recentRun = (over = {}) => ({ run_id: "11111111-2222-3333-4444-555555555555", started_utc: new Date(Date.now() - 3600_000), finished_utc: new Date(Date.now() - 3500_000), status: "succeeded", trigger_kind: "timer", ...over });

    await test("diagnostics: entra disabled with no snapshot -> probe skipped, warn, counts from SQL, writeEnabled false, no Graph call", async () => {
      reset(); pool = entraPool();
      const e = (await hubDiagnostics(req(reader), ctx)).jsonBody.entra;
      eq(Object.keys(e).sort(), ["api", "counts", "detail", "enabled", "lastRun", "status", "writeEnabled"]);
      eq([e.status, e.enabled, e.writeEnabled, e.lastRun], ["warn", false, false, null]);
      eq(e.api, { status: "skipped", detail: "sync disabled and no snapshot yet" });
      eq(e.counts, { users: 0, linked: 0, unlinkedWithEmail: 0, orphans: 0, proposed: 0, due: 0, failed: 0, blocked: 0 });
      assert(/ENTRA_SYNC_ENABLED is not "true"/.test(e.detail) && /ENTRA_WRITE_ENABLED is not "true"/.test(e.detail), e.detail);
      eq(graphCalls, [], "Graph is not probed while disabled without a snapshot");
      assert(pool.calls.filter(c => c.text === ENTRA_COUNTS_SQL).length === 1 && pool.calls.every(c => /^SELECT/i.test(c.text.trim())), "read-only SQL");
      assert(/WHERE status = 'proposed'/.test(ENTRA_COUNTS_SQL) && /due_date <= @today/.test(ENTRA_COUNTS_SQL) && /FROM rpt.v_directory/.test(ENTRA_COUNTS_SQL));
    });

    await test("diagnostics: entra enabled -> probe runs; pass with a recent run; no run or run older than 26 h -> warn; failed proposals -> warn", async () => {
      reset(); process.env.ENTRA_SYNC_ENABLED = "true"; process.env.ENTRA_WRITE_ENABLED = "true"; pool = entraPool({ users: 120, linked: 100 }, recentRun());
      let e = (await hubDiagnostics(req(reader), ctx)).jsonBody.entra;
      eq([e.status, e.enabled, e.writeEnabled, e.api], ["pass", true, true, { status: "pass", ms: 42 }]); eq(graphCalls, ["GET /users?$top=1"]);
      eq([e.lastRun.status, e.lastRun.trigger, e.lastRun.runId], ["succeeded", "timer", "11111111-2222-3333-4444-555555555555"]);
      assert(e.lastRun.ageHours >= 0.9 && e.lastRun.ageHours <= 1.1, String(e.lastRun.ageHours)); assert(!("detail" in e), e.detail);
      reset(); process.env.ENTRA_SYNC_ENABLED = "true"; pool = entraPool({ users: 120 });
      e = (await hubDiagnostics(req(reader), ctx)).jsonBody.entra;
      eq(e.status, "warn"); assert(/no Entra sync run yet/.test(e.detail), e.detail);
      reset(); process.env.ENTRA_SYNC_ENABLED = "true"; pool = entraPool({ users: 120 }, recentRun({ started_utc: new Date(Date.now() - 30 * 3600_000) }));
      e = (await hubDiagnostics(req(reader), ctx)).jsonBody.entra;
      eq(e.status, "warn"); assert(/last Entra sync 30 h ago/.test(e.detail), e.detail);
      reset(); process.env.ENTRA_SYNC_ENABLED = "true"; pool = entraPool({ users: 120, failed: 2 }, recentRun());
      e = (await hubDiagnostics(req(reader), ctx)).jsonBody.entra;
      eq(e.status, "warn"); assert(/2 proposal\(s\) failed to apply/.test(e.detail), e.detail);
      reset(); process.env.ENTRA_SYNC_ENABLED = "true"; pool = entraPool({ users: 120 }, recentRun({ status: "failed" }));
      e = (await hubDiagnostics(req(reader), ctx)).jsonBody.entra;
      eq(e.status, "warn"); assert(/last Entra sync failed/.test(e.detail), e.detail);
    });

    await test("diagnostics: entra probe with a snapshot while disabled; Graph failure -> fail; SQL down -> fail when enabled, warn when disabled", async () => {
      reset(); pool = entraPool({ users: 5 }, recentRun());
      let e = (await hubDiagnostics(req(reader), ctx)).jsonBody.entra;
      eq([e.status, e.api.status], ["warn", "pass"]); eq(graphCalls, ["GET /users?$top=1"], "a snapshot means the probe runs even while disabled");
      reset(); process.env.ENTRA_SYNC_ENABLED = "true"; graphFails = new Error("Graph 403 on GET /users: Authorization_RequestDenied"); pool = entraPool({ users: 5 }, recentRun());
      e = (await hubDiagnostics(req(reader), ctx)).jsonBody.entra;
      eq([e.status, e.api], ["fail", { status: "fail", detail: "Graph 403 on GET /users: Authorization_RequestDenied" }]);
      reset(); process.env.ENTRA_SYNC_ENABLED = "true"; pool = fakePool((text) => { if (text === ENTRA_COUNTS_SQL) throw new Error("Invalid object name entra.users"); return allGranted(text); });
      e = (await hubDiagnostics(req(reader), ctx)).jsonBody.entra;
      eq([e.status, e.counts, e.lastRun], ["fail", null, null]); assert(/entra tables unavailable: Invalid object name/.test(e.detail), e.detail);
      reset(); pool = fakePool((text) => { if (text === ENTRA_COUNTS_SQL) throw new Error("Invalid object name entra.users"); return allGranted(text); });
      e = (await hubDiagnostics(req(reader), ctx)).jsonBody.entra;
      eq(e.status, "warn", "not provisioned yet and switched off is a warning, not a failure"); eq(graphCalls, []);
      for (const g of ["INSERT on entra.users", "UPDATE on entra.proposals", "DELETE on entra.links", "INSERT on entra.sync_runs", "SELECT on ref.stores", "SELECT on rpt.v_directory"])
        assert(GRANTS.some(x => `${x.permission} on ${x.object}` === g), `grant check covers ${g}`);
    });
  } finally { restore(); }

  report("diagnostics endpoint");
};
