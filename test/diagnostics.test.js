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
  const { hubDiagnostics, GRANTS_SQL } = require(path.join(DIST, "functions", "hubDiagnostics.js"));

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
  for (const k of [...SETTINGS, "HUB_SYNC_ENABLED", "ALLOWED_CLIENT_IDS"]) saved[k] = process.env[k];
  const allGranted = () => ({ recordset: [{ storeModesInsert: 1, storeModesUpdate: 1, deliveriesUpdate: 1, syncRunsInsert: 1 }] });
  const reset = () => {
    for (const k of SETTINGS) process.env[k] = `test-${k.toLowerCase()}`;
    process.env.HUB_SYNC_ENABLED = "true"; delete process.env.ALLOWED_CLIENT_IDS;
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
      eq(Object.keys(b).sort(), ["audit", "caller", "checkedUtc", "destinations", "grants", "settings", "sql", "sync", "ukg"]);
      eq(COMPONENTS.map(c => b[c].status), COMPONENTS.map(() => "pass"));
      eq(b.destinations, []);
      eq(b.caller, { status: "pass", kind: "delegated", clientAppId: "monitor-app", clientAllowed: true });
      eq(b.sync, { status: "pass", enabled: true });
      eq(b.audit.ms, 7);
      assert(typeof b.sql.ms === "number" && typeof b.ukg.ms === "number", "sql / ukg carry ms");
      assert(!("missing" in b.settings) && !("unresolved" in b.settings) && !("missing" in b.grants), "readers never see setting / grant names");
      eq(pool.calls.map(c => c.text), ["SELECT 1 AS ok;", GRANTS_SQL]);
      assert(pool.calls.every(c => /^SELECT/i.test(c.text.trim())), "read-only SQL");
      eq(auditWrites, 0, "diagnostics never writes an audit record");
      eq(logs.length, 1); assert(/^\[diagnostics\] by=delegated:reader@qsrgroup.ca ok=7 fail=0$/.test(logs[0]), logs[0]);
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
      reset(); pool = fakePool(() => ({ recordset: [{ storeModesInsert: 1, storeModesUpdate: 0, deliveriesUpdate: 1, syncRunsInsert: 1 }] }));
      const asAdmin = (await hubDiagnostics(req(admin), ctx)).jsonBody;
      eq(asAdmin.grants.status, "fail"); eq(asAdmin.grants.missing, ["UPDATE on ref.store_modes"]);
      const asReader = (await hubDiagnostics(req(reader), ctx)).jsonBody;
      eq(asReader.grants.status, "fail"); assert(!("missing" in asReader.grants));
      assert(/HAS_PERMS_BY_NAME\('ref.store_modes','OBJECT','INSERT'\) AS storeModesInsert/.test(GRANTS_SQL));
      assert(/HAS_PERMS_BY_NAME\('\[out\]\.\[deliveries\]','OBJECT','UPDATE'\) AS deliveriesUpdate/.test(GRANTS_SQL));
      assert(/HAS_PERMS_BY_NAME\('stage.sync_runs','OBJECT','INSERT'\) AS syncRunsInsert/.test(GRANTS_SQL));
    });

    await test("diagnostics: audit probe throwing -> audit fail, still HTTP 200, no audit write", async () => {
      reset(); auditFails = new Error("table unreachable");
      const res = await hubDiagnostics(req(reader), ctx);
      eq(res.status, 200); eq(res.jsonBody.audit, { status: "fail", detail: "table unreachable" });
      eq(res.jsonBody.sql.status, "pass"); eq(auditWrites, 0);
      assert(/ok=6 fail=1$/.test(logs[0]), logs[0]);
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
      assert(/ok=6 fail=0$/.test(logs[0]), logs[0]);
      reset(); process.env.ALLOWED_CLIENT_IDS = "other-app";
      eq((await hubDiagnostics(req(reader), ctx)).jsonBody.detail, "client_app_not_allowed");
      process.env.ALLOWED_CLIENT_IDS = "other-app, monitor-app";
      eq((await hubDiagnostics(req(reader), ctx)).jsonBody.caller.clientAllowed, true);
    });
  } finally { restore(); }

  report("diagnostics endpoint");
};
