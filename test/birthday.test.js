/* Birth month + day (no year): extraction, nightly, intraday, store SQL, endpoint + audit. */
const path = require("path");
const { DIST, test, report, assert, eq, noYear, stubModule, fakePool } = require("./helpers");

// ---- stubs for the endpoint test (must be in place before the function module loads) ----
let pool = null;
const audits = [];
let auditFails = false;
const realSql = require(path.join(DIST, "shared", "sql.js")).sql;   // loads mssql only; no connection is made
stubModule("shared/sql.js", { getSharedHubPool: async () => pool, resetSharedHubPool() {}, openHubPool: async () => pool, sql: realSql });
stubModule("shared/audit.js", { writeAudit: async (e) => { if (auditFails) throw new Error("down"); audits.push(e); } });

const { extractBirthday, extractContact, hasAnyContact } = require(path.join(DIST, "shared", "contacts.js"));
const { runNightly, runIntradaySync } = require(path.join(DIST, "shared", "hubSync.js"));
const { SqlHubStore } = require(path.join(DIST, "shared", "hubStore.js"));
const { ROSTER_CONTACTS_SQL, mapRosterContactRow } = require(path.join(DIST, "shared", "roster.js"));
const { hubRosterContacts } = require(path.join(DIST, "functions", "hubRosterContacts.js"));

const contactCfg = { workDomains: ["qsrgroup.ca"], emailFields: ["emailAddress", "alternateEmailAddress"],
                     workPhoneFields: ["workPhone"], companyPhoneFields: [] };

// ---------------- mock UKG + store ----------------
function mockUkg(data) {
  return { async getAll(p) {
    for (const [prefix, rows] of Object.entries(data)) if (p.startsWith(prefix)) return typeof rows === "function" ? rows(p) : rows;
    return [];
  } };
}

function mockStore(ids) {
  const w = { contactsReplaced: null, upserts: null, removes: null, everything: [] };
  const rec = (name, ...a) => { w.everything.push({ name, a }); };
  const store = {
    w,
    async lastSyncedUntil() { return new Date("2026-10-27T10:00:00Z"); },
    async isRunning() { return false; },
    async termCodes() { return new Map([["RES", { category: "Termination", type: "Voluntary" }]]); },
    async startRun(...a) { rec("startRun", ...a); return "run-1"; },
    async finishRun(...a) { rec("finishRun", ...a); },
    async replaceEmployees(...a) { rec("replaceEmployees", ...a); },
    async rebuildEvents(...a) { rec("rebuildEvents", ...a); return 0; },
    async upsertContacts(c, d) { rec("upsertContacts", c, d); w.upserts = c; w.removes = d; },
    async replaceAllContacts(c) { rec("replaceAllContacts", c); w.contactsReplaced = c; },
    async writeSnapshot(...a) { rec("writeSnapshot", ...a); },
    async upsertEmployment(...a) { rec("upsertEmployment", ...a); },
    async activeEmployeeIds() { return ids; },
    async knownEmployeeIds() { return ids; },
    async purge() { return 0; },
    async hoursSinceIntradaySuccess() { return 3; }
  };
  return store;
}

const emp = (id, status, extra = {}) => ({ employeeID: id, companyID: "SWN6T", employeeNumber: id.slice(-3),
  employeeStatusCode: status, orgLevel1Code: "T2", orgLevel2Code: "T01647", primaryJobCode: "CM", ...extra });

const nightlyUkg = () => mockUkg({
  "/personnel/v1/employee-employment-details?employeeStatusCode=A": [emp("E1", "A"), emp("E2", "A"), emp("E3", "A")],
  "/personnel/v1/employee-employment-details?employeeStatusCode=L": [emp("E4", "L")],
  "/personnel/v1/person-details": [
    { employeeId: "E1", firstName: "Ann", lastName: "A", emailAddress: "ann@example.com", dateOfBirth: "1987-07-14T00:00:00" },
    { employeeId: "E2", firstName: "Bo", lastName: "B", emailAddress: "bo@qsrgroup.ca", dateOfBirth: null },
    { employeeId: "E3", firstName: "Cy", lastName: "C", dateOfBirth: "1987-12-31T00:00:00" },          // birthday only
    { employeeId: "E4", firstName: "Di", lastName: "D", workPhone: "555-0100", dateOfBirth: "1987-01-05T00:00:00" },
    { employeeId: "E9", firstName: "Ex", lastName: "X", emailAddress: "ex@example.com", dateOfBirth: "1987-03-03T00:00:00" } // not current
  ]
});

