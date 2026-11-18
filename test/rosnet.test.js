/* Rosnet EDT connector: client (transport, token, error shapes), mapper (pure), connector (state-driven calls) and
   discovery, against a stateful stand-in for the EDT API whose response shapes are the sandbox's (write test of
   2026-11-17: fixtures/rosnet/sandbox-shapes.json). No network, synthetic data only. */
const path = require("path");
const fs = require("fs");
const { DIST, FAKE_YEAR, test, report, assert, eq, noYear } = require("./helpers");

const SHAPES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "rosnet", "sandbox-shapes.json"), "utf8"));
const { codeKey, MappingError, DeliveryError, payloadHash } = require(path.join(DIST, "shared", "delivery.js"));
const UID = "EWLTH200NRY0";
const SENS = { sin: "123456789", dateOfBirth: `${FAKE_YEAR}-03-09`, email: "dana@example.com", salaryOrHourly: "H", hourlyPayRate: 17.256, annualSalary: null };

function codes() {
  const m = pairs => new Map(Object.entries(pairs).map(([k, v]) => [codeKey("", k), { ukgCode: k, company: "", destinationCode: v, destinationId: null }]));
  return { store: m({ W06000: "6000", W06010: "6010", W06018: "6018" }), job: m({ CM: "1", CL: "5", CT: "5", SS: "200", GM: "650" }),
           termination: m({ Voluntary: "20", Involuntary: "1", Leave: "3", Transfer: "100", "No-show": "2", Default: "1" }), category: new Map(), company: new Map() };
}
function ctxOf(action, eventType, over = {}) {
  const delivery = { deliveryId: 1, destination: "rosnet", employeeId: UID, eventKey: null, kind: "event", status: "pending", attempts: 0, eventType, action,
                     effectiveDate: "2026-11-10", store: "W06000", ...(over.delivery ?? {}) };
  const event = { eventType, effectiveDate: delivery.effectiveDate, fromCompany: null, toCompany: null, fromStore: null, toStore: null, fromJob: null, toJob: null, terminationCategory: null, ...(over.event ?? {}) };
  const employment = { employeeId: UID, companyId: "SWN1U", employeeNumber: "100234", isHomeCompany: true, employeeStatus: "A", originalHireDate: "2026-11-10", lastHireDate: "2026-11-10",
                       terminationDate: null, orgLevel2: "W06000", jobCode: "CM", fullOrPartTime: "P", firstName: "Dana", preferredName: "Dee", lastName: "O'Neil", ...(over.employment ?? {}) };
  return { delivery, event, employment, xref: over.xref ?? null, codes: over.codes ?? codes(), storeMode: "live", lastSent: new Map() };
}

