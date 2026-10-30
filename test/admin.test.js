/* Admin endpoints (store mode, delivery retry / resolve): permissions, validation, state rules, fail-closed audit. */
const path = require("path");
const { DIST, test, report, assert, eq, stubModule, fakePool } = require("./helpers");

module.exports = async () => {
  // Own stubs (the ones birthday.test.js installed belong to that suite). hubAdmin.js has not loaded yet, so it picks these up.
  let pool = null;
  const audits = [];
  let auditFails = false;
  const realSql = require(path.join(DIST, "shared", "sql.js")).sql;
  stubModule("shared/sql.js", { getSharedHubPool: async () => pool, resetSharedHubPool() {}, openHubPool: async () => pool, sql: realSql });
  stubModule("shared/audit.js", { writeAudit: async (e) => { if (auditFails) throw new Error("down"); audits.push(e); } });
  const { hubStoreMode, hubDeliveryRetry, hubDeliveryResolve, STORE_MODE_SQL, DELIVERY_RETRY_SQL, DELIVERY_RESOLVE_SQL } =
    require(path.join(DIST, "functions", "hubAdmin.js"));

  const principal = (claims) => Buffer.from(JSON.stringify({ claims })).toString("base64");
  const admin = [{ typ: "scp", val: "Employees.Summary.Read Employees.Summary.Write" }, { typ: "roles", val: "Summary.Admin" },
                 { typ: "preferred_username", val: "fraser@qsrgroup.ca" }, { typ: "azp", val: "monitor-app" }];
  const reader = [{ typ: "scp", val: "Employees.Summary.Read Employees.Summary.Write" }, { typ: "roles", val: "Summary.Read" }];
  const noWriteScope = [{ typ: "scp", val: "Employees.Summary.Read" }, { typ: "roles", val: "Summary.Admin" }];
  const appOnly = [{ typ: "idtyp", val: "app" }, { typ: "roles", val: "Integration.Run" }];
  const req = (claims, params = {}, body) => ({
    headers: new Headers(claims ? { "x-ms-client-principal": principal(claims) } : {}),
    params, query: new URLSearchParams(),
    json: async () => { if (body === "bad-json") throw new SyntaxError("bad"); return body; }
  });
  const ctx = { log() {}, error() {}, warn() {} };
  const reset = () => { audits.length = 0; auditFails = false; };

  const modeRow = (over = {}) => ({ destination: "clearview", store: "T01647", mode: "shadow", changed_utc: new Date("2026-10-30T12:00:00Z"), changed_by: "delegated:fraser@qsrgroup.ca", ...over });
  const delivery = (over = {}) => ({ delivery_id: 42, destination: "rosnet", kind: "event", employee_id: "E123", event_type: "New hire", action: "create",
    effective_date: new Date("2026-10-28T00:00:00Z"), store: "T00037", status: "failed", attempts: 3, next_attempt_utc: null,
    queued_utc: new Date("2026-10-29T10:00:00Z"), finished_utc: null, last_error: "timeout", ...over });

  // ------------------------------------------------------------ store mode ------------------------------------------------------------
  await test("store mode: permissions (admin + write scope only; no app-only callers)", async () => {
    reset(); pool = fakePool(() => ({ recordset: [modeRow()] }));
    const p = { destination: "clearview", store: "T01647" };
    eq((await hubStoreMode(req(null, p, { mode: "shadow" }), ctx)).status, 401);
    eq((await hubStoreMode(req(reader, p, { mode: "shadow" }), ctx)).jsonBody.detail, "insufficient_role");
    eq((await hubStoreMode(req(noWriteScope, p, { mode: "shadow" }), ctx)).jsonBody.detail, "insufficient_scope");
    eq((await hubStoreMode(req(appOnly, p, { mode: "shadow" }), ctx)).jsonBody.detail, "app_only_not_allowed");
    eq(pool.calls.length, 0, "no SQL on denied requests"); eq(audits.length, 0, "no audit on denied requests");
  });
  await test("store mode: validation of destination, store and body", async () => {
    reset(); pool = fakePool(() => ({ recordset: [modeRow()] }));
    eq((await hubStoreMode(req(admin, { destination: "sap", store: "T01647" }, { mode: "live" }), ctx)).status, 400);
    eq((await hubStoreMode(req(admin, { destination: "clearview", store: "T01;drop" }, { mode: "live" }), ctx)).status, 400);
    eq((await hubStoreMode(req(admin, { destination: "clearview", store: "" }, { mode: "live" }), ctx)).status, 400);
    eq((await hubStoreMode(req(admin, { destination: "clearview", store: "T01647" }, { mode: "on" }), ctx)).status, 400);
    eq((await hubStoreMode(req(admin, { destination: "clearview", store: "T01647" }, {}), ctx)).status, 400);
    eq((await hubStoreMode(req(admin, { destination: "clearview", store: "T01647" }, "bad-json"), ctx)).status, 400);
    eq(pool.calls.length, 0); eq(audits.length, 0);
  });
  await test("store mode: upserts with caller as changed_by, audits the write, returns the row", async () => {
    reset(); pool = fakePool(() => ({ recordset: [modeRow({ mode: "live" })] }));
    const res = await hubStoreMode(req(admin, { destination: "Clearview", store: "t01647" }, { mode: "LIVE" }), ctx);
    eq(res.status ?? 200, 200);
    eq(res.jsonBody, { destination: "clearview", store: "T01647", mode: "live", changedUtc: "2026-10-30T12:00:00.000Z", changedBy: "delegated:fraser@qsrgroup.ca" });
    eq(pool.calls.length, 1); eq(pool.calls[0].text, STORE_MODE_SQL);
    eq(pool.calls[0].inputs, { destination: "clearview", store: "T01647", mode: "live", changedBy: "delegated:fraser@qsrgroup.ca" });
    assert(/SYSUTCDATETIME\(\)/.test(STORE_MODE_SQL) && /changed_by = @changedBy/.test(STORE_MODE_SQL));
    eq(audits.length, 1);
    eq([audits[0].endpoint, audits[0].employeeId, audits[0].action, audits[0].fields, audits[0].outcome],
       ["PUT /hub/stores/{destination}/{store}/mode", "", "write", ["mode"], "allowed"]);
    eq(audits[0].caller.user, "fraser@qsrgroup.ca");
  });
  await test("store mode: audit failure -> 503 and no SQL (fail closed)", async () => {
    reset(); auditFails = true; pool = fakePool(() => ({ recordset: [modeRow()] }));
    const res = await hubStoreMode(req(admin, { destination: "rosnet", store: "T00037" }, { mode: "off" }), ctx);
    eq(res.status, 503); eq(pool.calls.length, 0, "the change must not be applied when the audit cannot be written");
  });
  await test("store mode: SQL failure -> 503 with an error audit", async () => {
    reset(); pool = fakePool(() => { throw new Error("db down"); });
    const res = await hubStoreMode(req(admin, { destination: "rosnet", store: "T00037" }, { mode: "off" }), ctx);
    eq(res.status, 503); eq(audits.map(a => a.outcome), ["allowed", "error"]);
  });

  // ------------------------------------------------------------ deliveries ------------------------------------------------------------
  /** Pool whose SELECT returns `row` and whose UPDATE returns the row with the new status only when the rule allows it. */
  const deliveryPool = (row, after = {}) => fakePool((text) => {
    if (/^SELECT/.test(text.trim())) return { recordset: row ? [row] : [] };
    if (text === DELIVERY_RETRY_SQL)   return { recordset: row && ["failed", "dead"].includes(row.status) ? [{ ...row, status: "pending", next_attempt_utc: new Date("2026-10-30T12:00:00Z"), ...after }] : [] };
    if (text === DELIVERY_RESOLVE_SQL) return { recordset: row && row.status === "review" ? [{ ...row, status: "resolved", finished_utc: new Date("2026-10-30T12:00:00Z"), ...after }] : [] };
    throw new Error(`unexpected SQL: ${text}`);
  });

  await test("deliveries: permissions + id validation", async () => {
    reset(); pool = deliveryPool(delivery());
    for (const fn of [hubDeliveryRetry, hubDeliveryResolve]) {
      eq((await fn(req(null, { id: "42" }), ctx)).status, 401);
      eq((await fn(req(reader, { id: "42" }), ctx)).jsonBody.detail, "insufficient_role");
      eq((await fn(req(noWriteScope, { id: "42" }), ctx)).jsonBody.detail, "insufficient_scope");
      eq((await fn(req(appOnly, { id: "42" }), ctx)).jsonBody.detail, "app_only_not_allowed");
      eq((await fn(req(admin, { id: "42; drop" }), ctx)).status, 400);
      eq((await fn(req(admin, { id: "" }), ctx)).status, 400);
      eq((await fn(req(admin, { id: "1234567890123456" }), ctx)).status, 400, "ids are capped at 15 digits");
    }
    eq(pool.calls.length, 0); eq(audits.length, 0);
  });
  await test("retry: failed -> pending (attempts kept), audited with the delivery's employee", async () => {
    reset(); pool = deliveryPool(delivery({ status: "failed", attempts: 3 }));
    const res = await hubDeliveryRetry(req(admin, { id: "42" }), ctx);
    eq(res.status ?? 200, 200);
    eq([res.jsonBody.deliveryId, res.jsonBody.status, res.jsonBody.attempts, res.jsonBody.nextAttemptUtc, res.jsonBody.employeeId],
       [42, "pending", 3, "2026-10-30T12:00:00.000Z", "E123"]);
    eq(pool.calls.map(c => c.inputs.id), [42, 42]);
    assert(/SET status = 'pending', next_attempt_utc = SYSUTCDATETIME\(\)/.test(DELIVERY_RETRY_SQL) && !/attempts/.test(DELIVERY_RETRY_SQL.split("OUTPUT")[0]));
    assert(/status IN \('failed', 'dead'\)/.test(DELIVERY_RETRY_SQL), "the update itself must re-check the status");
    eq(audits.length, 1);
    eq([audits[0].endpoint, audits[0].employeeId, audits[0].action, audits[0].fields, audits[0].outcome],
       ["POST /hub/deliveries/{id}/retry", "E123", "write", ["status"], "allowed"]);
  });
  await test("retry: dead -> pending; other statuses -> 409 with no audit and no update", async () => {
    reset(); pool = deliveryPool(delivery({ status: "dead" }));
    eq((await hubDeliveryRetry(req(admin, { id: "42" }), ctx)).jsonBody.status, "pending");
    for (const status of ["pending", "sent", "shadow", "review", "resolved", "superseded", "unchanged"]) {
      reset(); pool = deliveryPool(delivery({ status }));
      const res = await hubDeliveryRetry(req(admin, { id: "42" }), ctx);
      eq(res.status, 409, `retry of ${status}`); eq(res.jsonBody.status, status);
      eq(pool.calls.length, 1, "read only"); eq(audits.length, 0, "a refused change is not audited");
    }
  });
  await test("resolve: review -> resolved with finished_utc; other statuses -> 409", async () => {
    reset(); pool = deliveryPool(delivery({ status: "review" }));
    const res = await hubDeliveryResolve(req(admin, { id: "42" }), ctx);
    eq([res.jsonBody.status, res.jsonBody.finishedUtc], ["resolved", "2026-10-30T12:00:00.000Z"]);
    assert(/SET status = 'resolved', finished_utc = SYSUTCDATETIME\(\)/.test(DELIVERY_RESOLVE_SQL) && /status = 'review'/.test(DELIVERY_RESOLVE_SQL));
    eq(audits.map(a => [a.endpoint, a.employeeId, a.fields, a.outcome]), [["POST /hub/deliveries/{id}/resolve", "E123", ["status"], "allowed"]]);
    for (const status of ["pending", "failed", "dead", "resolved", "sent"]) {
      reset(); pool = deliveryPool(delivery({ status }));
      eq((await hubDeliveryResolve(req(admin, { id: "42" }), ctx)).status, 409, `resolve of ${status}`);
      eq(audits.length, 0);
    }
  });
  await test("deliveries: unknown id -> 404 (audited not_found)", async () => {
    reset(); pool = deliveryPool(null);
    eq((await hubDeliveryRetry(req(admin, { id: "7" }), ctx)).status, 404);
    eq(audits.map(a => a.outcome), ["not_found"]);
  });
  await test("deliveries: audit failure -> 503 and the update is not run (fail closed)", async () => {
    reset(); auditFails = true; pool = deliveryPool(delivery({ status: "failed" }));
    eq((await hubDeliveryRetry(req(admin, { id: "42" }), ctx)).status, 503);
    eq(pool.calls.length, 1, "only the read ran; no UPDATE");
    reset(); auditFails = true; pool = deliveryPool(delivery({ status: "review" }));
    eq((await hubDeliveryResolve(req(admin, { id: "42" }), ctx)).status, 503);
    eq(pool.calls.length, 1);
  });
  await test("deliveries: status changed between read and update -> 409 with the current status", async () => {
    reset();
    let reads = 0;
    pool = fakePool((text) => {
      if (/^SELECT/.test(text.trim())) return { recordset: [delivery({ status: reads++ === 0 ? "failed" : "superseded" })] };
      return { recordset: [] };                                          // the guarded UPDATE touched nothing
    });
    const res = await hubDeliveryRetry(req(admin, { id: "42" }), ctx);
    eq(res.status, 409); eq(res.jsonBody.status, "superseded");
  });
  await test("deliveries: SQL failure -> 503", async () => {
    reset(); pool = fakePool(() => { throw new Error("db down"); });
    eq((await hubDeliveryRetry(req(admin, { id: "42" }), ctx)).status, 503);
    eq(audits.map(a => a.outcome), ["error"]);
  });

  report("admin endpoints");
};
