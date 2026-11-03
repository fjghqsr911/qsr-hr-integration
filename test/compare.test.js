/* Entra compare (pure): desired values, one case per proposal kind, dedupe, stale, rejections, rules. No I/O. */
const path = require("path");
const { DIST, test, report, assert, eq } = require("./helpers");

module.exports = async () => {
  const { computeDesired, diff, dedupeHash, torontoToday, ruleMatches, groupManageable, HEAD_OFFICE } = require(path.join(DIST, "shared", "entra", "compare.js"));

  const employee = (over = {}) => ({
    employeeId: "E100", employeeNumber: "100", companyId: "SWN6T", companyCount: 1, employeeStatus: "A", displayName: "Pat Example", district: "T1", store: "T00037",
    storeName: "Main Street", storeCity: "Ottawa", department: "Main Street", jobCode: "GM", jobTitle: "General Manager", fullOrPartTime: "F",
    originalHireDate: "2020-01-06", lastHireDate: "2020-01-06", terminationDate: null, dateLastWorked: null, workEmail: "pat@qsrgroup.ca", updatedUtc: null, ...over
  });
  const user = (over = {}) => ({
    objectId: "u-1", upn: "pat@qsrgroup.ca", mail: "pat@qsrgroup.ca", displayName: "Pat Example", jobTitle: "General Manager", department: "Main Street",
    officeLocation: "Ottawa", accountEnabled: true, employeeIdAttr: null, userType: "Member", onpremSynced: false, missingSinceUtc: null, ...over
  });
  const group = (id, over = {}) => [id, { objectId: id, displayName: `G ${id}`, groupTypes: [], securityEnabled: true, mailEnabled: false, roleAssignable: false, managed: true, ...over }];
  const rule = (over = {}) => ({ ruleId: 1, groupId: "g-1", name: "GMs", jobCodes: "GM", districts: null, stores: null, companies: null, statuses: "A,L", mode: "add_only", enabled: true, ...over });
  const today = "2026-11-03";
  const run = (over = {}) => diff({
    employee: employee(), desired: computeDesired(over.employee ?? employee(), { headOfficeCity: null }), user: user(), openProposals: [], rejections: new Set(), rules: [],
    groups: new Map(), memberships: new Set(), eventId: 77, today, ...over
  });
  const kinds = (r) => r.create.map(c => `${c.kind}${c.field ? ":" + c.field : ""}${c.groupId ? ":" + c.groupId : ""}`).sort();

  await test("computeDesired: store employee -> department = store name, officeLocation = store city, enabled, no due date", () => {
    eq(computeDesired(employee(), { headOfficeCity: null }), { jobTitle: "General Manager", department: "Main Street", officeLocation: "Ottawa", accountEnabled: true, dueDate: null });
    eq(computeDesired(employee({ storeCity: null }), { headOfficeCity: null }).officeLocation, null, "no city known: leave officeLocation alone");
    eq(computeDesired(employee({ jobTitle: null }), { headOfficeCity: null }).jobTitle, null);
  });
  await test("computeDesired: head office -> Head Office, city only from ENTRA_HEAD_OFFICE_CITY; on leave stays enabled", () => {
    const ho = employee({ store: "HR", storeName: null, storeCity: null, department: HEAD_OFFICE });
    eq(computeDesired(ho, { headOfficeCity: null }), { jobTitle: "General Manager", department: "Head Office", officeLocation: null, accountEnabled: true, dueDate: null });
    eq(computeDesired(ho, { headOfficeCity: "Toronto" }).officeLocation, "Toronto");
    eq(computeDesired(employee({ employeeStatus: "L" }), { headOfficeCity: null }).accountEnabled, true);
  });
  await test("computeDesired: termination -> disabled, due on date_last_worked, falling back to termination_date", () => {
    eq(computeDesired(employee({ employeeStatus: "T", terminationDate: "2026-11-10", dateLastWorked: "2026-11-07" }), { headOfficeCity: null }), { jobTitle: "General Manager", department: "Main Street", officeLocation: "Ottawa", accountEnabled: false, dueDate: "2026-11-07" });
    eq(computeDesired(employee({ employeeStatus: "T", terminationDate: "2026-11-10", dateLastWorked: null }), { headOfficeCity: null }).dueDate, "2026-11-10");
  });

  await test("diff: everything equal -> nothing proposed, nothing stale (case and whitespace ignored)", () => {
    const r = run({ user: user({ jobTitle: " general manager ", department: "MAIN STREET" }) });
    eq([r.create, r.blocked, r.stale, r.suppressed], [[], [], [], []]);
  });
  await test("diff: one attribute proposal per differing field with current and proposed values, event id attached, source compare", () => {
    const r = run({ user: user({ jobTitle: "Manager", department: "Head Office", officeLocation: null }) });
    eq(kinds(r), ["attribute:department", "attribute:jobTitle", "attribute:officeLocation"]);
    const jt = r.create.find(c => c.field === "jobTitle");
    eq([jt.employeeId, jt.userObjectId, jt.currentValue, jt.proposedValue, jt.source, jt.eventId, jt.status, jt.dueDate, jt.ruleId], ["E100", "u-1", "Manager", "General Manager", "compare", 77, "proposed", null, null]);
    eq(r.create.find(c => c.field === "officeLocation").currentValue, null);
    eq(jt.dedupeHash, dedupeHash("E100", "attribute", "jobTitle", null, "General Manager"));
    assert(/^[0-9a-f]{64}$/.test(jt.dedupeHash));
  });
  await test("diff: desired null (no title, no city) leaves the Entra value alone", () => {
    eq(kinds(run({ employee: employee({ jobTitle: null, storeCity: null }), user: user({ jobTitle: "Whatever", officeLocation: "Elsewhere" }) })), []);
  });
  await test("diff: termination -> disable with the due date; already disabled -> nothing; attributes not compared for leavers", () => {
    const t = employee({ employeeStatus: "T", terminationDate: "2026-11-10", dateLastWorked: "2026-11-07", jobTitle: "Other" });
    let r = run({ employee: t });
    eq(kinds(r), ["disable"]); eq([r.create[0].currentValue, r.create[0].proposedValue, r.create[0].dueDate], ["true", "false", "2026-11-07"]);
    eq(r.create[0].dedupeHash, dedupeHash("E100", "disable", null, null, "false"));
    r = run({ employee: employee({ employeeStatus: "T", terminationDate: null, dateLastWorked: null }) });
    eq(r.create[0].dueDate, today, "no dates at all: due today");
    eq(kinds(run({ employee: t, user: user({ accountEnabled: false }) })), []);
  });
  await test("diff: rehire (A / L with a disabled account) -> enable", () => {
    const r = run({ user: user({ accountEnabled: false }) });
    eq(kinds(r), ["enable"]); eq([r.create[0].currentValue, r.create[0].proposedValue], ["false", "true"]);
    eq(kinds(run({ employee: employee({ employeeStatus: "L" }), user: user({ accountEnabled: false }) })), ["enable"]);
  });
  await test("diff: dedupe -> an open proposal with the same hash is neither duplicated nor staled; a gone difference stales the open row; applying never staled", () => {
    const h = dedupeHash("E100", "attribute", "jobTitle", null, "General Manager");
    let r = run({ user: user({ jobTitle: "Manager" }), openProposals: [{ proposalId: 5, status: "proposed", dedupeHash: h, employeeId: "E100" }] });
    eq(r.create.length, 1); eq(r.create[0].dedupeHash, h, "the candidate is returned so the store refreshes last_seen / current_value"); eq(r.stale, []);
    r = run({ openProposals: [{ proposalId: 5, status: "accepted", dedupeHash: h, employeeId: "E100" }, { proposalId: 6, status: "applying", dedupeHash: "ff", employeeId: "E100" }] });
    eq(r.stale, [5]);
  });
  await test("diff: a rejected hash suppresses the proposal while the difference lasts (reported, so the rejection is kept); once equal the rejection is not reported (cleared)", () => {
    const h = dedupeHash("E100", "attribute", "jobTitle", null, "General Manager");
    let r = run({ user: user({ jobTitle: "Manager" }), rejections: new Set([h]) });
    eq(r.create, []); eq(r.suppressed, [h]);
    r = run({ rejections: new Set([h]) });
    eq(r.suppressed, [], "difference gone: the sync prunes the rejection, a later recurrence is proposed again");
    r = run({ user: user({ jobTitle: "Manager", department: "X" }), rejections: new Set([h]) });
    eq(kinds(r), ["attribute:department"]);
  });
  await test("diff: rule add when matching and not a member; add_and_remove removes a non-matching member; add_only never removes", () => {
    const groups = new Map([group("g-1")]);
    let r = run({ rules: [rule()], groups });
    eq(kinds(r), ["group_add:g-1"]); eq([r.create[0].source, r.create[0].ruleId, r.create[0].dedupeHash], ["rule", 1, dedupeHash("E100", "group_add", null, "g-1", null)]);
    eq(kinds(run({ rules: [rule()], groups, memberships: new Set(["g-1"]) })), [], "already a member");
    eq(kinds(run({ rules: [rule({ jobCodes: "ASM" })], groups, memberships: new Set(["g-1"]) })), [], "add_only never removes");
    r = run({ rules: [rule({ jobCodes: "ASM", mode: "add_and_remove" })], groups, memberships: new Set(["g-1"]) });
    eq(kinds(r), ["group_remove:g-1"]); eq(r.create[0].ruleId, 1);
    eq(kinds(run({ rules: [rule({ jobCodes: "ASM" }), rule({ ruleId: 2, jobCodes: "GM", mode: "add_and_remove" })], groups, memberships: new Set(["g-1"]) })), [], "any matching rule keeps the member");
  });
  await test("diff: rule statuses csv -> a leaver no longer matches (A,L default) and is removed under add_and_remove; predicates are AND, case-insensitive", () => {
    const groups = new Map([group("g-1")]);
    const t = employee({ employeeStatus: "T" });
    eq(kinds(run({ employee: t, user: user({ accountEnabled: false }), rules: [rule({ mode: "add_and_remove" })], groups, memberships: new Set(["g-1"]) })), ["group_remove:g-1"]);
    eq(kinds(run({ employee: t, user: user({ accountEnabled: false }), rules: [rule({ statuses: "A,L,T", mode: "add_and_remove" })], groups, memberships: new Set(["g-1"]) })), []);
    assert(ruleMatches(rule({ jobCodes: "gm", districts: "t1", stores: "t00037", companies: "swn6t" }), employee()));
    assert(!ruleMatches(rule({ jobCodes: "GM", districts: "T2" }), employee()));
    assert(ruleMatches(rule({ jobCodes: null, districts: null }), employee()), "NULL predicate = any");
  });
  await test("diff: rules on unmanaged, dynamic or role-assignable groups and disabled rules are ignored; unlinked employees ignored (open rows staled); on-prem synced -> blocked", () => {
    eq(kinds(run({ rules: [rule()], groups: new Map([group("g-1", { managed: false })]) })), []);
    eq(kinds(run({ rules: [rule()], groups: new Map([group("g-1", { groupTypes: ["DynamicMembership"] })]) })), []);
    eq(kinds(run({ rules: [rule()], groups: new Map([group("g-1", { roleAssignable: true })]) })), []);
    eq(kinds(run({ rules: [rule({ enabled: false })], groups: new Map([group("g-1")]) })), []);
    assert(!groupManageable(undefined) && !groupManageable({ managed: true, roleAssignable: false, groupTypes: ["Unified", "DynamicMembership"] }) && groupManageable({ managed: true, roleAssignable: false, groupTypes: ["Unified"] }));
    let r = run({ user: null, openProposals: [{ proposalId: 9, status: "proposed", dedupeHash: "aa", employeeId: "E100" }, { proposalId: 10, status: "applying", dedupeHash: "bb", employeeId: "E100" }] });
    eq([r.create, r.stale], [[], [9]]);
    r = run({ user: user({ jobTitle: "Manager", onpremSynced: true }) });
    eq(r.create, []); eq(r.blocked.length, 1); eq([r.blocked[0].status, r.blocked[0].field], ["blocked", "jobTitle"]);
  });
  await test("torontoToday: yyyy-mm-dd in America/Toronto", () => {
    eq(torontoToday(new Date("2026-11-03T03:30:00Z")), "2026-11-02", "late evening in Toronto is still the previous day");
    eq(torontoToday(new Date("2026-07-01T12:00:00Z")), "2026-07-01");
  });

  report("entra compare");
};