/** Stateful stand-in for the EDT API, used as the client's transport. Errors are the sandbox's double-encoded JSON strings. */
function fakeRosnet(opts = {}) {
  const emps = new Map(), calls = [];
  let nextPos = 100, tokens = 0;
  const key = (uid, loc) => `${uid}|${loc}`;
  const err = (code, msg) => ({ status: 400, headers: { "content-type": "application/json" }, text: JSON.stringify(JSON.stringify({ errorCode: code, errorMessage: msg })) });
  const ok = (status, body) => ({ status, headers: {}, text: body === undefined ? "" : JSON.stringify(body) });
  const none = route => ({ status: SHAPES.noProfile[route].status, headers: {}, text: SHAPES.noProfile[route].body });      // what the sandbox answers for nobody
  const cfc = e => ({ ...SHAPES.cfcEmployee, birthDate: `${FAKE_YEAR}-03-09T00:00:00Z`, ssn: "", emailAddress: e.email ?? "", employeeUniqueID: e.uid, firstName: e.first, lastName: e.last,
    homeSiteID: `3126,${e.loc}`, jobs: [...e.jobs.keys()].map(c => ({ ...SHAPES.cfcEmployee.jobs[0], jobCodeNumber: c })),
    pos: { ...SHAPES.cfcEmployee.pos, alohaExportID: e.payroll, posCode: String(e.posId), alohaTermCode: e.active ? "0" : "1" },
    status: { ...SHAPES.cfcEmployee.status, employmentStatus: e.active ? "active" : "terminated", lastDay: e.active ? "1899-01-01T00:00:00Z" : `${e.lastDay}T00:00:00Z` } });
  const add = (uid, loc, o = {}) => { const e = { uid, loc, first: "Dana", last: "ONeil", payroll: "100234", posId: nextPos++, active: true, lastDay: null, jobs: new Map([[1, 16.5]]), email: null, ...o }; emps.set(key(uid, loc), e); return e; };
  const jobsOf = info => new Map((info ?? []).map(j => [j.jobCode, j.payRate]));
  const transport = async req => {
    const u = new URL(req.url), p = u.pathname;
    const body = req.body !== undefined && req.headers["Content-Type"] === "application/json" ? JSON.parse(req.body) : req.body;
    calls.push({ method: req.method, path: p, host: u.host, headers: req.headers, body });
    if (opts.intercept) { const r = opts.intercept(req.method, p, calls.filter(c => c.method === req.method && c.path === p).length); if (r instanceof Error) throw r; if (r) return r; }
    if (p === "/connect/token") return new URLSearchParams(req.body).get("client_secret") === "s3cret" ? ok(200, { access_token: `tok${++tokens}`, expires_in: 3600, token_type: "Bearer", scope: "wfm.write" }) : ok(400, { error: "invalid_client" });
    if (!/^Bearer tok\d+$/.test(req.headers.Authorization ?? "")) return ok(401);
    const m = p.match(/^\/api\/v1\.0(\/.*)$/);
    if (!m) return ok(404);
    const seg = m[1].split("/").filter(Boolean).map(decodeURIComponent);
    if (req.method === "GET") {
      if (seg[0] === "Location") return ok(200, { clientCode: "QUICKWEN", locationNumbers: [6010, 6000, 6018] });
      if (seg[0] === "JobCodes") return ok(200, SHAPES.jobCodes);
      if (seg[0] === "TermCodes") return ok(200, SHAPES.termCodes);
      if (seg[1] === "getEmployee") { const e = emps.get(key(seg[2], Number(seg[3]))); return e ? ok(200, [cfc(e)]) : none("GET /Employee/getEmployee"); }
      if (seg[1] === "getEmployeeByName") { const hits = [...emps.values()].filter(e => e.loc === Number(seg[4]) && e.first.toUpperCase() === seg[2].toUpperCase() && e.last.toUpperCase() === seg[3].toUpperCase());
                                            return hits.length ? ok(200, hits.map(cfc)) : none("GET /Employee/getEmployeeByName"); }
      if (seg[1] === "getMultipleEmployeeInfo") return ok(200, [...emps.values()].filter(e => e.loc === Number(seg[2])).map(e => ({ locationId: e.loc, payrollProviderEmployeeUID: e.payroll,
        posProviderEmployeeUID: e.uid, posEmployeeUID: String(e.posId), firstName: e.first, lastName: e.last, terminatedFlag: !e.active, status: e.active ? "Active" : "Inactive" })));
      return ok(404);
    }
    if (seg[0] === "PayRate") { const e = emps.get(key(body.posProvider_EmployeeUID, body.locationNumber)); return e ? ok(200, [...e.jobs].map(([jobCode, payRate]) => ({ ...SHAPES.payRateRow, jobCode, payRate }))) : none("POST /PayRate"); }
    const uid = body.posProvider_EmployeeUID, at = loc => emps.get(key(uid, loc));
    switch (seg[1]) {
      case "addEmployee": if (at(body.locationNumber)) return err(2500, SHAPES.errors.alreadyExists); add(uid, body.locationNumber, { payroll: body.payrollProvider_EmployeeUID, jobs: jobsOf(body.jobInfo), email: body.emailId }); return ok(200);
      case "rehireEmployee": {
        const target = at(body.locationNumber);
        if (target?.active) return err(2000, SHAPES.errors.alreadyActive);
        if (!at(body.oldLocationNumber)) return err(2100, "RehireEmployee failed. The employee was not found.");
        if (body.rehireIntoDifferentLocationFlag) return ok(200);                           // sandbox: accepted, and nothing happens (with or without a profile at the target)
        target.active = true; target.jobs = jobsOf(body.jobInfo);
        return ok(200);
      }
      case "terminateEmployee": { const e = at(body.locationNumber); if (body.employeeTerminationCode == null) return err(2800, SHAPES.errors.termCodeInvalid); if (!e) return err(2700, "TerminateEmployee failed. The employee was not found.");
                                  e.active = false; e.lastDay = body.terminationEffectiveDate.slice(0, 10); return ok(204); }
      case "transferEmployee": { const e = at(body.originalLocationNumber); if (!e) return err(2600, "TransferEmployee failed. The employee was not found.");
                                 add(uid, body.newLocationNumber, { payroll: body.payrollProvider_EmployeeUID, jobs: jobsOf(body.jobInfo) }); e.active = false; e.lastDay = body.eventEffectiveDate.slice(0, 10); return ok(200); }
      case "addJob": case "modifyJob": case "removeJob": { const e = at(body.locationNumber); if (!e) return err(3000, "Job change failed. The employee was not found.");
                                 if (body.jobInfo.jobCode === 99999) return err(3100, SHAPES.errors.jobCodeInvalid);
                                 if (seg[1] === "removeJob") e.jobs.delete(body.jobInfo.jobCode); else e.jobs.set(body.jobInfo.jobCode, body.jobInfo.payRate); return ok(204); }
      case "updateEmployeeInfo": { const e = at(body.locationNumber); if (!e) return err(3300, "UpdateEmployeeInfo failed. The employee was not found.");     // sandbox: 400 while the profile is not there
                                   if (body.emailId) e.email = body.emailId; if (body.firstName) e.first = body.firstName; if (body.lastName) e.last = body.lastName; return ok(204); }
    }
    return ok(404);
  };
  const api = () => calls.filter(c => c.path.startsWith("/api/"));
  const writes = () => api().filter(c => c.method !== "GET" && !c.path.endsWith("/PayRate")).map(c => `${c.method} ${c.path.replace("/api/v1.0", "")}`);
  return { transport, calls, emps, add, at: (uid, loc) => emps.get(key(uid, loc)), writes, lastBody: suffix => api().filter(c => c.path.endsWith(suffix)).pop()?.body };
}

