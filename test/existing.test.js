/* Existing behaviour unchanged: roster, contacts, sync helpers, nightly, permissions. */
const path = require("path");
const { DIST, test, report, assert, eq, fakePool } = require("./helpers");

module.exports = async () => {
  // shared/sql.js and shared/audit.js are already stubbed by birthday.test.js (same process)
  const sqlStub = require(path.join(DIST, "shared", "sql.js"));
  const { parseRosterFilters, mapRosterRow, ROSTER_SQL, ROSTER_CONTACTS_SQL } = require(path.join(DIST, "shared", "roster.js"));
  const { extractContact } = require(path.join(DIST, "shared", "contacts.js"));
  const { termCategory, isInScope, toDateOnly, torontoDate, runNightly } = require(path.join(DIST, "shared", "hubSync.js"));
  const { hubRoster } = require(path.join(DIST, "functions", "hubRoster.js"));
  const { config } = require(path.join(DIST, "shared", "config.js"));
  require(path.join(DIST, "functions", "hubSync.js"));        // module loads and registers its functions

  const cfg = { workDomains: ["qsrgroup.ca"], emailFields: ["emailAddress", "alternateEmailAddress"], workPhoneFields: ["workPhone", "workPhoneNumber"], companyPhoneFields: [] };

  await test("parseRosterFilters: defaults, normalising, validation", () => {
    eq(parseRosterFilters(new URLSearchParams("")).filters, { jobCodes: null, stores: null, districts: null, companies: null, statuses: ["A", "L"] });
    eq(parseRosterFilters(new URLSearchParams("jobCodes=gm, rm,GM&store=t01647")).filters.jobCodes, ["GM", "RM"]);
    assert(parseRosterFilters(new URLSearchParams("status=T")).error);
    assert(parseRosterFilters(new URLSearchParams("store=a;drop")).error);
  });
  await test("plain roster SQL/map have no contact or birthday fields", () => {
    assert(!/birth_|personal_email|employee_contact/.test(ROSTER_SQL));
    const m = mapRosterRow({ employee_id: "E1", store: "T01647", birth_month: 7, birth_day: 14, personal_email: "x@example.com" });
    assert(!("birthMonth" in m) && !("personalEmail" in m));
    assert(ROSTER_CONTACTS_SQL.includes("c.personal_email, c.work_email, c.work_phone, c.company_phone"));
  });
  await test("extractContact: email classification + phone extension unchanged", () => {
    const c = extractContact("E1", [{ emailAddress: "Ann@QSRGroup.ca", alternateEmailAddress: "ann@gmail.com" }, { workPhoneNumber: "555-0100", workPhoneExtension: "12" }], cfg);
    eq([c.personal_email, c.work_email, c.work_phone, c.company_phone], ["ann@gmail.com", "Ann@QSRGroup.ca", "555-0100 x12", null]);
  });
  await test("sync helpers unchanged", () => {
    const map = new Map([["RES", { category: "Termination", type: "Voluntary" }], ["XFR", { category: "Transfer", type: "" }]]);
    eq([termCategory("res", null, map), termCategory("XFR", null, map), termCategory(null, "I", map), termCategory("??", null, map)], ["Voluntary", "Transfer", "Involuntary", "Unknown"]);
    assert(isInScope([{ employee_status: "T", termination_date: "2026-01-01" }], "2024-10-27"));
    assert(!isInScope([{ employee_status: "T", termination_date: "2020-01-01" }], "2024-10-27"));
    eq(toDateOnly("2026-04-20T00:00:00"), "2026-04-20"); eq(torontoDate(new Date("2026-10-27T03:00:00Z")), "2026-10-26");
  });
  await test("runNightly: refreshes unseen employees and still fails safe when UKG returns nobody", async () => {
    const calls = [];
    const store = new Proxy({}, { get: (_t, k) => async (...a) => {
      calls.push(k);
      if (k === "isRunning") return false; if (k === "termCodes") return new Map();
      if (k === "activeEmployeeIds" || k === "knownEmployeeIds") return []; if (k === "hoursSinceIntradaySuccess") return 1;
      if (k === "rebuildEvents") return 0; return "id";
    } });
    const ukg = { async getAll(p) {
      if (p.includes("employeeStatusCode=A")) return [{ employeeID: "E1", companyID: "C", employeeStatusCode: "A" }];
      if (p.includes("employeeId=E1") && p.includes("employment")) return [{ employeeID: "E1", companyID: "C", employeeStatusCode: "A" }];
      return [];
    } };
    const r = await runNightly(store, ukg, { lookbackMonths: 24, contacts: cfg, now: new Date("2026-10-27T06:15:00Z") });
    eq([r.status, r.newEmployees], ["succeeded", 1]); assert(calls.includes("replaceEmployees") && calls.includes("replaceAllContacts"));
    const empty = await runNightly(store, { async getAll() { return []; } }, { lookbackMonths: 24, contacts: cfg });
    eq(empty.status, "failed");
  });
  await test("config.hubStoreBirthday: default true; only 'false' turns it off", () => {
    const old = process.env.HUB_STORE_BIRTHDAY;
    try {
      delete process.env.HUB_STORE_BIRTHDAY; eq(config.hubStoreBirthday, true);
      process.env.HUB_STORE_BIRTHDAY = "FALSE"; eq(config.hubStoreBirthday, false);
      process.env.HUB_STORE_BIRTHDAY = "true"; eq(config.hubStoreBirthday, true);
    } finally { if (old === undefined) delete process.env.HUB_STORE_BIRTHDAY; else process.env.HUB_STORE_BIRTHDAY = old; }
  });
  await test("hubRoster endpoint: permissions + rows unchanged", async () => {
    const principal = (claims) => Buffer.from(JSON.stringify({ claims })).toString("base64");
    const req = (claims) => ({ headers: new Headers(claims ? { "x-ms-client-principal": principal(claims) } : {}), query: new URLSearchParams() });
    const ctx = { log() {}, error() {} };
    const pool = fakePool(() => ({ recordsets: [[{ employee_id: "E1", store: "T01647", birth_month: 7 }], [{ data_as_of_utc: null }]] }));
    const orig = sqlStub.getSharedHubPool; sqlStub.getSharedHubPool = async () => pool;
    try {
      const ok = await hubRoster(req([{ typ: "idtyp", val: "app" }, { typ: "roles", val: "Roster.Read.All" }]), ctx);
      eq(ok.jsonBody.count, 1); assert(!("birthMonth" in ok.jsonBody.employees[0]), "roster must not carry birthdays");
      eq((await hubRoster(req([{ typ: "idtyp", val: "app" }, { typ: "roles", val: "RosterContacts.Read.All" }]), ctx)).status, 403, "contacts role cannot read plain roster");
      eq((await hubRoster(req(null), ctx)).status, 401);
    } finally { sqlStub.getSharedHubPool = orig; }
  });

  report("existing behaviour");
};
