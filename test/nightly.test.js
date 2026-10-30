/* Nightly refresh: changes the intraday sync missed (store / job / FT-PT / status), never-seen employees, retries. */
const path = require("path");
const { DIST, test, report, assert, eq } = require("./helpers");

module.exports = async () => {
  const { runNightly, changedEmployees } = require(path.join(DIST, "shared", "hubSync.js"));
  const contacts = { workDomains: ["qsrgroup.ca"], emailFields: ["emailAddress"], workPhoneFields: ["workPhone"], companyPhoneFields: [] };
  const now = new Date("2026-10-30T06:15:00Z");

  const row = (id, extra = {}) => ({ employee_id: id, company_id: "SWN6T", employee_status: "A",
    org_level1: "T2", org_level2: "T01647", job_code: "CM", full_or_part_time: "P", ...extra });
  const ukgEmp = (id, extra = {}) => ({ employeeID: id, companyID: "SWN6T", employeeStatusCode: "A",
    orgLevel1Code: "T2", orgLevel2Code: "T01647", primaryJobCode: "CM", fullTimeOrPartTimeCode: "P", ...extra });
  const jobRow = (id) => ({ employeeId: id, companyId: "SWN6T", systemId: `${id}-1`, jobEffectiveDate: "2026-10-20T00:00:00",
    employeeStatus: "A", jobCode: "CM", orgLevel2Code: "T01647" });

  /* Stateful store: upsertEmployment and replaceEmployees change what currentEmployment returns (as SQL would). */
  function store(db) {
    const s = {
      db, upserted: [], replaced: [], rebuilt: [], finished: null,
      async isRunning() { return false; },
      async termCodes() { return new Map(); },
      async startRun() { return "run-1"; },
      async finishRun(_id, status, _c, err) { s.finished = { status, err }; },
      async writeSnapshot() {},
      async currentEmployment() { return s.db.map(r => ({ ...r })); },
      async upsertEmployment(rows) {
        s.upserted.push(...rows.map(r => r.employee_id));
        for (const r of rows) {
          const i = s.db.findIndex(x => x.employee_id === r.employee_id && x.company_id === r.company_id);
          const v = { employee_id: r.employee_id, company_id: r.company_id, employee_status: r.employee_status, org_level1: r.org_level1,
                      org_level2: r.org_level2, job_code: r.job_code, full_or_part_time: r.full_or_part_time };
          if (i >= 0) s.db[i] = v; else s.db.push(v);
        }
      },
      async replaceEmployees(ids, employment) {
        s.replaced.push(...ids);
        s.db = s.db.filter(r => !ids.includes(r.employee_id)).concat(employment.map(r => row(r.employee_id, {
          company_id: r.company_id, employee_status: r.employee_status, org_level1: r.org_level1, org_level2: r.org_level2,
          job_code: r.job_code, full_or_part_time: r.full_or_part_time })));
      },
      async rebuildEvents(ids) { s.rebuilt.push(...ids); return ids.length; },
      async replaceAllContacts() {},
      async purge() { return 0; },
      async hoursSinceIntradaySuccess() { return 3; }
    };
    return s;
  }

  /* UKG: nightly A/L pages + person details + per-employee endpoints (failIds throw, like a UKG 500). */
  function ukg(active, failIds = []) {
    return { async getAll(p) {
      if (p.includes("employeeStatusCode=A")) return active;
      if (p.includes("employeeStatusCode=L")) return [];
      if (p.startsWith("/personnel/v1/person-details")) return active.map(e => ({ employeeId: e.employeeID, firstName: "F", lastName: "L" }));
      const id = (p.match(/employeeId=([^&]+)/) || [])[1];
      if (failIds.includes(id)) { const e = new Error("UKG 500"); e.status = 500; throw e; }
      if (p.includes("employee-employment-details")) return active.filter(e => e.employeeID === id);
      if (p.includes("employee-job-history-details")) return [jobRow(id)];
      return [];
    } };
  }

  await test("changedEmployees: only known employees whose status / district / store / job / FT-PT differs", () => {
    const db = [row("E1"), row("E2"), row("E3"), row("E4", { full_or_part_time: null })];
    const u = [row("E1"), row("E2", { org_level2: "T00037" }), row("E3", { company_id: "SWNGK" }),
               row("E4", { full_or_part_time: null }), row("E5")];
    eq(changedEmployees(u, db).sort(), ["E2", "E3"], "E2 store changed, E3 new company record; E4 nulls equal; E5 unknown");
    eq(changedEmployees([row("E1", { job_code: "GM" })], db), ["E1"], "job change");
    eq(changedEmployees([row("E1", { full_or_part_time: "F" })], db), ["E1"], "FT/PT change");
    eq(changedEmployees([row("E1", { employee_status: "L" })], db), ["E1"], "status change");
    const two = [row("E6"), row("E6", { company_id: "SWNGK" })];
    eq(changedEmployees([row("E6")], two), ["E6"], "SWNGK record ended in UKG while SWN6T stays active");
    eq(changedEmployees([row("E6")], [row("E6"), row("E6", { company_id: "SWNGK", employee_status: "T" })]), [],
       "an already-terminated record is not a change");
  });

  await test("runNightly: a store change the intraday sync missed gets a full refresh and its events rebuilt", async () => {
    const s = store([row("E1"), row("E2")]);
    const r = await runNightly(s, ukg([ukgEmp("E1"), ukgEmp("E2", { orgLevel2Code: "T00037" })]), { lookbackMonths: 24, contacts, now });
    eq([r.status, r.employeesChanged, r.newEmployees, r.noLongerActive], ["succeeded", 1, 0, 0]);
    eq(s.replaced, ["E2"], "full refresh"); eq(s.rebuilt, ["E2"], "events rebuilt");
    eq(s.upserted, ["E1"], "the refreshed employee is not upserted from the nightly page");
    eq(s.db.find(x => x.employee_id === "E2").org_level2, "T00037", "new store stored");
  });

  await test("runNightly: a never-seen employee is refreshed (decided before the upsert adds them)", async () => {
    const s = store([row("E1")]);
    const r = await runNightly(s, ukg([ukgEmp("E1"), ukgEmp("E9")]), { lookbackMonths: 24, contacts, now });
    eq([r.status, r.newEmployees, r.employeesChanged], ["succeeded", 1, 0]);
    eq(s.replaced, ["E9"]); eq(s.rebuilt, ["E9"]);
  });

  await test("runNightly: a failed refresh leaves the old row, so the next night retries it", async () => {
    const s = store([row("E1"), row("E2")]);
    const active = [ukgEmp("E1"), ukgEmp("E2", { primaryJobCode: "GM" })];
    const r1 = await runNightly(s, ukg(active, ["E2"]), { lookbackMonths: 24, contacts, now });
    eq([r1.status, r1.employeesFailed], ["partial", 1]); eq(s.finished.status, "partial");
    eq(s.db.find(x => x.employee_id === "E2").job_code, "CM", "old row kept");
    const r2 = await runNightly(s, ukg(active), { lookbackMonths: 24, contacts, now });
    eq([r2.status, r2.employeesChanged], ["succeeded", 1]); eq(s.replaced, ["E2"]);
    eq(s.db.find(x => x.employee_id === "E2").job_code, "GM", "retried and stored");
  });

  await test("runNightly: nothing changed -> no refresh, everyone upserted", async () => {
    const s = store([row("E1"), row("E2")]);
    const r = await runNightly(s, ukg([ukgEmp("E1"), ukgEmp("E2")]), { lookbackMonths: 24, contacts, now });
    eq([r.status, r.employeesChanged], ["succeeded", 0]); eq(s.replaced, []); eq(s.upserted, ["E1", "E2"]);
  });

  report("nightly refresh");
};