module.exports = async () => {
  // ================= 1. extractBirthday =================
  await test("extractBirthday: 1987-07-14T00:00:00 -> 7/14", () => {
    const b = extractBirthday("1987-07-14T00:00:00"); eq(b, { month: 7, day: 14 }); noYear(b, "result");
  });
  await test("extractBirthday: Feb 29 allowed", () => eq(extractBirthday("2000-02-29T00:00:00"), { month: 2, day: 29 }));
  await test("extractBirthday: invalid / missing -> both null", () => {
    for (const v of ["2001-02-30", "1990-13-01", "1990-00-10", "1990-04-31", "1990-01-00", "", null, undefined, "garbage", 19870714, {}])
      eq(extractBirthday(v), { month: null, day: null }, `input ${JSON.stringify(v)}`);
  });
  await test("extractBirthday: Date object (UTC parts, no off-by-one)", () => {
    eq(extractBirthday(new Date(Date.UTC(1987, 6, 14))), { month: 7, day: 14 });
    eq(extractBirthday(new Date(Date.UTC(1987, 0, 1, 23, 30))), { month: 1, day: 1 });
    eq(extractBirthday(new Date("invalid")), { month: null, day: null });
  });
  await test("extractBirthday: string with zone suffix keeps the written day", () => {
    eq(extractBirthday("1987-01-01T00:00:00Z"), { month: 1, day: 1 });
    eq(extractBirthday("1987-12-31T23:00:00-05:00"), { month: 12, day: 31 });
  });
  await test("extractBirthday: only month and day keys", () => eq(Object.keys(extractBirthday("1987-07-14")).sort(), ["day", "month"]));
  await test("extractContact: birthdays null; hasAnyContact counts a birthday", () => {
    const c = extractContact("E1", [{ emailAddress: "a@example.com", dateOfBirth: "1987-07-14T00:00:00" }], contactCfg);
    eq([c.birth_month, c.birth_day], [null, null]); noYear(c, "contact");
    assert(hasAnyContact({ employee_id: "X", personal_email: null, work_email: null, work_phone: null, company_phone: null, birth_month: 3, birth_day: 4 }));
    assert(!hasAnyContact({ employee_id: "X", personal_email: null, work_email: null, work_phone: null, company_phone: null, birth_month: null, birth_day: null }));
  });

  // ================= 2. runNightly =================
  await test("runNightly: current staff get birthdays; non-current do not; no year written", async () => {
    const store = mockStore(["E1", "E2", "E3", "E4"]); const logs = [];
    const r = await runNightly(store, nightlyUkg(), { lookbackMonths: 24, contacts: contactCfg, storeBirthday: true,
      now: new Date("2026-10-27T06:15:00Z"), log: (m) => logs.push(m) });
    eq(r.status, "succeeded", "status");
    const byId = Object.fromEntries(store.w.contactsReplaced.map(c => [c.employee_id, c]));
    eq(Object.keys(byId).sort(), ["E1", "E2", "E3", "E4"], "contacts written");
    eq([byId.E1.birth_month, byId.E1.birth_day], [7, 14], "E1");
    eq([byId.E2.birth_month, byId.E2.birth_day], [null, null], "E2 (no DOB)");
    eq([byId.E3.birth_month, byId.E3.birth_day], [12, 31], "E3 (birthday only is still stored)");
    eq([byId.E4.birth_month, byId.E4.birth_day], [1, 5], "E4 (on leave)");
    for (const c of store.w.contactsReplaced) {
      eq(Object.keys(c).sort(), ["birth_day", "birth_month", "company_phone", "employee_id", "personal_email", "work_email", "work_phone"], "contact keys");
    }
    noYear(store.w.everything, "store writes"); noYear(logs, "logs"); noYear(r, "result");
  });
  await test("runNightly: storeBirthday false -> all birthdays null", async () => {
    const store = mockStore(["E1", "E2", "E3", "E4"]);
    const r = await runNightly(store, nightlyUkg(), { lookbackMonths: 24, contacts: contactCfg, storeBirthday: false, now: new Date("2026-10-27T06:15:00Z") });
    eq(r.status, "succeeded");
    assert(store.w.contactsReplaced.every(c => c.birth_month === null && c.birth_day === null), "birthdays present");
    eq(store.w.contactsReplaced.map(c => c.employee_id).sort(), ["E1", "E2", "E4"], "E3 has nothing else -> no row");
    noYear(store.w.everything, "store writes");
  });
  await test("runNightly: storeBirthday omitted -> off (only the function app passes config)", async () => {
    const store = mockStore(["E1", "E2", "E3", "E4"]);
    await runNightly(store, nightlyUkg(), { lookbackMonths: 24, contacts: contactCfg, now: new Date("2026-10-27T06:15:00Z") });
    assert(store.w.contactsReplaced.every(c => c.birth_month === null));
  });

  // ================= intraday =================
  await test("runIntradaySync: contacts carry null birthdays; staff with no contact details are upserted, leavers removed", async () => {
    const store = mockStore([]); const logs = [];
    const ukg = mockUkg({
      "/personnel/v1/employee-changes": [
        { employeeId: "E1", firstName: "Ann", emailAddress: "ann@example.com", dateOfBirth: "1987-07-14T00:00:00" },
        { employeeId: "E5", firstName: "Ed" },
        { employeeId: "E6", firstName: "Flo" }
      ],
      "/personnel/v1/employee-employment-details?employeeId=E1": [emp("E1", "A")],
      "/personnel/v1/employee-employment-details?employeeId=E5": [emp("E5", "A")],
      "/personnel/v1/employee-employment-details?employeeId=E6": [emp("E6", "T", { terminationDate: "2026-10-20T00:00:00", terminationReasonCode: "RES" })],
      "/personnel/v1/employee-job-history-details": []
    });
    const r = await runIntradaySync(store, ukg, { lookbackMonths: 24, contacts: contactCfg, now: new Date("2026-10-27T14:05:00Z"), log: (m) => logs.push(m) });
    eq(r.status, "succeeded");
    eq(store.w.upserts.map(c => c.employee_id), ["E1", "E5"], "upserts");
    eq(store.w.removes, ["E6"], "removes");
    assert(store.w.upserts.every(c => c.birth_month === null && c.birth_day === null), "intraday birthdays must be null");
    eq(store.w.upserts[0].personal_email, "ann@example.com");
    noYear(store.w.everything, "store writes"); noYear(logs, "logs");
  });

  // ================= 3. store SQL =================
  await test("upsertContacts: MATCHED branch does not touch birthdays; new rows insert NULL", async () => {
    const p = fakePool(); const s = new SqlHubStore(p);
    await s.upsertContacts([{ employee_id: "E1", personal_email: "a@example.com", work_email: null, work_phone: null, company_phone: null, birth_month: null, birth_day: null }], ["E6"]);
    const q = p.calls[0].text;
    const matched = q.slice(q.indexOf("WHEN MATCHED"), q.indexOf("WHEN NOT MATCHED"));
    assert(matched.length > 20, "MATCHED branch found");
    assert(!/birth_/i.test(matched), "MATCHED branch references birthdays");
    const notMatched = q.slice(q.indexOf("WHEN NOT MATCHED"), q.indexOf(";", q.indexOf("WHEN NOT MATCHED")));
    assert(/birth_month, birth_day/.test(notMatched) && /NULL, NULL, 'intraday'/.test(notMatched), "NOT MATCHED inserts NULL birthdays");
    const using = q.slice(q.indexOf("USING"), q.indexOf("ON t.employee_id"));
    assert(!/birth_/i.test(using), "USING source must not read birthdays from intraday JSON");
    assert(/AND birth_month IS NULL;/.test(q), "empty rows are only removed when no birthday is stored");
  });
  await test("replaceAllContacts: INSERT + OPENJSON include birth_month / birth_day (tinyint)", async () => {
    const mssql = require("mssql"); const saved = { T: mssql.Transaction, R: mssql.Request };
    const p = fakePool(); let committed = false;
    mssql.Transaction = class { constructor() {} async begin() {} async commit() { committed = true; } async rollback() {} };
    mssql.Request = class { constructor() { return p.request(); } };
    try {
      await new SqlHubStore(p).replaceAllContacts([{ employee_id: "E1", personal_email: null, work_email: null, work_phone: null, company_phone: null, birth_month: 7, birth_day: 14 }]);
    } finally { mssql.Transaction = saved.T; mssql.Request = saved.R; }
    const q = p.calls[0].text;
    assert(committed, "committed");
    assert(/company_phone, birth_month, birth_day, source\)/.test(q), "INSERT column list");
    assert(/birth_month tinyint, birth_day tinyint/.test(q), "OPENJSON WITH");
    eq(JSON.parse(p.calls[0].inputs.c)[0].birth_month, 7);
  });

  // ================= 4. endpoint =================
  const DOB_ROW = { employee_id: "E1", employee_number: "001", company_id: "SWN6T", is_home_company: true, employee_status: "A",
    first_name: "Ann", preferred_name: null, last_name: "A", display_name: "Ann A", district: "T2", store: "T01647",
    job_code: "CM", job_description: "Crew", date_in_job: "2024-01-01", status_start_date: "2024-01-01",
    original_hire_date: "2024-01-01", last_hire_date: "2024-01-01", is_future_start: false, full_or_part_time: "P",
    personal_email: "ann@example.com", work_email: null, work_phone: null, company_phone: null, birth_month: 7, birth_day: 14 };
  const NO_CONTACT_ROW = { ...DOB_ROW, employee_id: "E2", personal_email: null, birth_month: null, birth_day: null };
  const appPrincipal = (roles) => Buffer.from(JSON.stringify({ claims: [{ typ: "idtyp", val: "app" }, { typ: "azp", val: "18f4b429-3c97-4bd1-af21-323fb68df4d1" }, ...roles.map(r => ({ typ: "roles", val: r }))] })).toString("base64");
  const req = (headers = {}, q = "") => ({ headers: new Headers(headers), query: new URLSearchParams(q) });
  const ctx = () => { const lines = []; return { lines, log: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) }; };
  const rosterPool = (rows) => fakePool((text) => ({ recordsets: [rows, [{ data_as_of_utc: new Date("2026-10-27T14:05:00Z") }]] }));

  await test("ROSTER_CONTACTS_SQL selects birth_month, birth_day from the contact join", () => {
    assert(/c\.birth_month, c\.birth_day/.test(ROSTER_CONTACTS_SQL)); assert(/LEFT JOIN stage\.employee_contact c/.test(ROSTER_CONTACTS_SQL));
  });
  await test("mapRosterContactRow: numbers, and both-or-neither", () => {
    const m = mapRosterContactRow(DOB_ROW); eq([m.birthMonth, m.birthDay], [7, 14]);
    eq([mapRosterContactRow({ ...DOB_ROW, birth_day: null }).birthMonth, mapRosterContactRow({ ...DOB_ROW, birth_day: null }).birthDay], [null, null]);
    eq([mapRosterContactRow({ ...DOB_ROW, birth_month: null }).birthMonth, mapRosterContactRow({ ...DOB_ROW, birth_month: null }).birthDay], [null, null]);
    const u = mapRosterContactRow({ ...DOB_ROW, birth_month: undefined, birth_day: undefined });
    assert(u.birthMonth === null && u.birthDay === null, "undefined -> null");
  });
  await test("hubRosterContacts (app role): every employee has birthMonth/birthDay; audit lists the field names", async () => {
    audits.length = 0; pool = rosterPool([DOB_ROW, NO_CONTACT_ROW]); const c = ctx();
    const res = await hubRosterContacts(req({ "x-ms-client-principal": appPrincipal(["RosterContacts.Read.All"]) }), c);
    eq(res.status, undefined, "200");
    eq(res.headers["Cache-Control"], "no-store");
    const emps = res.jsonBody.employees; eq(res.jsonBody.count, 2);
    for (const e of emps) assert("birthMonth" in e && "birthDay" in e, "fields present");
    eq([emps[0].birthMonth, emps[0].birthDay], [7, 14]); eq([emps[1].birthMonth, emps[1].birthDay], [null, null]);
    eq(audits.length, 1, "one audit record");
    eq(audits[0].fields, ["personalEmail", "workEmail", "workPhone", "companyPhone", "birthMonth", "birthDay"]);
    eq(audits[0].employeeId, "bulk:2");
    noYear(res, "response"); noYear(audits, "audit"); noYear(c.lines, "logs");
    assert(!JSON.stringify(c.lines).includes("ann@example.com"), "logs contain values");
  });
  await test("hubRosterContacts: filters still apply and still return birthdays", async () => {
    audits.length = 0; pool = rosterPool([DOB_ROW]);
    const res = await hubRosterContacts(req({ "x-ms-client-principal": appPrincipal(["RosterContacts.Read.All"]) }, "jobCodes=cm&status=A"), ctx());
    eq(res.jsonBody.filters.jobCodes, ["CM"]); eq(res.jsonBody.employees[0].birthDay, 14);
    eq(JSON.parse(pool.calls[0].inputs.jobCodes), ["CM"]);
  });
  await test("hubRosterContacts: audit failure -> 503, no data (fail closed)", async () => {
    auditFails = true; pool = rosterPool([DOB_ROW]);
    try {
      const res = await hubRosterContacts(req({ "x-ms-client-principal": appPrincipal(["RosterContacts.Read.All"]) }), ctx());
      eq(res.status, 503); assert(!JSON.stringify(res.jsonBody).includes("birth"), "no data on failure");
    } finally { auditFails = false; }
  });
  await test("hubRosterContacts: permissions unchanged", async () => {
    pool = rosterPool([DOB_ROW]);
    eq((await hubRosterContacts(req({ "x-ms-client-principal": appPrincipal(["Roster.Read.All"]) }), ctx())).status, 403, "roster-only app role");
    eq((await hubRosterContacts(req({ "x-ms-client-principal": appPrincipal([]) }), ctx())).status, 403, "no role");
    eq((await hubRosterContacts(req(), ctx())).status, 401, "anonymous");
    const summaryUser = Buffer.from(JSON.stringify({ claims: [{ typ: "scp", val: "Employees.Summary.Read" }, { typ: "roles", val: "Summary.Read" }, { typ: "preferred_username", val: "u@qsrgroup.ca" }, { typ: "azp", val: "abc" }] })).toString("base64");
    eq((await hubRosterContacts(req({ "x-ms-client-principal": summaryUser }), ctx())).status, 403, "summary user");
    const sensUser = Buffer.from(JSON.stringify({ claims: [{ typ: "scp", val: "Employees.Sensitive.Read" }, { typ: "roles", val: "Sensitive.Read" }, { typ: "preferred_username", val: "u@qsrgroup.ca" }, { typ: "azp", val: "abc" }] })).toString("base64");
    eq((await hubRosterContacts(req({ "x-ms-client-principal": sensUser }), ctx())).status, undefined, "sensitive user allowed");
    eq((await hubRosterContacts(req({ "x-ms-client-principal": appPrincipal(["RosterContacts.Read.All"]) }, "status=T"), ctx())).status, 400, "bad filter");
  });

  report("birthday");
};