module.exports = async () => {
  const { RosnetClient, RosnetError, problemOf, isNotFound, toCfcEmployee, isSandboxHost, DEFAULT_USER_AGENT } = require(path.join(DIST, "shared", "rosnet", "client.js"));
  const mapper = require(path.join(DIST, "shared", "rosnet", "mapper.js"));
  const { RosnetConnector, classify } = require(path.join(DIST, "shared", "rosnet", "connector.js"));
  const { discoverRosnet } = require(path.join(DIST, "shared", "rosnet", "discover.js"));
  const CFG = mapper.DEFAULT_ROSNET_CONFIG;
  const NOW = new Date("2026-11-17T18:31:30.123Z");

  const clientOf = (srv, over = {}) => new RosnetClient({ baseUrl: "https://wfmt-api.rosnet.com", apiVersion: "1.0", timeoutMs: 1000, transport: srv.transport, sleep: async () => {},
    credential: { tokenUrl: "https://iam.rosnet.com/connect/token", scope: "wfm.write", clientId: "wfm.TEST.Rosnet", clientSecret: "s3cret" }, ...over });
  const setup = (opts) => { const srv = fakeRosnet(opts); const logs = []; const connector = new RosnetConnector(clientOf(srv), CFG, m => logs.push(m), () => NOW); return { srv, logs, connector }; };
  const planOf = (ctx, sens = SENS, cfg = CFG) => mapper.plan(ctx, sens, cfg);
  const send = async (connector, ctx, sens = SENS) => { const o = connector.plan(ctx, sens); eq(o.decision, "send", `decision (${o.reason ?? ""})`); return connector.execute(o.plan, ctx); };
  const rejects = async (p, check, msg) => { try { await p; } catch (e) { assert(check(e), `${msg}: ${e && e.message}`); return e; } throw new Error(`${msg}: did not throw`); };

  // ---------------------------------------------------------------- client ----------------------------------------------------------------
  await test("rosnet client: form-encoded token once, cached; every request carries the descriptive User-Agent, Accept json and the bearer; /api/v1.0 routes", async () => {
    const srv = fakeRosnet(); const c = clientOf(srv);
    eq((await c.locations()).locationNumbers, [6000, 6010, 6018]);
    eq((await c.jobCodes()).length, SHAPES.jobCodes.length);
    eq(c.tokenRequestCount, 1);
    const [tok, loc] = srv.calls;
    eq([tok.host, tok.path, tok.headers["Content-Type"]], ["iam.rosnet.com", "/connect/token", "application/x-www-form-urlencoded"]);
    const form = new URLSearchParams(tok.body);
    eq([form.get("grant_type"), form.get("client_id"), form.get("scope")], ["client_credentials", "wfm.TEST.Rosnet", "wfm.write"]);
    eq([loc.host, loc.path, loc.headers.Authorization, loc.headers.Accept], ["wfmt-api.rosnet.com", "/api/v1.0/Location", "Bearer tok1", "application/json"]);
    assert(srv.calls.every(x => x.headers["User-Agent"] === DEFAULT_USER_AGENT), "User-Agent on every request, token included");
  });

  await test("rosnet client: a 401 refreshes the token once and repeats the call", async () => {
    const srv = fakeRosnet({ intercept: (m, p, n) => (p === "/api/v1.0/TermCodes" && n === 1 ? { status: 401, headers: {}, text: "" } : null) });
    const c = clientOf(srv);
    eq((await c.termCodes()).length, SHAPES.termCodes.length);
    eq(c.tokenRequestCount, 2);
  });

  await test("rosnet client: the sandbox's double-encoded error body gives the code and Rosnet's message; the message names the route template, never the path", async () => {
    eq(problemOf(SHAPES.errors.rawAlreadyExists), { code: 2500, message: "AddEmployee failed. The employee already exists." });
    eq(problemOf('{"title":"Bad Request","detail":"x 123456789012 y"}'), { code: null, message: "x ************ y" });
    // production shape of a model validation error (Flexspring transaction, 2026-11): the field error, not "See the errors property"
    const invalid = JSON.stringify({ type: "https://rosnet.com/modelvalidationproblem", title: "One or more model validation errors occurred.", status: 422, detail: "See the errors property for details.",
                                     instance: "/api/v1/Employee/addEmployee", errors: { "$.jobInfo[0].jobCode": ["The JSON value could not be converted to System.Int32."] }, traceId: "x" });
    eq(problemOf(invalid), { code: null, message: "$.jobInfo[0].jobCode: The JSON value could not be converted to System.Int32." });
    const srv = fakeRosnet({ intercept: (m, p) => (p.includes("getEmployeeByName") ? { status: 400, headers: {}, text: JSON.stringify(JSON.stringify({ errorCode: 3800, errorMessage: SHAPES.errors.noLocationAccess })) } : null) });
    const e = await rejects(clientOf(srv).employeesByName("Dana", "ONeil", 6000), x => x instanceof RosnetError && x.code === 3800 && x.status === 400, "3800 is an error, not a not-found");
    assert(e.message.includes("{first}/{last}/{location}") && !/Dana|ONeil/.test(e.message), "route template only");
  });

  await test("rosnet client: no profile = null / empty (Rosnet answers 200 [] and, for PayRate, 204); a 400 on a lookup is an error; the CFC record is reduced (no ssn, no birth date)", async () => {
    const empty = clientOf(fakeRosnet());
    eq([await empty.employee(UID, 6000), await empty.employeesByName("Dana", "ONeil", 6000), await empty.payRates(UID, 6000, "QUICKWEN")], [null, [], []]);
    assert(isNotFound(new RosnetError(404, "x")) && !isNotFound(new RosnetError(400, "GetEmployee failed. The employee was not found.")), "isNotFound: 404 only");
    const refused = fakeRosnet({ intercept: (m, p) => (p.includes("/getEmployee/") ? { status: 400, headers: {}, text: JSON.stringify(JSON.stringify({ errorCode: 2400, errorMessage: "GetEmployee failed. The employee was not found." })) } : null) });
    await rejects(clientOf(refused).employee(UID, 6000), x => x instanceof RosnetError && x.status === 400, "a 400 is never read as no profile");
    const srv = fakeRosnet(); srv.add(UID, 6000);
    const e = await clientOf(srv).employee(UID, 6000);
    eq(e, { uid: UID, firstName: "Dana", lastName: "ONeil", active: true, lastDay: null, rehireDate: null, jobs: [1], payrollId: "100234", posId: "100" });
    noYear(e, "reduced employee");
    eq(toCfcEmployee(SHAPES.cfcEmployee).jobs, [1]);
  });

  await test("rosnet client: reads are retried on 503 (PayRate included), writes never; a Cloudflare challenge is reported as such", async () => {
    let srv = fakeRosnet({ intercept: (m, p, n) => (p.endsWith("/PayRate") && n < 3 ? { status: 503, headers: {}, text: "" } : null) });
    eq(await clientOf(srv).payRates(UID, 6000, "QUICKWEN"), []);
    eq(srv.calls.filter(c => c.path.endsWith("/PayRate")).length, 3);
    srv = fakeRosnet({ intercept: (m, p) => (p.endsWith("/addEmployee") ? { status: 503, headers: {}, text: "" } : null) });
    await rejects(clientOf(srv).write("POST", "/Employee/addEmployee", { posProvider_EmployeeUID: UID }), x => x.status === 503, "write fails at once");
    eq(srv.calls.filter(c => c.path.endsWith("/addEmployee")).length, 1);
    srv = fakeRosnet({ intercept: () => ({ status: 403, headers: { "cf-mitigated": "challenge", "cf-ray": "abc-YYZ" }, text: "<html>Just a moment...</html>" }) });
    const e = await rejects(clientOf(srv).locations(), x => x.challenge === true, "challenge");
    assert(/Cloudflare/.test(e.message) && e.message.includes("abc-YYZ"), "challenge message");
    eq(classify(e).kind, "abort");
  });

  await test("rosnet client: no write ever goes to the sandbox when sandbox writes are off (the deployed app); reads still work", async () => {
    const srv = fakeRosnet();
    const c = clientOf(srv, { baseUrl: "https://wfmt-api.rosnetqa.com", allowSandboxWrites: false });
    assert(c.sandbox && isSandboxHost("https://iam.rosnetqa.com/connect/token") && !isSandboxHost("https://wfmt-api.rosnet.com"), "sandbox detection");
    await rejects(c.write("PUT", "/Employee/terminateEmployee", {}), x => x instanceof RosnetError && /SANDBOX/.test(x.message), "refused");
    eq(srv.calls.length, 0);
    eq((await c.locations()).clientCode, "QUICKWEN");
    eq(clientOf(srv, { credential: null }).hasCredentials(), false);
  });

  // ---------------------------------------------------------------- mapper ----------------------------------------------------------------
  await test("rosnet mapper: hire payload: legal first name, apostrophe stripped, UKG id and employee number as the two ids, no SIN, rate with 2 decimals, hire date", () => {
    const o = planOf(ctxOf("create", "New hire", { event: { toStore: "W06000" } }));
    eq(o.decision, "send"); eq(o.plan.operation, "hire");
    eq(o.plan.payload, { posProvider_EmployeeUID: UID, payrollProvider_EmployeeUID: "100234", firstName: "Dana", lastName: "ONeil", clientCode: "QUICKWEN", locationNumber: 6000,
      eventEffectiveDate: "2026-11-10T00:00:00", ssn: null, dob: `${FAKE_YEAR}-03-09T00:00:00`, emailId: "dana@example.com",
      jobInfo: [{ jobCode: 1, payRate: 17.26, eventEffectiveDate: "2026-11-10T00:00:00" }] });
    eq(o.plan.steps.map(s => `${s.method} ${s.path}`), [`GET /Employee/getEmployee/${UID}/6000`, "POST /Employee/addEmployee", "POST /Employee/rehireEmployee"]);
    eq([o.plan.steps[1].body.insertDate, o.plan.steps[2].body.rehireIntoDifferentLocationFlag], ["$now", false]);
    eq(mapper.sensitiveNeeds(ctxOf("create", "New hire")), ["person", "pay"]);
    eq(mapper.sensitiveNeeds(ctxOf("terminate", "Termination")), []);
  });

  await test("rosnet mapper: stored copy masks SIN, birth date, email and pay; the hash ignores nothing but those and does not change between runs", () => {
    const p1 = planOf(ctxOf("create", "New hire"), SENS, { ...CFG, sendSin: true }).plan;
    eq(p1.payload.ssn, "123456789");
    const stored = JSON.stringify({ steps: mapper.redactForStore(p1.steps), payload: mapper.redactForStore(p1.payload) });
    noYear(stored, "stored shadow copy");
    assert(!stored.includes("123456789") && !stored.includes("dana@example.com") && !stored.includes("17.26"), "SIN, email and rate masked in the stored copy");
    const h = x => payloadHash(mapper.redactForHash(x)).toString("hex");
    eq(h(p1.payload), h(planOf(ctxOf("create", "New hire"), SENS, { ...CFG, sendSin: true }).plan.payload), "stable");
    assert(h(p1.payload) !== h(planOf(ctxOf("create", "New hire"), { ...SENS, hourlyPayRate: 18 }, { ...CFG, sendSin: true }).plan.payload), "a rate change changes the hash");
    noYear(JSON.stringify(mapper.redactForHash(p1.payload)), "hash input");
  });

  await test("rosnet mapper: scope: other company skipped, M9WOJ review, a store that is not W##### skipped, update events skipped, a move to another company terminates at the W store", () => {
    eq(planOf(ctxOf("create", "New hire", { employment: { companyId: "SWN6T" } })).decision, "skipped");
    eq(planOf(ctxOf("create", "New hire", { employment: { companyId: "M9WOJ" } })).decision, "review");
    const ops = planOf(ctxOf("create", "New hire", { delivery: { store: "OPS" }, employment: { orgLevel2: "OPS" } }));
    eq([ops.decision, /not a Rosnet location/.test(ops.reason)], ["skipped", true]);
    eq(planOf(ctxOf("update", "Part-time to full-time")).decision, "skipped");
    eq(planOf(ctxOf("store", "Store transfer", { event: { fromStore: "W06000", toStore: "OPS" } })).decision, "review");
    const out = planOf(ctxOf("terminate", "Cross-company transfer out", { event: { fromCompany: "SWN1U", toCompany: "SWN6T", fromStore: "W06010", toStore: "T22446" }, employment: { companyId: "SWN6T", orgLevel2: "T22446" } }));
    eq([out.decision, out.plan.payload.locationNumber, out.plan.payload.employeeTerminationCode], ["send", 6010, 100]);
  });

  await test("rosnet mapper: validation is a MappingError: payroll id, date of birth, under 15, rate, unmapped store or job, SIN only when it is sent", () => {
    const bad = (ctx, sens, re, cfg) => { try { planOf(ctx, sens ?? SENS, cfg); } catch (e) { assert(e instanceof MappingError && re.test(e.message), `${re}: ${e.message}`); noYear(e.message, "error"); return; } throw new Error(`no error for ${re}`); };
    bad(ctxOf("create", "New hire", { employment: { employeeNumber: "A12" } }), null, /payroll id/);
    bad(ctxOf("create", "New hire", { employment: { employeeNumber: "1234567890" } }), null, /payroll id/);
    bad(ctxOf("create", "New hire"), { ...SENS, dateOfBirth: null }, /date of birth/);
    bad(ctxOf("create", "New hire"), { ...SENS, dateOfBirth: "2012-11-11" }, /younger than 15/);
    eq(planOf(ctxOf("create", "New hire"), { ...SENS, dateOfBirth: "2011-11-10" }).decision, "send", "15 on the day");
    bad(ctxOf("create", "New hire"), { ...SENS, hourlyPayRate: 0 }, /pay rate/);
    bad(ctxOf("create", "New hire", { employment: { jobCode: "DM" } }), null, /no rosnet job code for UKG job DM/);
    bad(ctxOf("create", "New hire", { delivery: { store: "W09999" }, employment: { orgLevel2: "W09999" } }), null, /no rosnet location/);
    bad(ctxOf("create", "New hire"), { ...SENS, sin: "12" }, /SIN/, { ...CFG, sendSin: true });
    eq(planOf(ctxOf("create", "New hire"), { ...SENS, sin: null }).plan.payload.ssn, null, "SIN not needed when it is not sent");
    eq(planOf(ctxOf("terminate", "Termination", { xref: { externalId: "OTHERUID", source: "matched", payrollId: "555" } })).plan.payload.payrollProvider_EmployeeUID, "555", "ids from the xref win");
  });

  await test("rosnet mapper: termination code by category, the Default row, then the setting; leave = Deactivate; never-worked = No Show", () => {
    const code = (type, over, c) => planOf(ctxOf("terminate", type, over ?? {}), SENS, c).plan.payload.employeeTerminationCode;
    eq(code("Termination", { event: { terminationCategory: "Voluntary" } }), 20);
    eq(code("Termination", { event: { terminationCategory: "Involuntary" } }), 1);
    eq(code("Leave of absence"), 3);
    eq(code("Hired but never worked"), 2);
    eq(code("Termination", { event: { terminationCategory: "Administrative" } }), 1, "no row -> Default");
    const bare = codes(); bare.termination = new Map();
    eq(code("Termination", { codes: bare }, { ...CFG, termCode: 7 }), 7, "no rows -> setting");
    const t = planOf(ctxOf("terminate", "Termination", { event: { terminationCategory: "Voluntary" } })).plan;
    eq([t.payload.terminationEffectiveDate, t.steps.map(s => s.method)], ["2026-11-10T00:00:00", ["GET", "PUT"]]);
  });

  await test("rosnet mapper: job change = add the new code, remove the old; two UKG jobs with one Rosnet code only bring the rate in line; pay change = modifyJob on the current job", () => {
    const j = planOf(ctxOf("job", "Promotion", { event: { fromJob: "CM", toJob: "SS" }, employment: { jobCode: "SS" } })).plan;
    eq([j.operation, j.payload.add, j.payload.remove], ["job", { jobCode: 200, payRate: 17.26, eventEffectiveDate: "2026-11-10T00:00:00" }, { jobCode: 1, eventEffectiveDate: "2026-11-10T00:00:00" }]);
    eq(j.steps.map(s => `${s.method} ${s.path}`).slice(1), ["PUT /Employee/addJob", "PUT /Employee/removeJob"]);
    const same = planOf(ctxOf("job", "Job change", { event: { fromJob: "CL", toJob: "CT" }, employment: { jobCode: "CT" } }));     // RMIT -> RMH in production: the rate changes with the job
    eq([same.decision, same.plan.operation, same.plan.payload.jobInfo.jobCode, same.plan.steps.map(s => s.path).slice(1)], ["send", "pay", 5, ["/PayRate", "/Employee/modifyJob"]]);
    eq(planOf(ctxOf("job", "Job change", { event: { fromJob: "ZZ", toJob: "SS" } })).plan.payload.remove, null);
    const p = planOf(ctxOf("pay", "Pay change")).plan;
    eq([p.operation, p.payload.jobInfo, p.steps.map(s => s.path).slice(1)], ["pay", { jobCode: 1, payRate: 17.26, eventEffectiveDate: "2026-11-10T00:00:00" }, ["/PayRate", "/Employee/modifyJob"]]);
  });

  // ---------------------------------------------------------------- connector ----------------------------------------------------------------
  await test("rosnet mapper: a name or email change = updateEmployeeInfo with the names and the email as they are now; other update events stay skipped", () => {
    const o = planOf(ctxOf("update", "Name change"));
    eq([o.decision, o.plan.operation, o.plan.steps.map(s => `${s.method} ${s.path}`)], ["send", "profile", [`GET /Employee/getEmployee/${UID}/6000`, "PUT /Employee/updateEmployeeInfo"]]);
    const b = o.plan.steps[1].body;
    eq([b.firstName, b.lastName, b.emailId, b.locationNumber, b.clientCode, b.posProvider_EmployeeUID, b.updateDate], ["Dana", "ONeil", "dana@example.com", 6000, "QUICKWEN", UID, "$now"]);
    eq(mapper.redactForStore(o.plan.steps)[1].body.emailId, "***@***", "email masked in the stored copy");
    assert(!("emailId" in planOf(ctxOf("update", "Email change"), { ...SENS, email: null }).plan.steps[1].body), "no email in UKG: the field is left out, never blanked");
    eq([mapper.sensitiveNeeds(ctxOf("update", "Name change")), mapper.sensitiveNeeds(ctxOf("update", "Part-time to full-time"))], [["person"], []]);
    eq(planOf(ctxOf("update", "Part-time to full-time")).decision, "skipped");
  });

  await test("rosnet connector: name / email change -> updateEmployeeInfo at the store, found by UID; terminated -> nothing; no profile yet -> retry", async () => {
    let s = setup(); s.srv.add(UID, 6000, { first: "Dan", last: "Oneill" });
    let r = await send(s.connector, ctxOf("update", "Name change"));
    eq(s.srv.writes(), ["PUT /Employee/updateEmployeeInfo"]);
    eq([s.srv.at(UID, 6000).first, s.srv.at(UID, 6000).last, s.srv.at(UID, 6000).email, r.responseRef, r.warning], ["Dana", "ONeil", "dana@example.com", "profile:6000", undefined]);
    eq(s.srv.calls.some(c => c.path.includes("getEmployeeByName")), false, "never searched by name");
    s = setup(); s.srv.add(UID, 6000, { active: false, lastDay: "2026-10-01" });
    r = await send(s.connector, ctxOf("update", "Email change"));
    eq([s.srv.writes(), /terminated/.test(r.warning)], [[], true]);
    s = setup();
    await rejects(send(s.connector, ctxOf("update", "Name change")), x => x.kind === "retry" && /no profile at Rosnet location 6000/.test(x.message), "retry");
  });

  await test("rosnet connector: hire with no profile at the location -> addEmployee with the send-time stamps; xref created; nothing read back", async () => {
    const { srv, connector } = setup();
    const r = await send(connector, ctxOf("create", "New hire"));
    eq(srv.writes(), ["POST /Employee/addEmployee"]);
    const b = srv.lastBody("/addEmployee");
    eq([b.insertDate, b.updateDate, b.ssn, b.locationNumber, b.posProvider_EmployeeUID, b.jobInfo[0].payRate], ["2026-11-17T18:31:30", "2026-11-17T18:31:30", null, 6000, UID, 17.26]);
    eq(r, { responseRef: "add:6000", warning: undefined, xref: { externalId: UID, source: "created", payrollId: "100234" } });
    assert(srv.at(UID, 6000).active, "added");
  });

  await test("rosnet connector: hire is decided by what Aloha holds: active -> nothing; terminated here -> rehire in place; no profile here -> add, even when a terminated profile exists at another store", async () => {
    let s = setup(); s.srv.add(UID, 6000);
    let r = await send(s.connector, ctxOf("create", "Rehire"));
    eq([s.srv.writes(), /already active/.test(r.warning), r.xref.posId], [[], true, "100"]);

    s = setup(); s.srv.add(UID, 6000, { active: false, lastDay: "2026-10-01" });
    r = await send(s.connector, ctxOf("create", "Return from leave"));
    eq(s.srv.writes(), ["POST /Employee/rehireEmployee"]);
    eq([s.srv.lastBody("/rehireEmployee").rehireIntoDifferentLocationFlag, s.srv.lastBody("/rehireEmployee").oldLocationNumber, r.responseRef, s.srv.at(UID, 6000).active], [false, 6000, "rehire:6000", true]);

    // terminated at both stores: rehired in place
    s = setup(); s.srv.add(UID, 6000, { active: false, lastDay: "2026-10-01" }); s.srv.add(UID, 6010, { active: false, lastDay: "2026-11-01" });
    r = await send(s.connector, ctxOf("create", "Rehire", { event: { fromStore: "W06010", toStore: "W06000" } }));
    eq([s.srv.lastBody("/rehireEmployee").rehireIntoDifferentLocationFlag, s.srv.lastBody("/rehireEmployee").oldLocationNumber, r.responseRef, s.srv.at(UID, 6000).active], [false, 6000, "rehire:6000", true]);

    // terminated at another store only: added here. Rosnet answers 200 to a rehire "into a different location" and does nothing, so it is never sent
    s = setup(); s.srv.add(UID, 6010, { active: false, lastDay: "2026-10-01" });
    r = await send(s.connector, ctxOf("create", "Rehire", { event: { fromStore: "W06010", toStore: "W06000" } }));
    eq([s.srv.writes(), r.responseRef, s.srv.lastBody("/addEmployee").emailId, s.srv.at(UID, 6000).active, s.srv.at(UID, 6010).active], [["POST /Employee/addEmployee"], "add:6000", "dana@example.com", true, false]);
  });

  await test("rosnet connector: a repeat Rosnet refuses as already-exists / already-active counts as sent; other 400s are dead with Rosnet's message", async () => {
    let s = setup({ intercept: (m, p) => (/\/getEmployee(ByName)?\//.test(p) ? { status: 200, headers: {}, text: "[]" } : null) });     // Aloha lags behind EDT
    s.srv.add(UID, 6000);
    const r = await send(s.connector, ctxOf("create", "New hire"));
    eq([r.responseRef, /already exists/.test(r.warning)], ["add:6000", true]);
    s = setup(); s.srv.add(UID, 6000);
    const e = await rejects(send(s.connector, ctxOf("job", "Job change", { event: { fromJob: "CM", toJob: "SS" }, codes: { ...codes(), job: new Map([[codeKey("", "SS"), { ukgCode: "SS", company: "", destinationCode: "99999", destinationId: null }]]) } })),
      x => x instanceof DeliveryError && x.kind === "dead", "invalid job code is dead");
    assert(/Not all JobCodes are valid/.test(e.message), "Rosnet's message");
  });

  await test("rosnet connector: an employee the previous integration created under another UID is found by name + payroll id, and that UID is used", async () => {
    const { srv, connector, logs } = setup(); srv.add("FLEXUID0001", 6000);
    const found = await connector.resolveExisting(ctxOf("create", "Rehire"));
    eq(found, { externalId: "FLEXUID0001", source: "matched", payrollId: "100234", posId: "100" });
    const r = await send(connector, ctxOf("terminate", "Termination", { event: { terminationCategory: "Voluntary" } }));
    eq([srv.lastBody("/terminateEmployee").posProvider_EmployeeUID, srv.lastBody("/terminateEmployee").employeeTerminationCode, r.xref.externalId], ["FLEXUID0001", 20, "FLEXUID0001"]);
    assert(logs.some(l => /another POS UID/.test(l)) && logs.every(l => !/Dana|ONeil/.test(l)), "logged without names");
    srv.add("OTHER2", 6010, { payroll: "999" });
    eq(await connector.resolveExisting(ctxOf("create", "Rehire", { delivery: { store: "W06010" }, employment: { orgLevel2: "W06010" } })), null, "same name, different payroll id: not linked");
  });

  await test("rosnet connector: terminate: active -> PUT with the code; already terminated -> nothing; no profile -> retry (it may not have landed yet)", async () => {
    let s = setup(); s.srv.add(UID, 6000);
    let r = await send(s.connector, ctxOf("terminate", "Leave of absence"));
    eq([s.srv.writes(), s.srv.lastBody("/terminateEmployee").employeeTerminationCode, s.srv.at(UID, 6000).active, r.responseRef], [["PUT /Employee/terminateEmployee"], 3, false, "terminate:6000"]);
    r = await send(s.connector, ctxOf("terminate", "Leave of absence"));
    eq([s.srv.writes().length, /already terminated in Rosnet \(last day 2026-11-10\)/.test(r.warning)], [1, true]);
    s = setup();
    await rejects(send(s.connector, ctxOf("terminate", "Termination")), x => x instanceof DeliveryError && x.kind === "retry" && /no profile at Rosnet location 6000/.test(x.message), "retry");
    eq(s.srv.writes(), []);
  });

  await test("rosnet connector: store transfer: transferEmployee with the Transfer code, then the email; a repeat sends nothing; back to a former store = rehire there + close the old one", async () => {
    const xfer = (from, to) => ctxOf("store", "Store transfer", { event: { fromStore: from, toStore: to }, employment: { orgLevel2: to }, delivery: { store: to } });
    const s = setup(); s.srv.add(UID, 6000);
    let r = await send(s.connector, xfer("W06000", "W06010"));
    eq(s.srv.writes(), ["POST /Employee/transferEmployee", "PUT /Employee/updateEmployeeInfo"]);
    const b = s.srv.lastBody("/transferEmployee");
    eq([b.originalLocationNumber, b.newLocationNumber, b.employeeTerminationCode, b.insertDate, r.responseRef], [6000, 6010, 100, "2026-11-17T18:31:30", "transfer:6000>6010"]);
    eq([s.srv.at(UID, 6000).active, s.srv.at(UID, 6010).active, s.srv.at(UID, 6010).email], [false, true, "dana@example.com"]);
    r = await send(s.connector, xfer("W06000", "W06010"));
    eq([s.srv.writes().length, /already transferred/.test(r.warning), r.xref.posId], [2, true, String(s.srv.at(UID, 6010).posId)]);
    r = await send(s.connector, xfer("W06010", "W06000"));                                 // return to 6000, where a terminated profile exists
    eq(s.srv.writes().slice(2), ["POST /Employee/rehireEmployee", "PUT /Employee/terminateEmployee"]);
    eq([s.srv.at(UID, 6000).active, s.srv.at(UID, 6010).active, s.srv.lastBody("/terminateEmployee").locationNumber, s.srv.lastBody("/terminateEmployee").employeeTerminationCode], [true, false, 6010, 100]);
    const t = setup();                                                                     // not in Rosnet at the old store: added at the new one
    r = await send(t.connector, xfer("W06000", "W06018"));
    eq([t.srv.writes(), r.responseRef, /no profile at 6000/.test(r.warning)], [["POST /Employee/addEmployee"], "add:6018", true]);
    const u = setup(); u.srv.add(UID, 6000, { active: false, lastDay: "2026-10-01" });     // terminated at the old store, no profile at the new one: added there
    r = await send(u.connector, xfer("W06000", "W06018"));
    eq([u.srv.writes(), r.responseRef, /not active at 6000/.test(r.warning), u.srv.lastBody("/addEmployee").emailId], [["POST /Employee/addEmployee"], "add:6018", true, "dana@example.com"]);
  });

  await test("rosnet connector: the email after a transfer waits until Aloha shows the new profile; never there = a warning and no update sent", async () => {
    const xfer = ctxOf("store", "Store transfer", { event: { fromStore: "W06000", toStore: "W06010" }, employment: { orgLevel2: "W06010" }, delivery: { store: "W06010" } });
    const lagging = reads => {                                                             // read 1 is the transfer's own look at the new store
      const srv = fakeRosnet({ intercept: (m, p, n) => (p.endsWith(`/getEmployee/${UID}/6010`) && n > 1 && n <= 1 + reads ? { status: 200, headers: {}, text: "[]" } : null) });
      srv.add(UID, 6000);
      return { srv, connector: new RosnetConnector(clientOf(srv), CFG, () => {}, () => NOW, async () => {}) };
    };
    let s = lagging(2);
    let r = await send(s.connector, xfer);
    eq([s.srv.writes(), r.warning, s.srv.at(UID, 6010).email], [["POST /Employee/transferEmployee", "PUT /Employee/updateEmployeeInfo"], undefined, "dana@example.com"]);
    s = lagging(99);
    r = await send(s.connector, xfer);
    eq([s.srv.writes(), /not in Aloha yet/.test(r.warning)], [["POST /Employee/transferEmployee"], true]);
  });

  await test("rosnet connector: job change adds the new code and removes the old one at the old job's rate; a repeat sends nothing; a terminated profile is retried", async () => {
    const job = ctxOf("job", "Promotion", { event: { fromJob: "CM", toJob: "SS" }, employment: { jobCode: "SS" } });
    const s = setup(); s.srv.add(UID, 6000);
    let r = await send(s.connector, job);
    eq(s.srv.writes(), ["PUT /Employee/addJob", "PUT /Employee/removeJob"]);
    eq([s.srv.lastBody("/addJob").jobInfo, s.srv.lastBody("/removeJob").jobInfo.jobCode, s.srv.lastBody("/removeJob").jobInfo.payRate, [...s.srv.at(UID, 6000).jobs.keys()]],
       [{ jobCode: 200, payRate: 17.26, eventEffectiveDate: "2026-11-10T00:00:00" }, 1, 16.5, [200]]);
    r = await send(s.connector, job);
    eq([s.srv.writes().length, /already as wanted/.test(r.warning)], [2, true]);
    s.srv.at(UID, 6000).jobs = new Map();                                                // Aloha shows a new profile before its jobs
    await rejects(send(s.connector, job), x => x.kind === "retry" && /no job on file yet/.test(x.message), "retry while the jobs have not landed");
    await rejects(send(s.connector, ctxOf("pay", "Pay change")), x => x.kind === "retry" && /no job on file yet/.test(x.message), "pay change waits too");
    eq(s.srv.writes().length, 2, "nothing sent meanwhile");
    s.srv.at(UID, 6000).active = false;
    await rejects(send(s.connector, job), x => x.kind === "retry" && /terminated at Rosnet location 6000/.test(x.message), "retry");
  });

  await test("rosnet connector: pay change -> modifyJob; the same rate sends nothing; one other job on file takes the rate with a warning; no usable job is dead; no pay in messages", async () => {
    const s = setup(); s.srv.add(UID, 6000);
    let r = await send(s.connector, ctxOf("pay", "Pay change"));
    eq([s.srv.writes(), s.srv.lastBody("/modifyJob").jobInfo, s.srv.at(UID, 6000).jobs.get(1)], [["PUT /Employee/modifyJob"], { jobCode: 1, payRate: 17.26, eventEffectiveDate: "2026-11-10T00:00:00" }, 17.26]);
    r = await send(s.connector, ctxOf("pay", "Pay change"));
    eq([s.srv.writes().length, r.warning], [1, "rate already current in Rosnet; nothing sent"]);
    s.srv.at(UID, 6000).jobs = new Map([[5, 16]]);
    r = await send(s.connector, ctxOf("pay", "Pay change"));
    eq([s.srv.lastBody("/modifyJob").jobInfo.jobCode, r.warning], [5, "job code 1 is not on file; the rate was applied to job 5"]);
    s.srv.at(UID, 6000).jobs = new Map([[5, 16], [200, 18]]);
    const e = await rejects(send(s.connector, ctxOf("pay", "Pay change")), x => x.kind === "dead", "dead");
    assert(!/17\.26|16\b/.test(e.message.replace("6000", "")), "no pay in the message");
  });

  await test("rosnet connector: failures are classified: 401 / 403 abort the run, 400 is dead, 5xx and network errors retry", async () => {
    eq([401, 403, 400, 404, 500, 0].map(st => classify(new RosnetError(st, "x")).kind), ["abort", "abort", "dead", "dead", "retry", "retry"]);
    eq(classify(new Error("boom")).kind, "retry");
    const s = setup({ intercept: (m, p) => (p.includes("/getEmployee/") ? Object.assign(new Error("socket hang up"), { name: "Error" }) : null) });
    await rejects(send(s.connector, ctxOf("terminate", "Termination")), x => x.kind === "retry", "network error retries");
    eq(s.srv.calls.filter(c => c.path.includes("/getEmployee/")).length, 3, "the read was tried three times");
  });

  // ---------------------------------------------------------------- discovery ----------------------------------------------------------------
  const storeOf = (over = {}) => {
    const written = { codes: [], xref: [] };
    return { written, hubStores: async () => ["T22446", "W06000", "W06010", "W06999"], allCodes: async () => over.codes ?? codes(),
             upsertCodes: async rows => { written.codes.push(...rows); }, upsertXrefMany: async rows => { written.xref.push(...rows); },
             employeesWithoutXref: async () => over.hub ?? [] };
  };

  await test("rosnet discover codes: W stores paired with location numbers by their digits and written; unknown mappings listed; nothing written against the sandbox", async () => {
    const stale = codes(); stale.job.set(codeKey("", "XX"), { ukgCode: "XX", company: "", destinationCode: "4242", destinationId: null });
    const store = storeOf({ codes: stale });
    const rep = await discoverRosnet(clientOf(fakeRosnet()), store, { companies: ["SWN1U"], what: "codes" });
    eq([rep.clientCode, rep.locations, rep.written, rep.sandbox], ["QUICKWEN", { rosnet: 3, paired: 2, unpairedHub: ["W06999"], unpairedRosnet: [6018] }, 2, false]);
    eq(store.written.codes.map(r => [r.codeType, r.company, r.ukgCode, r.destinationCode]), [["store", "", "W06000", "6000"], ["store", "", "W06010", "6010"]]);
    eq(rep.staleMappings, [{ codeType: "job", ukgCode: "XX", destinationCode: "4242" }]);
    const sandbox = storeOf();
    const rep2 = await discoverRosnet(clientOf(fakeRosnet(), { baseUrl: "https://wfmt-api.rosnetqa.com" }), sandbox, { companies: ["SWN1U"], what: "codes" });
    eq([rep2.sandbox, rep2.written, sandbox.written.codes.length, rep2.locations.paired], [true, 0, 0, 2]);
    eq((await discoverRosnet(clientOf(fakeRosnet(), { credential: null }), storeOf(), { companies: ["SWN1U"] })).error, "no Rosnet credentials configured");
  });

  await test("rosnet discover employees: linked by POS UID, else by payroll id with the last name as a check; the active profile wins; names never in the report", async () => {
    const srv = fakeRosnet();
    srv.add("EMP000000001", 6000, { payroll: "200001", active: false, lastDay: "2026-11-01" }); srv.add("EMP000000001", 6010, { payroll: "200001" });   // transferred: listed twice
    srv.add("FLEXUID0002", 6000, { payroll: "200002", last: "Okafor" });
    srv.add("FLEXUID0003", 6010, { payroll: "200003", last: "Somebody" }); srv.add("FLEXUID0004", 6018, { payroll: "200003", last: "Else" });         // ambiguous number, wrong names
    const hub = [{ employeeId: "EMP000000001", companyId: "SWN1U", employeeNumber: "200001", lastName: "X" }, { employeeId: "EMP000000002", companyId: "SWN1U", employeeNumber: "0200002", lastName: "O'Kafor" },
                 { employeeId: "EMP000000003", companyId: "SWN1U", employeeNumber: "200003", lastName: "Third" }, { employeeId: "EMP000000009", companyId: "SWN6T", employeeNumber: "200002", lastName: "Okafor" }];
    const store = storeOf({ hub });
    const rep = await discoverRosnet(clientOf(srv), store, { companies: ["SWN1U"], what: "employees" });
    eq(rep.employees, { rosnet: 4, active: 4, hubWithoutXref: 3, matched: 2, byUid: 1, byPayrollId: 1, lastNameMismatch: 2, locationsFailed: [] });
    eq(store.written.xref, [{ employeeId: "EMP000000001", externalId: "EMP000000001", source: "extract", payrollId: "200001", posId: String(srv.at("EMP000000001", 6010).posId) },
                            { employeeId: "EMP000000002", externalId: "FLEXUID0002", source: "extract", payrollId: "200002", posId: String(srv.at("FLEXUID0002", 6000).posId) }]);
    assert(!/Okafor|Somebody|Dana/.test(JSON.stringify(rep)), "no names in the report");
  });

  report("Rosnet connector");
};
