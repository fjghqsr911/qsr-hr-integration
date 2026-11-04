/* Entra linking (pure): email matching, duplicates, manual links win, email changed, user missing, orphans. */
const path = require("path");
const { DIST, test, report, assert, eq } = require("./helpers");

module.exports = async () => {
  const { computeLinks } = require(path.join(DIST, "shared", "entra", "link.js"));
  const emp = (id, workEmail, over = {}) => ({ employeeId: id, employeeStatus: "A", workEmail, ...over });
  const usr = (id, upn, mail = upn, over = {}) => ({ objectId: id, upn, mail, missingSinceUtc: null, ...over });
  const issues = (r, kind) => r.issues.filter(i => i.kind === kind).map(i => i.employeeId ?? i.userObjectId).sort();

  await test("link: lower(work_email) = lower(upn) or lower(mail); orphans reported as user_without_employee", () => {
    const r = computeLinks([emp("E1", "Pat@QSRGroup.ca"), emp("E2", "sam@qsrgroup.ca"), emp("E3", null)],
                           [usr("u1", "pat@qsrgroup.ca"), usr("u2", "sam.x@qsrgroup.ca", "SAM@qsrgroup.ca"), usr("u3", "nobody@qsrgroup.ca")], []);
    eq(r.autoLinks, [{ employeeId: "E1", userObjectId: "u1", matchedEmail: "pat@qsrgroup.ca" }, { employeeId: "E2", userObjectId: "u2", matchedEmail: "sam@qsrgroup.ca" }]);
    eq(issues(r, "user_without_employee"), ["u3"]); eq(r.issues.length, 1);
  });
  await test("link: two employees with one email, or one email on two users -> duplicate_email, no link; email with no user -> email_not_in_entra", () => {
    const r = computeLinks([emp("E1", "shared@qsrgroup.ca"), emp("E2", "shared@qsrgroup.ca"), emp("E3", "two@qsrgroup.ca"), emp("E4", "none@qsrgroup.ca")],
                           [usr("u1", "shared@qsrgroup.ca"), usr("u2", "two@qsrgroup.ca"), usr("u3", "two.b@qsrgroup.ca", "two@qsrgroup.ca")], []);
    eq(r.autoLinks, []);
    eq(issues(r, "duplicate_email"), ["E1", "E2", "E3"]); eq(issues(r, "email_not_in_entra"), ["E4"]);
    assert(r.issues.find(i => i.employeeId === "E1").detail.includes("2 employees share"), "detail says why");
    assert(r.issues.find(i => i.employeeId === "E3").detail.includes("2 Entra users"));
  });
  await test("link: existing links persist (work email purged at termination), manual wins over a different email match and is never reported as email_changed", () => {
    const existing = [{ employeeId: "E1", userObjectId: "u1", method: "manual", matchedEmail: null }, { employeeId: "E2", userObjectId: "u2", method: "matched_email", matchedEmail: "old@qsrgroup.ca" }];
    const r = computeLinks([emp("E1", "other@qsrgroup.ca"), emp("E2", null, { employeeStatus: "T" }), emp("E3", "new@qsrgroup.ca")],
                           [usr("u1", "pat@qsrgroup.ca"), usr("u2", "old@qsrgroup.ca"), usr("u9", "other@qsrgroup.ca"), usr("u3", "new@qsrgroup.ca")], existing);
    eq(r.autoLinks, [{ employeeId: "E2", userObjectId: "u2", matchedEmail: "old@qsrgroup.ca" }, { employeeId: "E3", userObjectId: "u3", matchedEmail: "new@qsrgroup.ca" }], "E2 kept without an email; E1 stays manual");
    eq(issues(r, "email_changed"), [], "a manual link exists because the emails differ"); eq(issues(r, "user_without_employee"), ["u9"]);
    eq(issues(r, "user_missing"), []);
  });
  await test("link: a user already linked to another employee is not linked twice (duplicate_email with the other employee); email_changed for an auto link whose email moved", () => {
    const existing = [{ employeeId: "E1", userObjectId: "u1", method: "matched_email", matchedEmail: "pat@qsrgroup.ca" }];
    const r = computeLinks([emp("E1", "pat2@qsrgroup.ca"), emp("E2", "pat@qsrgroup.ca")], [usr("u1", "pat@qsrgroup.ca"), usr("u2", "pat2@qsrgroup.ca")], existing);
    eq(r.autoLinks, [{ employeeId: "E1", userObjectId: "u1", matchedEmail: "pat@qsrgroup.ca" }], "E1 keeps its link; the admin relinks after seeing email_changed");
    eq(issues(r, "email_changed"), ["E1"]);
    eq(issues(r, "duplicate_email"), ["E2"]); assert(r.issues.find(i => i.employeeId === "E2").detail.includes("employee E1"));
    eq(issues(r, "user_without_employee"), ["u2"]);
  });
  await test("link: linked user gone from the snapshot (missing or absent) -> user_missing; missing users never match", () => {
    const existing = [{ employeeId: "E1", userObjectId: "u1", method: "manual", matchedEmail: null }, { employeeId: "E2", userObjectId: "u2", method: "matched_email", matchedEmail: "x" }];
    const r = computeLinks([emp("E1", "pat@qsrgroup.ca"), emp("E2", null), emp("E3", "gone@qsrgroup.ca")],
                           [usr("u1", "pat@qsrgroup.ca", "pat@qsrgroup.ca", { missingSinceUtc: "2026-11-01T00:00:00Z" }), usr("u3", "gone@qsrgroup.ca", "gone@qsrgroup.ca", { missingSinceUtc: "2026-11-01T00:00:00Z" })], existing);
    eq(issues(r, "user_missing"), ["E1", "E2"]);
    eq(issues(r, "email_not_in_entra"), ["E3"]);
    eq(r.autoLinks, [{ employeeId: "E2", userObjectId: "u2", matchedEmail: "x" }]);
  });

  report("entra link");
};
