/* Clearview client (key handling, retries, safe errors), connector call sequences + idempotency, discovery pairing. */
const path = require("path");
const { DIST, FAKE_YEAR, test, report, assert, eq } = require("./helpers");

const KEY = "11111111-2222-3333-4444-555555555555";
const SIN = "123456789";

module.exports = async () => {
  const { ClearviewClient, ClearviewError, safeMessage, _resetFirstCallLog } = require(path.join(DIST, "shared", "clearview", "client.js"));
  const { ClearviewConnector, ClearviewApiReads, classify, currentRate } = require(path.join(DIST, "shared", "clearview", "connector.js"));
  const { discover, tdlDigits, hubDigits } = require(path.join(DIST, "shared", "clearview", "discover.js"));
  const { DeliveryError } = require(path.join(DIST, "shared", "delivery.js"));

  // ---------------------------------------------------------------- client ----------------------------------------------------------------
  /** fetch stub: records requests; `answers` maps "METHOD /api/v2/path" to [status, body] or a function (call index aware). */
  function fakeFetch(answers) {
    const calls = [];
    const fn = async (url, init) => {
      const u = new URL(url); const key = `${init.method} ${u.pathname}`;
      calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : undefined });
      let a = answers[key] ?? answers["*"] ?? [404, { message: "Not Found" }];
      if (typeof a === "function") a = a(calls.filter(c => `${c.method} ${c.path}` === key).length);
      if (a instanceof Error) throw a;
      const [status, body] = a;
      return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)) };
    };
    fn.calls = calls;
    return fn;
  }
  const keyCreds = (keys) => new Map(Object.entries(keys).map(([c, key]) => [c, { mode: "key", key }]));
  const client = (fetchImpl, keys = { SWN6T: KEY }, extra = {}) => new ClearviewClient({ baseUrl: "https://api.example.test/", credentials: keyCreds(keys), timeoutMs: 20000, fetchImpl, sleep: async () => {}, ...extra });
  const TOKEN_URL = "https://login.example.test/oauth2/token";
  const oauthCreds = (companies = ["SWN6T"]) => new Map(companies.map(c => [c, { mode: "oauth", tokenUrl: TOKEN_URL, scope: "api://clearview/.default", clientId: `cid-${c}`, clientSecret: `secret-${c}` }]));
  const oauthClient = (fetchImpl, extra = {}) => new ClearviewClient({ baseUrl: "https://api.example.test", credentials: oauthCreds(), timeoutMs: 20000, fetchImpl, sleep: async () => {}, ...extra });
  /** fetch stub for OAuth: token endpoint answers from `token`, API calls from `answers` (as fakeFetch). */
  function oauthFetch(answers, token = () => [200, { access_token: "tok-1", expires_in: 3600, token_type: "Bearer" }]) {
    const api = fakeFetch(answers);
    const tokenCalls = [];
    const fn = async (url, init) => {
      if (url === TOKEN_URL) {
        tokenCalls.push({ body: Object.fromEntries(new URLSearchParams(init.body)), headers: init.headers });
        const [status, body] = token(tokenCalls.length);
        return { ok: status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
      }
      api.calls[api.calls.length] = undefined; api.calls.pop();
      const r = await api(url, init);
      api.calls[api.calls.length - 1].auth = init.headers.Authorization ?? null;
      return r;
    };
    fn.calls = api.calls; fn.tokenCalls = tokenCalls;
    return fn;
  }

  await test("client: key mode - authorizationKey only as a query parameter, per company; no credentials -> error without network; key never in messages", async () => {
    const f = fakeFetch({ "GET /api/v2/organization/stores": [200, { organizationId: 18, stores: [] }] });
    const c = client(f, { SWN6T: KEY, SWNGK: "99999999-0000-0000-0000-000000000000" });
    eq((await c.get("swn6t", "/organization/stores", { includeInactiveStores: false })).organizationId, 18);
    eq(f.calls[0].query, { includeInactiveStores: "false", authorizationKey: KEY });
    assert(f.calls[0].path === "/api/v2/organization/stores");
    eq(c.hasKey("SWNGK"), true); eq(c.hasKey("M9WOJ"), false); eq(c.hasKey(null), false); eq(c.companies(), ["SWN6T", "SWNGK"]);
    let err = null; try { await c.get("M9WOJ", "/organization/stores"); } catch (e) { err = e; }
    assert(err instanceof ClearviewError && err.status === 0 && /no credentials for company M9WOJ/.test(err.message)); eq(f.calls.length, 1);
    const g = fakeFetch({ "GET /api/v2/employee/5": [401, "Unauthorized"] });
    err = null; try { await client(g).get("SWN6T", "/employee/5"); } catch (e) { err = e; }
    eq(err.status, 401); assert(!err.message.includes(KEY) && !err.message.includes("authorizationKey"), err.message);
    eq(err.message, "Clearview 401 on GET /employee/5: Unauthorized");
  });

  await test("client: GET retried on 429 / 5xx / network (then fails), writes never retried; 404 -> null via getOrNull; 20 s timeout setting", async () => {
    const f = fakeFetch({ "GET /api/v2/job": (n) => (n < 3 ? [503, "busy"] : [200, [{ jobId: 1 }]]) });
    eq((await client(f).get("SWN6T", "/job")).length, 1); eq(f.calls.length, 3);
    const g = fakeFetch({ "GET /api/v2/job": [500, { message: "boom" }] });
    let err = null; try { await client(g).get("SWN6T", "/job"); } catch (e) { err = e; }
    eq([err.status, g.calls.length], [500, 3]); eq(err.message, "Clearview 500 on GET /job: boom");
    const h = fakeFetch({ "POST /api/v2/employee/import": [503, ""] });
    err = null; try { await client(h).post("SWN6T", "/employee/import", { a: 1 }); } catch (e) { err = e; }
    eq([err.status, h.calls.length], [503, 1], "POST not retried"); eq(err.message, "Clearview 503 on POST /employee/import");
    const n = fakeFetch({ "GET /api/v2/job": Object.assign(new Error("fetch failed"), { name: "TypeError" }) });
    err = null; try { await client(n).get("SWN6T", "/job"); } catch (e) { err = e; }
    eq([err.status, n.calls.length], [0, 3]); eq(err.message, "Clearview request failed on GET /job: TypeError");
    eq(await client(fakeFetch({})).getOrNull("SWN6T", "/employee/externalId/E1"), null);
    const p = fakeFetch({ "PATCH /api/v2/employee/5": [200, ""] });
    eq(await client(p).patch("SWN6T", "/employee/5", [{ op: "replace", path: "x", value: 1 }]), null);
    eq(p.calls[0].body, [{ op: "replace", path: "x", value: 1 }]);
  });

  await test("client: oauth mode - client-credentials token request, bearer header, no authorizationKey, token cached until expiry minus 60 s", async () => {
    let now = Date.parse("2026-11-02T15:00:00Z");
    const f = oauthFetch({ "GET /api/v2/organization/stores": [200, { organizationId: 18 }], "GET /api/v2/job": [200, []] });
    const c = oauthClient(f, { now: () => now });
    eq((await c.get("SWN6T", "/organization/stores", { includeInactiveStores: false })).organizationId, 18);
    eq(f.tokenCalls.length, 1);
    eq(f.tokenCalls[0].body, { grant_type: "client_credentials", client_id: "cid-SWN6T", client_secret: "secret-SWN6T", scope: "api://clearview/.default" });
    eq(f.tokenCalls[0].headers["Content-Type"], "application/x-www-form-urlencoded");
    eq(f.calls[0].auth, "Bearer tok-1"); eq(f.calls[0].query, { includeInactiveStores: "false" }, "no authorizationKey in oauth mode");
    await c.get("SWN6T", "/job"); eq(f.tokenCalls.length, 1, "token reused"); eq(c.tokenRequestCount, 1);
    now += (3600 - 61) * 1000;                                            // 61 s before expiry: outside the 60 s margin, still cached
    await c.get("SWN6T", "/job"); eq(f.tokenCalls.length, 1, "still cached 61 s before expiry");
    now += 2 * 1000;                                                      // 59 s before expiry: inside the margin -> refresh
    await c.get("SWN6T", "/job"); eq(f.tokenCalls.length, 2, "refreshed 60 s before expiry");
    let err = null; try { await c.get("SWNGK", "/job"); } catch (e) { err = e; }
    eq(err.message, "Clearview: no credentials for company SWNGK");
    const bad = oauthFetch({}, () => [400, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided" }]);
    err = null; try { await oauthClient(bad).get("SWN6T", "/job"); } catch (e) { err = e; }
    eq([err.status, err.message], [400, "Clearview token request 400 for SWN6T: AADSTS7000215: Invalid client secret provided"]);
    assert(!err.message.includes("secret-SWN6T") && !err.message.includes("cid-"), "secret never in messages");
    const noToken = oauthFetch({}, () => [200, { token_type: "Bearer" }]);
    err = null; try { await oauthClient(noToken).get("SWN6T", "/job"); } catch (e) { err = e; }
    assert(/has no access_token/.test(err.message), err.message);
  });

  await test("client: oauth 401 -> one token refresh and retry, a second 401 fails; first successful call per organization logged once per process", async () => {
    _resetFirstCallLog();
    const logs = [];
    let f = oauthFetch({ "GET /api/v2/job": (n) => (n === 1 ? [401, "expired"] : [200, [{ jobId: 1 }]]) }, (n) => [200, { access_token: `tok-${n}`, expires_in: 3600 }]);
    const c = oauthClient(f, { log: m => logs.push(m) });
    eq((await c.get("SWN6T", "/job")).length, 1);
    eq(f.tokenCalls.length, 2); eq(f.calls.map(x => x.auth), ["Bearer tok-1", "Bearer tok-2"]);
    eq(logs, ["[clearview] first call this process org=SWN6T"]);
    await c.get("SWN6T", "/job"); eq(logs.length, 1, "logged once per process");
    const other = new ClearviewClient({ baseUrl: "https://api.example.test", credentials: oauthCreds(["SWN6T", "SWNGK"]), timeoutMs: 1000, fetchImpl: f, sleep: async () => {}, log: m => logs.push(m) });
    await other.get("SWN6T", "/job"); eq(logs.length, 1, "another client instance, same process, same org: no second line");
    await other.get("SWNGK", "/job"); eq(logs[1], "[clearview] first call this process org=SWNGK");
    f = oauthFetch({ "GET /api/v2/job": [401, "nope"] });
    let err = null; try { await oauthClient(f).get("SWN6T", "/job"); } catch (e) { err = e; }
    eq([err.status, f.tokenCalls.length, f.calls.length], [401, 2, 2]); eq(err.message, "Clearview 401 on GET /job: nope");
    f = oauthFetch({ "POST /api/v2/employee/import": (n) => (n === 1 ? [401, ""] : [200, ""]) });
    eq(await oauthClient(f).post("SWN6T", "/employee/import", { a: 1 }), null); eq(f.calls.length, 2, "a write is retried once after a token refresh, never on other errors");
    _resetFirstCallLog();
  });

  await test("client: safeMessage picks Clearview's message, truncates, masks 9+ digit runs, never echoes payload values", () => {
    eq(safeMessage(JSON.stringify({ message: "Could not convert string to integer: FIN", path: "reportingStore" })), "Could not convert string to integer: FIN");
    eq(safeMessage(JSON.stringify({ title: "One or more validation errors occurred.", errors: { hireDate: ["must follow termination"] } })), "One or more validation errors occurred.");
    eq(safeMessage(JSON.stringify({ errors: { sin: [`value ${SIN} invalid`] } })), "sin: value ********* invalid");
    eq(safeMessage("x".repeat(400)).length, 200);
    eq(safeMessage("line1\n  line2"), "line1 line2");
  });

  // ---------------------------------------------------------------- connector ----------------------------------------------------------------
  const ctxFor = (over = {}) => ({
    delivery: { deliveryId: 1, destination: "clearview", employeeId: "EWLTH200NRY0", eventKey: null, kind: "event", eventType: "Pay change", action: "pay", effectiveDate: "2026-11-01", store: "T22446", status: "pending", attempts: 0 },
    event: { eventType: "Pay change", effectiveDate: "2026-11-01", fromCompany: null, toCompany: "SWN6T", fromStore: null, toStore: "T22446", fromJob: null, toJob: null, terminationCategory: null },
    employment: { employeeId: "EWLTH200NRY0", companyId: "SWN6T", employeeNumber: "100234", isHomeCompany: true, employeeStatus: "A", originalHireDate: null, lastHireDate: "2026-11-05", terminationDate: null, orgLevel2: "T22446", jobCode: "TM", fullOrPartTime: "P", firstName: "Ann", preferredName: null, lastName: "Example" },
    xref: { externalId: "55501", source: "extract" }, codes: null, storeMode: "live", lastSent: new Map(), ...over
  });
  const planOf = (operation, payload) => ({ operation, steps: [], payload });
  const connector = (f, log) => new ClearviewConnector(client(f), { companies: ["SWN6T", "SWNGK"], excludedJobs: ["MM"], terminationReasonId: 13078 }, log);
  const seq = (f) => f.calls.map(c => `${c.method} ${c.path.replace("/api/v2", "")}`);
  const emp = (status, extra = {}) => ({ standardInformation: { employeeId: 55501, status, lastName: "Example", employeeNumber: "100234" }, ...extra });

  await test("connector: terminate - GET first; active -> POST; already inactive same date -> sent without a call; other date -> PUT", async () => {
    const payload = { terminationDate: "2026-10-18", terminationReasonId: 13078 };
    let f = fakeFetch({ "GET /api/v2/employee/55501": [200, emp("Active")], "POST /api/v2/employeeStatus/55501/terminate": [200, { employeeId: 55501 }] });
    let r = await connector(f).execute(planOf("terminate", payload), ctxFor());
    eq(seq(f), ["GET /employee/55501", "POST /employeeStatus/55501/terminate"]); eq(f.calls[1].body, payload); eq(r, { responseRef: "terminate:55501", xref: undefined });
    f = fakeFetch({ "GET /api/v2/employee/55501": [200, emp("Inactive", { terminationInformation: { terminationDate: "2026-10-18" } })] });
    r = await connector(f).execute(planOf("terminate", payload), ctxFor());
    eq(seq(f), ["GET /employee/55501"]); eq(r.warning, "already terminated in Clearview on this date");
    f = fakeFetch({ "GET /api/v2/employee/55501": [200, emp("I", { terminationInformation: { terminationDate: "2026-10-10" } })], "PUT /api/v2/employeeStatus/55501/terminate": [200, {}] });
    r = await connector(f).execute(planOf("terminate", payload), ctxFor());
    eq(seq(f), ["GET /employee/55501", "PUT /employeeStatus/55501/terminate"]); eq(r.warning, "termination date changed from 2026-10-10");
  });

  await test("connector: employee lookup without xref - externalId, then employeeNumber + last name (matched xref); mismatch -> waiting", async () => {
    const payload = { terminationDate: "2026-10-18", terminationReasonId: 13078 };
    let f = fakeFetch({ "GET /api/v2/employee/externalId/EWLTH200NRY0": [200, emp("Active")], "GET /api/v2/employee/55501": [200, emp("Active")], "POST /api/v2/employeeStatus/55501/terminate": [200, {}] });
    let r = await connector(f).execute(planOf("terminate", payload), ctxFor({ xref: null }));
    eq(seq(f)[0], "GET /employee/externalId/EWLTH200NRY0"); eq(r.xref, { externalId: "55501", source: "matched" });
    f = fakeFetch({ "GET /api/v2/employee/employeeNumber/100234": [200, emp("Active")], "GET /api/v2/employee/55501": [200, emp("Active")], "POST /api/v2/employeeStatus/55501/terminate": [200, {}] });
    r = await connector(f).execute(planOf("terminate", payload), ctxFor({ xref: null }));
    eq(seq(f).slice(0, 2), ["GET /employee/externalId/EWLTH200NRY0", "GET /employee/employeeNumber/100234"]); eq(r.xref.source, "matched");
    const logs = [];
    f = fakeFetch({ "GET /api/v2/employee/employeeNumber/100234": [200, { standardInformation: { employeeId: 777, status: "Active", lastName: "Other" } }] });
    let err = null; try { await connector(f, m => logs.push(m)).execute(planOf("terminate", payload), ctxFor({ xref: null })); } catch (e) { err = e; }
    assert(err instanceof DeliveryError && err.kind === "waiting", String(err)); eq(err.message, "employee not in Clearview yet (import not added by Payroll, or never sent)");
    eq(seq(f).length, 2, "no write when the employee is unknown"); eq(logs.length, 1); assert(!logs[0].includes("Other"), "names never logged");
    f = fakeFetch({});
    err = null; try { await connector(f).execute(planOf("pay", {}), ctxFor({ xref: null })); } catch (e) { err = e; }
    eq(err.kind, "waiting");
  });

  await test("connector: store transfer - GET assignments, POST new, end the open previous one (PUT), PATCH reporting store; existing assignment -> no POST; PATCH 400 -> warning only", async () => {
    const payload = { assignment: { storeId: 2283, startDate: "2026-11-03", nameOnRegister: "Ann Example" }, endPrevious: { assignmentId: "$lookup:previousAssignmentId", endDate: "2026-11-02" }, reportingStoreId: 2283 };
    const open = [{ assignmentId: 901, storeId: 18, storeNumber: 2462, startDate: "2025-01-01", endDate: null, employeeNameOnRegister: "Ann" }];
    let f = fakeFetch({ "GET /api/v2/employeeStoreAssignment/55501": [200, open], "POST /api/v2/employeeStoreAssignment/55501": [200, { assignmentId: 902 }],
                        "PUT /api/v2/employeeStoreAssignment/55501/assignment/901": [200, {}], "PATCH /api/v2/employee/55501": [200, {}] });
    let r = await connector(f).execute(planOf("store", payload), ctxFor({ delivery: { ...ctxFor().delivery, action: "store" } }));
    eq(seq(f), ["GET /employeeStoreAssignment/55501", "POST /employeeStoreAssignment/55501", "PUT /employeeStoreAssignment/55501/assignment/901", "PATCH /employee/55501"]);
    eq(f.calls[0].query.includeInactiveStoreAssignment, "false");
    eq(f.calls[1].body, payload.assignment);
    eq(f.calls[2].body, { storeId: 18, startDate: "2025-01-01", endDate: "2026-11-02", nameOnRegister: "Ann", idOnRegister: null });
    eq(f.calls[3].body, [{ op: "replace", path: "reportingStoreId", value: 2283 }]);
    eq(r, { responseRef: "assignment:902", warning: undefined, xref: undefined });
    const logs = [];
    f = fakeFetch({ "GET /api/v2/employeeStoreAssignment/55501": [200, [...open, { assignmentId: 950, storeId: 2283, startDate: "2026-11-03", endDate: null }]],
                    "PUT /api/v2/employeeStoreAssignment/55501/assignment/901": [200, {}], "PATCH /api/v2/employee/55501": [400, { message: "reportingStoreId is read only" }] });
    const c = connector(f, m => logs.push(m));
    r = await c.execute(planOf("store", payload), ctxFor());
    eq(seq(f), ["GET /employeeStoreAssignment/55501", "PUT /employeeStoreAssignment/55501/assignment/901", "PATCH /employee/55501"]);
    eq(r.responseRef, "assignment:950");
    eq(r.warning, "store assignment already present; reporting store not changed: Clearview 400 on PATCH /employee/55501: reportingStoreId is read only");
    await c.execute(planOf("store", payload), ctxFor());
    eq(logs.length, 1, "the PATCH rejection is logged once per run");
    const temp = { ...payload, endPrevious: null, reportingStoreId: null };
    f = fakeFetch({ "GET /api/v2/employeeStoreAssignment/55501": [200, open], "POST /api/v2/employeeStoreAssignment/55501": [200, { assignmentId: 903 }] });
    await connector(f).execute(planOf("store", temp), ctxFor());
    eq(seq(f), ["GET /employeeStoreAssignment/55501", "POST /employeeStoreAssignment/55501"], "temporary transfer ends nothing");
  });

  await test("connector: job - target already on file -> PUT primary; else POST with the current primary rate; old primary demoted; already primary -> no write", async () => {
    const payload = { add: { jobCode: 10, jobStatus: "A", primaryJob: true, payRate: "$lookup:currentPrimaryRate", effectiveDate: "2026-11-01" }, promote: { jobId: 9444, primaryJob: true, jobStatus: "A" }, demote: { jobId: "$lookup:primaryJobId", primaryJob: false, jobStatus: "I" } };
    const jobs = [{ jobId: 9441, jobCode: 1, jobStatus: "A", primary: true, payRates: [{ payId: 1, effectiveDate: "2025-01-01", payRate: 16 }, { payId: 2, effectiveDate: "2026-06-01", payRate: 17.5 }, { payId: 3, effectiveDate: "2099-01-01", payRate: 99 }] }];
    let f = fakeFetch({ "GET /api/v2/employeeJob/55501": [200, jobs], "POST /api/v2/employeeJob/55501/job": [200, [...jobs, { jobId: 9444, jobCode: 10 }]], "PUT /api/v2/employeeJob/55501/job/9441": [200, {}] });
    let r = await connector(f).execute(planOf("job", payload), ctxFor());
    eq(seq(f), ["GET /employeeJob/55501", "POST /employeeJob/55501/job", "PUT /employeeJob/55501/job/9441"]);
    eq(f.calls[0].query.includeInactiveJobs, "true");
    eq(f.calls[1].body, { jobCode: 10, jobStatus: "A", primaryJob: true, payRate: 17.5, effectiveDate: "2026-11-01" }, "rate = current primary rate (future-dated rows ignored)");
    eq(f.calls[2].body, { primaryJob: false, jobStatus: "I" }); eq(r.responseRef, "job:9444");
    eq(currentRate(jobs[0]), 17.5); eq(currentRate({ payRates: [] }), 0);
    f = fakeFetch({ "GET /api/v2/employeeJob/55501": [200, [...jobs, { jobId: 9444, jobCode: 10, jobStatus: "I", primary: false }]], "PUT /api/v2/employeeJob/55501/job/9444": [200, {}], "PUT /api/v2/employeeJob/55501/job/9441": [200, {}] });
    r = await connector(f).execute(planOf("job", payload), ctxFor());
    eq(seq(f), ["GET /employeeJob/55501", "PUT /employeeJob/55501/job/9444", "PUT /employeeJob/55501/job/9441"]); eq(f.calls[1].body, { primaryJob: true, jobStatus: "A" });
    f = fakeFetch({ "GET /api/v2/employeeJob/55501": [200, [{ jobId: 9444, jobCode: 10, jobStatus: "A", primary: true, payRates: [] }]] });
    r = await connector(f).execute(planOf("job", payload), ctxFor());
    eq(seq(f), ["GET /employeeJob/55501"]); eq(r.warning, "already the primary job in Clearview");
    f = fakeFetch({ "GET /api/v2/employeeJob/55501": [200, [{ jobId: 9441, jobCode: 1, jobStatus: "A", primary: true, payRates: [] }]] });
    let err = null; try { await connector(f).execute(planOf("job", payload), ctxFor()); } catch (e) { err = e; }
    eq([err.kind, err.message], ["dead", "no current primary pay rate in Clearview to carry over to the new job"]);
  });

  await test("connector: pay - POST on the primary job with the flat v2 body; same-date row with the same rate -> no write; different rate -> PUT", async () => {
    const payload = { effectiveDate: "2026-11-01", payTypeCode: "H", payRate: 18.25, salaryHours: null };
    const primary = (rates) => [{ jobId: 9441, jobCode: 1, jobStatus: "A", primary: true, payRates: rates }, { jobId: 9442, primary: false, payRates: [] }];
    let f = fakeFetch({ "GET /api/v2/employeeJob/55501": [200, primary([{ payId: 1, effectiveDate: "2026-06-01", payRate: 17.5 }])], "POST /api/v2/employeeJob/55501/job/9441/pay": [200, { payId: 7 }] });
    let r = await connector(f).execute(planOf("pay", payload), ctxFor());
    eq(seq(f), ["GET /employeeJob/55501", "POST /employeeJob/55501/job/9441/pay"]); eq(f.calls[1].body, payload); eq(r.responseRef, "pay:7");
    f = fakeFetch({ "GET /api/v2/employeeJob/55501": [200, primary([{ payId: 5, effectiveDate: "2026-11-01T00:00:00", payRate: 18.25 }])] });
    r = await connector(f).execute(planOf("pay", payload), ctxFor());
    eq(seq(f), ["GET /employeeJob/55501"]); eq(r.warning, "pay row already present with this rate");
    f = fakeFetch({ "GET /api/v2/employeeJob/55501": [200, primary([{ payId: 5, effectiveDate: "2026-11-01", payRate: 17 }])], "PUT /api/v2/employeeJob/55501/job/9441/pay/5": [200, {}] });
    r = await connector(f).execute(planOf("pay", payload), ctxFor());
    eq(seq(f), ["GET /employeeJob/55501", "PUT /employeeJob/55501/job/9441/pay/5"]); eq(r.responseRef, "pay:5");
    f = fakeFetch({ "GET /api/v2/employeeJob/55501": [200, []] });
    let err = null; try { await connector(f).execute(planOf("pay", payload), ctxFor()); } catch (e) { err = e; }
    eq(err.kind, "dead");
  });

  await test("connector: import - externalId GET, staging status GET, then POST; already in staging or already an employee -> no POST", async () => {
    const payload = { standardInformation: { firstName: "Ann", birthDate: `${FAKE_YEAR}-07-14` }, payAndBenefitInformation: { employeeNumber: "100234", sin: SIN }, additionalInformation: { externalId: "EWLTH200NRY0" } };
    let f = fakeFetch({ "POST /api/v2/employee/import": [200, ""] });
    let r = await connector(f).execute(planOf("import", payload), ctxFor({ xref: null }));
    eq(seq(f), ["GET /employee/externalId/EWLTH200NRY0", "GET /employee/import/100234/status", "POST /employee/import"]);
    eq(f.calls[2].body, payload); eq(r, { responseRef: "import:100234" });
    f = fakeFetch({ "GET /api/v2/employee/import/100234/status": [200, "AwaitingApproval"] });
    r = await connector(f).execute(planOf("import", payload), ctxFor({ xref: null }));
    eq(seq(f).length, 2); eq(r, { responseRef: "import:100234", warning: "already in Clearview staging (AwaitingApproval)" });
    f = fakeFetch({ "GET /api/v2/employee/import/100234/status": [200, "RejectedOrNotFound"], "POST /api/v2/employee/import": [200, ""] });
    r = await connector(f).execute(planOf("import", payload), ctxFor({ xref: null }));
    eq(seq(f).length, 3, "RejectedOrNotFound means not staged: import");
    f = fakeFetch({ "GET /api/v2/employee/externalId/EWLTH200NRY0": [200, emp("Active")] });
    r = await connector(f).execute(planOf("import", payload), ctxFor({ xref: null }));
    eq(seq(f).length, 1); eq(r.xref, { externalId: "55501", source: "matched" }); eq(r.responseRef, "employee:55501");
  });

  await test("connector: rehire - GET; active -> no write; rehire date on or before the Clearview termination -> dead; else PUT", async () => {
    const payload = { rehireDate: "2026-11-10", reportingStoreId: 18, storeAssignments: [{ storeId: 18 }], jobs: [{ jobKey: 9444, payTypeCode: "H", payRate: 17, primaryJobFlag: true }] };
    let f = fakeFetch({ "GET /api/v2/employee/55501": [200, emp("Inactive", { terminationInformation: { terminationDate: "2026-03-01" } })], "PUT /api/v2/employeeStatus/55501/rehire": [200, {}] });
    let r = await connector(f).execute(planOf("rehire", payload), ctxFor());
    eq(seq(f), ["GET /employee/55501", "PUT /employeeStatus/55501/rehire"]); eq(f.calls[1].body, payload); eq(r.responseRef, "rehire:55501");
    f = fakeFetch({ "GET /api/v2/employee/55501": [200, emp("Active")] });
    r = await connector(f).execute(planOf("rehire", payload), ctxFor());
    eq(seq(f).length, 1); eq(r.warning, "already active in Clearview; rehire not sent");
    f = fakeFetch({ "GET /api/v2/employee/55501": [200, emp("Inactive", { terminationInformation: { terminationDate: "2026-11-10" } })] });
    let err = null; try { await connector(f).execute(planOf("rehire", payload), ctxFor()); } catch (e) { err = e; }
    eq([err.kind, err.message], ["dead", "rehire date 2026-11-10 is not after the Clearview termination date 2026-11-10"]);
  });

  await test("connector: update PATCH; classification of Clearview errors (401/403 abort, 400/422/404 dead, 5xx/429/network retry); resolveCreated", async () => {
    const f = fakeFetch({ "PATCH /api/v2/employee/55501": [200, {}] });
    const body = [{ op: "replace", path: "empCatCode", value: "FullTime" }];
    eq(await connector(f).execute(planOf("update", body), ctxFor()), { responseRef: "employee:55501", xref: undefined }); eq(f.calls[0].body, body);
    eq([401, 403, 400, 422, 404, 500, 429, 0].map(s => classify(new ClearviewError(s, "m")).kind), ["abort", "abort", "dead", "dead", "dead", "retry", "retry", "retry"]);
    eq(classify(new Error("ECONNRESET")).kind, "retry"); eq(classify(new DeliveryError("waiting", "w")).kind, "waiting");
    let err = null; try { await connector(fakeFetch({ "GET /api/v2/employee/55501": [403, "Forbidden"] })).execute(planOf("terminate", {}), ctxFor()); } catch (e) { err = e; }
    eq([err.kind, err.message], ["abort", "Clearview 403 on GET /employee/55501: Forbidden"]);
    const pending = { deliveryId: 1, employeeId: "EWLTH200NRY0", companyId: "SWN6T", employeeNumber: "100234", lastName: "Example", finishedUtc: new Date() };
    eq(await connector(fakeFetch({ "GET /api/v2/employee/externalId/EWLTH200NRY0": [200, emp("Active")] })).resolveCreated(pending), { externalId: "55501", source: "created" });
    eq(await connector(fakeFetch({ "GET /api/v2/employee/employeeNumber/100234": [200, emp("Active")] })).resolveCreated(pending), { externalId: "55501", source: "created" });
    eq(await connector(fakeFetch({ "GET /api/v2/employee/employeeNumber/100234": [200, { standardInformation: { employeeId: 1, lastName: "Nope" } }] })).resolveCreated(pending), null);
    eq(await connector(fakeFetch({})).resolveCreated(pending), null);
    err = null; try { await connector(fakeFetch({ "*": [401, ""] })).resolveCreated(pending); } catch (e) { err = e; }
    eq(err.kind, "abort");
  });

  await test("connector: every read about an existing employee goes through ClearviewReads (Get Employees product); writes and import lookups stay on the client", async () => {
    const readCalls = [];
    const reads = {
      async employeeByExternalId(co, x) { readCalls.push(`byExternalId ${x}`); return null; },
      async employeeByNumber(co, n) { readCalls.push(`byNumber ${n}`); return emp("Active"); },
      async employee(co, id) { readCalls.push(`employee ${id}`); return emp("Active"); },
      async jobs(co, id, inactive) { readCalls.push(`jobs ${id} ${inactive}`); return [{ jobId: 9441, jobCode: 1, jobStatus: "A", primary: true, payRates: [{ payId: 1, effectiveDate: "2026-01-01", payRate: 17 }] }]; },
      async storeAssignments(co, id, inactive) { readCalls.push(`assignments ${id} ${inactive}`); return []; },
      async organizationEmployees() { readCalls.push("organizationEmployees"); return { employees: [] }; },
      async terminationReasons() { readCalls.push("terminationReasons"); return []; }
    };
    const f = fakeFetch({ "POST /api/v2/employeeStatus/55501/terminate": [200, {}], "POST /api/v2/employeeJob/55501/job/9441/pay": [200, { payId: 3 }],
                          "POST /api/v2/employeeStoreAssignment/55501": [200, { assignmentId: 1 }], "POST /api/v2/employee/import": [200, ""] });
    const c = new ClearviewConnector(client(f), { companies: ["SWN6T"], excludedJobs: [], terminationReasonId: 13078 }, () => {}, reads);
    await c.execute(planOf("terminate", { terminationDate: "2026-10-18", terminationReasonId: 13078 }), ctxFor({ xref: null }));
    await c.execute(planOf("pay", { effectiveDate: "2026-11-01", payTypeCode: "H", payRate: 18, salaryHours: null }), ctxFor());
    await c.execute(planOf("store", { assignment: { storeId: 2283, startDate: "2026-11-03", nameOnRegister: "x" }, endPrevious: null, reportingStoreId: null }), ctxFor());
    await c.execute(planOf("import", { payAndBenefitInformation: { employeeNumber: "100234" } }), ctxFor({ xref: null }));
    await c.resolveCreated({ deliveryId: 1, employeeId: "EWLTH200NRY0", companyId: "SWN6T", employeeNumber: "100234", lastName: "Example", finishedUtc: new Date() });
    eq(readCalls, ["byExternalId EWLTH200NRY0", "byNumber 100234", "employee 55501", "jobs 55501 false", "assignments 55501 false", "byExternalId EWLTH200NRY0", "byExternalId EWLTH200NRY0", "byNumber 100234"]);
    eq(seq(f), ["POST /employeeStatus/55501/terminate", "POST /employeeJob/55501/job/9441/pay", "POST /employeeStoreAssignment/55501", "GET /employee/import/100234/status", "POST /employee/import"]);
    assert(!f.calls.some(x => x.method === "GET" && /\/employee\/(?!import\/)|employeeJob\/|employeeStoreAssignment\//.test(x.path)), "no employee read reached the client (import status is a New Hires lookup and stays)");
    const api = new ClearviewApiReads(client(fakeFetch({ "GET /api/v2/employeeJob/5": [200, [{ jobId: 1 }]], "GET /api/v2/terminationReason": [200, ""] })));
    eq((await api.jobs("SWN6T", 5, true)).length, 1); eq(await api.terminationReasons("SWN6T"), []); eq(await api.employeeByNumber("SWN6T", "1"), null);
  });

  // ---------------------------------------------------------------- discovery ----------------------------------------------------------------
  function discoveryStore(over = {}) {
    const s = {
      written: [], xrefs: [], existing: over.existing ?? { store: new Map(), job: new Map(), termination: new Map(), category: new Map(), company: new Map() },
      async hubStores() { return over.hubStores ?? ["T02462", "T22446", "T00037"]; },
      async allCodes() { return s.existing; },
      async upsertCodes(rows) { s.written.push(...rows); },
      async employeesWithoutXref() { return over.employees ?? []; },
      async upsertXrefMany(rows) { s.xrefs.push(...rows); }
    };
    return s;
  }

  await test("discover: stores paired on tdlNumber without its leading 1 (never the UKG code), company row written, jobs / reasons / attributes listed, unpaired reported", async () => {
    const f = fakeFetch({
      "GET /api/v2/organization/stores": [200, { organizationId: 18, name: "Org A", stores: [{ storeId: 2283, storeNumber: 122446, name: "Store 22446", status: "A" }, { storeId: 18, storeNumber: 2462, name: "Store 2462", status: "A" }, { storeId: 77, storeNumber: 7777, name: "Mystery", status: "A" }] }],
      "GET /api/v2/store/2283": [200, { storeId: 2283, tdlNumber: "122446", employerCode: "O01189" }],
      "GET /api/v2/store/18": [200, { storeId: 18, tdlNumber: "102462", employerCode: "O01189" }],
      "GET /api/v2/store/77": [200, { storeId: 77, tdlNumber: null }],
      "GET /api/v2/job": [200, [{ jobId: 9441, organizationId: 18, jobCode: 1, jobName: "Counter Staff", jobAbbreviation: "CS", jobStatus: "A" }, { jobId: 9444, jobCode: 10, jobName: "Supervisor", jobAbbreviation: "SV", jobStatus: "A" }]],
      "GET /api/v2/terminationReason": [200, [{ terminationReasonId: 13078, name: "Resigned", code: "RES" }]],
      "GET /api/v2/organization/filecontrol": [200, [{ attributeName: "SocialInsuranceNumber", isRequired: true }, { attributeName: "BirthDate", isRequired: true }]]
    });
    const existing = { store: new Map(), job: new Map([["GM", { destinationCode: "4", destinationId: "9442" }], ["TM", { destinationCode: "1", destinationId: "9441" }]]), termination: new Map([["VOLUNTARY", { destinationCode: "13078", destinationId: "13078" }], ["OLD", { destinationCode: "1", destinationId: "1" }]]), category: new Map(), company: new Map() };
    const s = discoveryStore({ existing });
    const byKey = async (url, init) => new URL(url).searchParams.get("authorizationKey") === "x"        // the second key belongs to no organization
      ? { ok: false, status: 404, text: async () => JSON.stringify({ message: "Not Found" }) } : f(url, init);
    const report = await discover(client(byKey, { SWN6T: KEY, SWNGK: "x" }), s, { companies: ["SWN6T", "SWNGK", "M9WOJ"] });
    eq(report.stores.paired, 2); eq(report.stores.unpairedHub, ["T00037"]);
    eq(report.stores.unpairedClearview.map(x => x.storeId), [77]);
    eq(s.written.find(r => r.codeType === "store" && r.ukgCode === "T22446"), { codeType: "store", ukgCode: "T22446", destinationCode: "122446", destinationId: "2283", notes: "org 18 · tdl 122446 · Store 22446" });
    eq(s.written.find(r => r.codeType === "store" && r.ukgCode === "T02462").destinationCode, "2462");
    eq(s.written.find(r => r.codeType === "company"), { codeType: "company", ukgCode: "SWN6T", destinationCode: "18", destinationId: null, notes: "employerCode O01189 · Org A" });
    const org = report.organizations[0];
    eq(org.jobs.map(j => `${j.jobCode} ${j.name} ${j.abbreviation}`), ["1 Counter Staff CS", "10 Supervisor SV"]);
    eq(org.terminationReasons, [{ terminationReasonId: 13078, name: "Resigned", code: "RES" }]); eq(org.mandatoryAttributes, ["SocialInsuranceNumber", "BirthDate"]);
    eq(org.employerCode, "O01189"); eq(org.stores.find(x => x.storeId === 18).pairedWith, "T02462");
    assert(report.organizations[1].error, "second company's key failed (404 fake) and is reported");   // SWNGK key hits the 404 default
    eq(report.organizations[2].error, "no authorizationKey");
    eq(report.staleMappings, [{ codeType: "job", ukgCode: "GM", destinationCode: "4", destinationId: "9442" }, { codeType: "termination", ukgCode: "OLD", destinationCode: "1", destinationId: "1" }]);
    eq(tdlDigits("122446"), "22446"); eq(tdlDigits("102462"), "2462"); eq(tdlDigits("2462"), null); eq(hubDigits("T02462"), "2462"); eq(hubDigits("T22446"), "22446");
    assert(f.calls.every(c => c.method === "GET"), "discovery only reads");
    assert(f.calls.some(c => c.path === "/api/v2/organization/filecontrol" && c.query.requiredAttributesOnly === "true"));
  });

  await test("discover employees: xref 'extract' by employeeNumber + last name; mismatches and unmatched counted; no names in the report", async () => {
    const f = fakeFetch({ "GET /api/v2/organization/employees": [200, { organizationId: 18, employees: [
      { employeeId: 501, employeeNumber: "000100234", lastName: "Example" }, { employeeId: 502, employeeNumber: "100235", lastName: "Wrong" }, { employeeId: 503, employeeNumber: "999", lastName: "Nobody" }] }] });
    const s = discoveryStore({ employees: [{ employeeId: "E1", companyId: "SWN6T", employeeNumber: "100234", lastName: "EXAMPLE" }, { employeeId: "E2", companyId: "SWN6T", employeeNumber: "100235", lastName: "Right" }, { employeeId: "E3", companyId: "SWN6T", employeeNumber: null, lastName: "X" }] });
    const report = await discover(client(f), s, { companies: ["SWN6T"], what: "employees" });
    eq(s.xrefs, [{ employeeId: "E1", externalId: "501", source: "extract" }]);
    eq(report.employees, { clearview: 3, hubWithoutXref: 3, matched: 1, lastNameMismatch: 1, unmatchedHub: 2 });
    eq(f.calls[0].query.includeInactiveEmployee, "true");
    const text = JSON.stringify(report);
    assert(!text.includes("Example") && !text.includes("Wrong") && !text.includes("Right"), "report carries no names");
  });

  report("clearview client / connector / discovery");
};
