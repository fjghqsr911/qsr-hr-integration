/* Entra admin endpoints: permissions, validation, fail-closed audit, state rules, writes switch, apply with drift, manual members, decide, rules, links. */
const path = require("path");
const { DIST, test, report, assert, eq, stubModule, fakePool } = require("./helpers");

module.exports = async () => {
  // Own stubs. entraAdmin.js has not loaded yet, so it picks these up.
  const audits = [];
  let auditFails = false;
  const graphCalls = [];
  let graphUsers = {};                 // object id -> what GET /users/{id} returns (null = 404)
  let graphFails = null;               // error thrown by every Graph write
  const realSql = require(path.join(DIST, "shared", "sql.js")).sql;
  const realGraph = require(path.join(DIST, "shared", "graph.js"));
  const { GraphError } = realGraph;
  const graph = {
    async getUser(id, select) { graphCalls.push(`GET ${id} ${select}`); return graphUsers[id] ?? null; },
    async patchUser(id, body) { graphCalls.push(`PATCH ${id} ${JSON.stringify(body)}`); if (graphFails) throw graphFails; },
    async addGroupMember(g, u) { graphCalls.push(`ADD ${g} ${u}`); if (graphFails) throw graphFails; return "added"; },
    async removeGroupMember(g, u) { graphCalls.push(`REMOVE ${g} ${u}`); if (graphFails) throw graphFails; return "removed"; }
  };
  let pool = null;
  let resets = 0;
  stubModule("shared/sql.js", { getSharedHubPool: async () => pool, resetSharedHubPool() { resets++; }, openHubPool: async () => pool, sql: realSql });
  stubModule("shared/audit.js", { writeAudit: async (e) => { if (auditFails) throw new Error("down"); audits.push(e); }, probeAudit: async () => 1 });
  stubModule("shared/graph.js", { ...realGraph, buildGraphClient: () => graph });
  const S = require(path.join(DIST, "shared", "entra", "store.js"));
  const { dedupeHash, torontoToday } = require(path.join(DIST, "shared", "entra", "compare.js"));
  const A = require(path.join(DIST, "functions", "entraAdmin.js"));

  // ---------------------------------------------------------------- in-memory database behind fakePool ----------------------------------------------------------------
  const today = torontoToday();
  const plusDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const tomorrow = plusDays(today, 1), yesterday = plusDays(today, -1);
  const GID = "11111111-1111-1111-1111-111111111111", GID2 = "22222222-2222-2222-2222-222222222222";
  const UID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", UID2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", UID3 = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  let db;
  const newDb = () => ({
    proposals: new Map(), links: new Map(), users: new Map(), groups: new Map(), members: new Set(), rules: new Map(), rejections: [], manual: [], userUpdates: [], nextRule: 10, nextProposal: 500
  });
  const proposal = (id, over = {}) => ({ proposal_id: id, employee_id: "E100", user_object_id: UID, kind: "attribute", field: "jobTitle", group_id: null, current_value: "Manager",
    proposed_value: "General Manager", due_date: null, source: "compare", event_id: 7, rule_id: null, status: "proposed",
    dedupe_hash: Buffer.from(dedupeHash("E100", "attribute", "jobTitle", null, "General Manager"), "hex"), proposed_utc: new Date("2026-11-01T10:00:00Z"),
    last_seen_utc: new Date("2026-11-03T10:00:00Z"), decided_by: null, decided_utc: null, applied_utc: null, error: null, ...over });
  const groupRow = (id, over = {}) => ({ object_id: id, display_name: "GMs", description: null, group_types: "", security_enabled: true, mail_enabled: false, role_assignable: false, managed: true, member_count: 1, fetched_utc: new Date("2026-11-03T06:45:00Z"), members_fetched_utc: null, ...over });
  const userRow = (id, over = {}) => ({ object_id: id, upn: "pat@qsrgroup.ca", mail: "pat@qsrgroup.ca", display_name: "Pat", job_title: "Manager", department: "Main Street", office_location: "Ottawa", account_enabled: true, employee_id_attr: null, user_type: "Member", onprem_synced: false, missing_since_utc: null, ...over });
  const linkRow = (employeeId, userId, method = "matched_email") => ({ employee_id: employeeId, user_object_id: userId, method, matched_email: null, linked_utc: new Date("2026-11-02T00:00:00Z"), linked_by: "sync" });
  const ruleRow = (id, over = {}) => ({ rule_id: id, group_id: GID, name: "GMs", job_codes: "GM", districts: null, stores: null, companies: null, statuses: "A,L", mode: "add_only", enabled: true, notes: null, updated_utc: new Date("2026-11-01T00:00:00Z"), updated_by: "x", ...over });
  const rs = (row) => ({ recordset: row ? [row] : [] });
  const same = (a, b) => a.trim() === b.trim();

  const answer = (text, inputs) => {
    const t = text.trim();
    if (same(t, S.PROPOSAL_SELECT_SQL)) return rs(db.proposals.get(Number(inputs.id)));
    if (same(t, S.PROPOSAL_ACCEPT_SQL)) { const p = db.proposals.get(Number(inputs.id)); if (p && p.status === "proposed") { Object.assign(p, { status: "accepted", decided_by: inputs.by, decided_utc: new Date(), error: null }); return rs(p); } return rs(); }
    if (same(t, S.PROPOSAL_REJECT_SQL)) { const p = db.proposals.get(Number(inputs.id)); if (p && ["proposed", "accepted"].includes(p.status)) { Object.assign(p, { status: "rejected", decided_by: inputs.by, decided_utc: new Date() }); return rs(p); } return rs(); }
    if (same(t, S.PROPOSAL_CLAIM_SQL)) { const p = db.proposals.get(Number(inputs.id)); if (p && p.status === "accepted" && (!p.due_date || p.due_date <= inputs.today)) { p.status = "applying"; p.error = null; return rs(p); } return rs(); }
    if (same(t, S.PROPOSAL_FINISH_SQL)) { const p = db.proposals.get(Number(inputs.id)); if (p && p.status === "applying") { p.status = inputs.status; if (inputs.currentValue !== null && inputs.currentValue !== undefined) p.current_value = inputs.currentValue; p.error = inputs.error; if (inputs.status === "applied") p.applied_utc = new Date(); return rs(p); } return rs(); }
    if (same(t, S.REJECTION_UPSERT_SQL)) { db.rejections.push(inputs.hash); return rs(); }
    if (same(t, S.MANUAL_APPLIED_SQL)) { const row = proposal(db.nextProposal++, { employee_id: inputs.employeeId, user_object_id: inputs.userObjectId, kind: inputs.kind, field: null, group_id: inputs.groupId, current_value: null, proposed_value: null, source: "manual", status: "applied", dedupe_hash: Buffer.from(inputs.hash, "hex"), decided_by: inputs.by, applied_utc: new Date() }); db.manual.push(row); return rs(row); }
    if (same(t, S.GROUP_SELECT_SQL)) return rs(db.groups.get(inputs.groupId));
    if (same(t, S.GROUP_MANAGED_SQL)) { const g = db.groups.get(inputs.groupId); if (g) { g.managed = !!inputs.managed; return rs(g); } return rs(); }
    if (same(t, S.RULE_INSERT_SQL)) { const r = ruleRow(db.nextRule++, { group_id: inputs.groupId, name: inputs.name, job_codes: inputs.jobCodes, districts: inputs.districts, stores: inputs.stores, companies: inputs.companies, statuses: inputs.statuses, mode: inputs.mode, enabled: inputs.enabled, notes: inputs.notes, updated_by: inputs.by }); db.rules.set(r.rule_id, r); return rs(r); }
    if (same(t, S.RULE_UPDATE_SQL)) { const r = db.rules.get(Number(inputs.id)); if (!r) return rs(); Object.assign(r, { group_id: inputs.groupId, name: inputs.name, job_codes: inputs.jobCodes, districts: inputs.districts, stores: inputs.stores, companies: inputs.companies, statuses: inputs.statuses, mode: inputs.mode, enabled: inputs.enabled, notes: inputs.notes, updated_by: inputs.by }); return rs(r); }
    if (same(t, S.RULE_DELETE_SQL)) { const had = db.rules.delete(Number(inputs.id)); return rs({ deleted: had ? 1 : 0 }); }
    if (same(t, S.LINK_MANUAL_SQL)) { for (const p of db.proposals.values()) if (p.employee_id === inputs.employeeId && ["proposed", "accepted", "blocked"].includes(p.status)) p.status = "stale"; const row = linkRow(inputs.employeeId, inputs.userObjectId, "manual"); row.linked_by = inputs.by; db.links.set(inputs.employeeId, row); return rs(row); }
    if (same(t, S.LINK_DELETE_SQL)) { for (const p of db.proposals.values()) if (p.employee_id === inputs.employeeId && ["proposed", "accepted", "blocked"].includes(p.status)) p.status = "stale"; return rs({ deleted: db.links.delete(inputs.employeeId) ? 1 : 0 }); }
    if (/FROM entra\.rules WHERE rule_id = @id/.test(t)) return rs(db.rules.get(Number(inputs.id)));
    if (/FROM entra\.links WHERE employee_id = @employeeId/.test(t)) return rs(db.links.get(inputs.employeeId));
    if (/FROM entra\.links WHERE user_object_id = @userObjectId/.test(t)) return rs([...db.links.values()].find(l => l.user_object_id === inputs.userObjectId));
    if (/FROM entra\.users WHERE object_id = @id/.test(t)) return rs(db.users.get(inputs.id));
    if (/COUNT\(\*\) AS n FROM entra\.group_members/.test(t)) return rs({ n: db.members.has(`${inputs.groupId}|${inputs.userId}`) ? 1 : 0 });
    if (/INSERT INTO entra\.group_members/.test(t)) { db.members.add(`${inputs.groupId}|${inputs.userId}`); return rs(); }
    if (/DELETE FROM entra\.group_members WHERE group_id = @groupId AND user_id = @userId/.test(t)) { db.members.delete(`${inputs.groupId}|${inputs.userId}`); return rs(); }
    if (/^UPDATE entra\.users SET/.test(t)) { db.userUpdates.push({ ...inputs }); return rs(); }
    throw new Error(`unexpected SQL: ${t.slice(0, 90)}`);
  };

  const principal = (claims) => Buffer.from(JSON.stringify({ claims })).toString("base64");
  const admin = [{ typ: "scp", val: "Employees.Summary.Read Employees.Summary.Write" }, { typ: "roles", val: "Entra.Admin" }, { typ: "preferred_username", val: "fraser@qsrgroup.ca" }, { typ: "azp", val: "monitor-app" }];
  const summaryAdmin = [{ typ: "scp", val: "Employees.Summary.Read Employees.Summary.Write" }, { typ: "roles", val: "Summary.Admin" }];
  const noWriteScope = [{ typ: "scp", val: "Employees.Summary.Read" }, { typ: "roles", val: "Entra.Admin" }];
  const appRun = [{ typ: "idtyp", val: "app" }, { typ: "roles", val: "Integration.Run" }];
  const req = (claims, params = {}, body) => ({
    headers: new Headers(claims ? { "x-ms-client-principal": principal(claims) } : {}), params, query: new URLSearchParams(),
    json: async () => { if (body === "bad-json") throw new SyntaxError("bad"); return body; }
  });
  const logs = [];
  const ctx = { log(...a) { logs.push(a.join(" ")); }, error(...a) { logs.push("ERROR " + a.join(" ")); }, warn(...a) { logs.push("WARN " + a.join(" ")); } };
  const saved = { w: process.env.ENTRA_WRITE_ENABLED, m: process.env.ENTRA_MAX_DECIDE };
  const reset = (writes = true) => {
    audits.length = 0; auditFails = false; graphCalls.length = 0; graphFails = null; logs.length = 0; resets = 0;
    graphUsers = { [UID]: { id: UID, jobTitle: "Manager", department: "Main Street", officeLocation: "Ottawa", accountEnabled: true } };
    db = newDb(); pool = fakePool(answer);
    db.groups.set(GID, groupRow(GID)); db.groups.set(GID2, groupRow(GID2, { managed: false }));
    db.users.set(UID, userRow(UID)); db.users.set(UID2, userRow(UID2, { upn: "sam@qsrgroup.ca", mail: "sam@qsrgroup.ca" })); db.users.set(UID3, userRow(UID3, { upn: "new@qsrgroup.ca", mail: "new@qsrgroup.ca" }));
    db.links.set("E100", linkRow("E100", UID)); db.links.set("E200", linkRow("E200", UID2, "manual"));
    db.proposals.set(1, proposal(1));
    if (writes) process.env.ENTRA_WRITE_ENABLED = "true"; else delete process.env.ENTRA_WRITE_ENABLED;
    delete process.env.ENTRA_MAX_DECIDE;
  };
  const restore = () => { if (saved.w === undefined) delete process.env.ENTRA_WRITE_ENABLED; else process.env.ENTRA_WRITE_ENABLED = saved.w; if (saved.m === undefined) delete process.env.ENTRA_MAX_DECIDE; else process.env.ENTRA_MAX_DECIDE = saved.m; };
  const ALL = [
    ["accept", A.entraProposalAccept, { id: "1" }, undefined], ["reject", A.entraProposalReject, { id: "1" }, undefined], ["apply", A.entraProposalApply, { id: "1" }, undefined],
    ["decide", A.entraProposalsDecide, {}, { ids: [1], action: "accept" }], ["members add", A.entraGroupMembersAdd, { gid: GID }, { employeeIds: ["E100"] }],
    ["members remove", A.entraGroupMembersRemove, { gid: GID }, { employeeIds: ["E100"] }], ["managed", A.entraGroupManaged, { gid: GID }, { managed: true }],
    ["rule create", A.entraRuleSave, {}, { groupId: GID, name: "x" }], ["rule update", A.entraRuleSave, { id: "10" }, { groupId: GID, name: "x" }], ["rule delete", A.entraRuleDelete, { id: "10" }, undefined],
    ["link", A.entraLinkCreate, {}, { employeeId: "E300", userObjectId: UID3 }], ["unlink", A.entraLinkDelete, { employeeId: "E100" }, undefined]
  ];

  try {
    await test("entra admin: every route needs Entra.Admin + write scope; Summary.Admin, app-only (even Integration.Run) and missing scope are refused; nothing runs, nothing audited", async () => {
      reset();
      for (const [name, fn, params, body] of ALL) {
        eq((await fn(req(null, params, body), ctx)).status, 401, `${name} 401`);
        eq((await fn(req(summaryAdmin, params, body), ctx)).jsonBody.detail, "insufficient_role", `${name} Summary.Admin`);
        eq((await fn(req(noWriteScope, params, body), ctx)).jsonBody.detail, "insufficient_scope", `${name} scope`);
        eq((await fn(req(appRun, params, body), ctx)).jsonBody.detail, "app_only_not_allowed", `${name} app-only`);
      }
      eq(pool.calls.length, 0); eq(audits.length, 0); eq(graphCalls.length, 0);
    });
    await test("entra admin: id / guid / employee id / body validation -> 400 before any SQL", async () => {
      reset();
      for (const fn of [A.entraProposalAccept, A.entraProposalReject, A.entraProposalApply]) {
        eq((await fn(req(admin, { id: "1; drop" }), ctx)).status, 400); eq((await fn(req(admin, { id: "" }), ctx)).status, 400); eq((await fn(req(admin, { id: "1234567890123456" }), ctx)).status, 400);
      }
      eq((await A.entraProposalsDecide(req(admin, {}, "bad-json"), ctx)).status, 400);
      eq((await A.entraProposalsDecide(req(admin, {}, { ids: [], action: "accept" }), ctx)).status, 400);
      eq((await A.entraProposalsDecide(req(admin, {}, { ids: [1], action: "apply" }), ctx)).status, 400);
      eq((await A.entraProposalsDecide(req(admin, {}, { ids: ["x"], action: "accept" }), ctx)).status, 400);
      eq((await A.entraGroupMembersAdd(req(admin, { gid: "not-a-guid" }, { employeeIds: ["E100"] }), ctx)).status, 400);
      eq((await A.entraGroupMembersAdd(req(admin, { gid: GID }, { employeeIds: ["E1 00"] }), ctx)).status, 400);
      eq((await A.entraGroupMembersAdd(req(admin, { gid: GID }, { employeeIds: [] }), ctx)).status, 400);
      eq((await A.entraGroupManaged(req(admin, { gid: GID }, { managed: "yes" }), ctx)).status, 400);
      eq((await A.entraRuleSave(req(admin, {}, { groupId: GID, name: "" }), ctx)).status, 400);
      eq((await A.entraRuleSave(req(admin, {}, { groupId: GID, name: "x", jobCodes: ["GM", "A;B"] }), ctx)).status, 400, "csv tokens ^[A-Za-z0-9]{1,20}$");
      eq((await A.entraRuleSave(req(admin, {}, { groupId: GID, name: "x", statuses: "A,X" }), ctx)).status, 400, "statuses A L T only");
      eq((await A.entraRuleSave(req(admin, {}, { groupId: GID, name: "x", mode: "remove_all" }), ctx)).status, 400);
      eq((await A.entraRuleSave(req(admin, { id: "abc" }, { groupId: GID, name: "x" }), ctx)).status, 400);
      eq((await A.entraRuleDelete(req(admin, { id: "x" }), ctx)).status, 400);
      eq((await A.entraLinkCreate(req(admin, {}, { employeeId: "E100", userObjectId: "nope" }), ctx)).status, 400);
      eq((await A.entraLinkCreate(req(admin, {}, { employeeId: "E 100", userObjectId: UID }), ctx)).status, 400);
      eq((await A.entraLinkDelete(req(admin, { employeeId: "E/100" }), ctx)).status, 400);
      eq(pool.calls.length, 0); eq(audits.length, 0);
    });

    // ------------------------------------------------------------ accept / reject / apply ------------------------------------------------------------
    await test("accept: proposed -> accepted, audited BEFORE (employee + field), then applied at once: Graph re-read, PATCH one field, snapshot refreshed, applied", async () => {
      reset();
      const res = await A.entraProposalAccept(req(admin, { id: "1" }), ctx);
      eq(res.status, 200); eq(res.headers["Cache-Control"], "no-store");
      eq([res.jsonBody.proposalId, res.jsonBody.status, res.jsonBody.applyOutcome, res.jsonBody.decidedBy, res.jsonBody.error], [1, "applied", "applied", "delegated:fraser@qsrgroup.ca", null]);
      assert(!("dedupeHash" in res.jsonBody), "hash not returned");
      eq(graphCalls, [`GET ${UID} id,jobTitle,department,officeLocation,accountEnabled`, `PATCH ${UID} {"jobTitle":"General Manager"}`]);
      eq(db.userUpdates[0].jobTitle, "General Manager");
      eq(audits.length, 1); eq([audits[0].endpoint, audits[0].employeeId, audits[0].action, audits[0].fields, audits[0].outcome], ["POST /hub/entra/proposals/{id}/accept", "E100", "write", ["jobTitle"], "allowed"]);
      assert(pool.calls.findIndex(c => same(c.text, S.PROPOSAL_ACCEPT_SQL)) > 0, "the accept UPDATE runs after the audit");
      assert(/status = 'accepted'/.test(S.PROPOSAL_ACCEPT_SQL) && /WHERE proposal_id = @id AND status = 'proposed'/.test(S.PROPOSAL_ACCEPT_SQL), "status-guarded UPDATE");
      assert(/WHERE proposal_id = @id AND status = 'accepted' AND \(due_date IS NULL OR due_date <= @today\)/.test(S.PROPOSAL_CLAIM_SQL), "claim guards status and due date");
      assert(logs.every(l => !/General Manager/.test(l)), "values are not logged");
    });
    await test("accept: writes disabled -> accepted is still recorded, no Graph call, applyOutcome writes_disabled; disable due later -> accepted, due_later", async () => {
      reset(false);
      let res = await A.entraProposalAccept(req(admin, { id: "1" }), ctx);
      eq([res.status, res.jsonBody.status, res.jsonBody.applyOutcome], [200, "accepted", "writes_disabled"]); eq(graphCalls, []); eq(audits.length, 1);
      reset();
      db.proposals.set(2, proposal(2, { kind: "disable", field: null, current_value: "true", proposed_value: "false", due_date: tomorrow, dedupe_hash: Buffer.from(dedupeHash("E100", "disable", null, null, "false"), "hex") }));
      res = await A.entraProposalAccept(req(admin, { id: "2" }), ctx);
      eq([res.status, res.jsonBody.status, res.jsonBody.applyOutcome, res.jsonBody.dueDate], [200, "accepted", "due_later", tomorrow]); eq(graphCalls, []);
      eq(audits[0].fields, ["disable"]);
    });
    await test("accept / reject / apply: wrong status -> 409 with the current status, nothing audited, nothing written", async () => {
      for (const [status, fn, name] of [["accepted", A.entraProposalAccept, "accept"], ["applied", A.entraProposalAccept, "accept"], ["rejected", A.entraProposalReject, "reject"], ["stale", A.entraProposalReject, "reject"], ["proposed", A.entraProposalApply, "apply"], ["applying", A.entraProposalApply, "apply"], ["failed", A.entraProposalApply, "apply"]]) {
        reset(); db.proposals.set(1, proposal(1, { status }));
        const res = await fn(req(admin, { id: "1" }), ctx);
        eq(res.status, 409, `${name} of ${status}`); eq(res.jsonBody.status, status); eq(audits.length, 0); eq(graphCalls, []);
        eq(pool.calls.length, 1, "read only");
      }
      reset(); db.proposals.delete(1);
      eq((await A.entraProposalAccept(req(admin, { id: "1" }), ctx)).status, 404); eq(audits.map(a => a.outcome), ["not_found"]);
    });
    await test("reject: proposed or accepted -> rejected + rejection row keyed by the hash; audited", async () => {
      reset();
      let res = await A.entraProposalReject(req(admin, { id: "1" }), ctx);
      eq([res.status, res.jsonBody.status, res.jsonBody.applyOutcome, res.jsonBody.decidedBy], [200, "rejected", null, "delegated:fraser@qsrgroup.ca"]);
      eq(db.rejections, [dedupeHash("E100", "attribute", "jobTitle", null, "General Manager")]);
      eq([audits[0].endpoint, audits[0].employeeId, audits[0].fields], ["POST /hub/entra/proposals/{id}/reject", "E100", ["jobTitle"]]);
      reset(); db.proposals.set(1, proposal(1, { status: "accepted" }));
      res = await A.entraProposalReject(req(admin, { id: "1" }), ctx); eq(res.jsonBody.status, "rejected");
      assert(/status IN \('proposed', 'accepted'\)/.test(S.PROPOSAL_REJECT_SQL));
    });
    await test("apply: accepted -> applying -> applied; before the due date -> 409 (not audited); writes disabled -> 409 writes_disabled with no Graph call and no claim", async () => {
      reset(); db.proposals.set(1, proposal(1, { status: "accepted" }));
      let res = await A.entraProposalApply(req(admin, { id: "1" }), ctx);
      eq([res.status, res.jsonBody.status, res.jsonBody.applyOutcome], [200, "applied", "applied"]); eq(graphCalls.length, 2);
      eq([audits[0].endpoint, audits[0].fields], ["POST /hub/entra/proposals/{id}/apply", ["jobTitle"]]);
      reset(); db.proposals.set(1, proposal(1, { status: "accepted", kind: "disable", field: null, due_date: tomorrow }));
      res = await A.entraProposalApply(req(admin, { id: "1" }), ctx);
      eq(res.status, 409); eq(res.jsonBody.dueDate, tomorrow); eq(audits.length, 0); eq(graphCalls, []); eq(db.proposals.get(1).status, "accepted");
      reset(false); db.proposals.set(1, proposal(1, { status: "accepted" }));
      res = await A.entraProposalApply(req(admin, { id: "1" }), ctx);
      eq([res.status, res.jsonBody.error], [409, "writes_disabled"]); eq(graphCalls, []); eq(audits.length, 0); eq(db.proposals.get(1).status, "accepted", "not claimed");
    });
    await test("apply: Entra drifted since the proposal -> stale with what Entra holds now, no PATCH; account already in the proposed state -> stale", async () => {
      reset(); db.proposals.set(1, proposal(1, { status: "accepted" })); graphUsers[UID].jobTitle = "Someone changed it";
      let res = await A.entraProposalApply(req(admin, { id: "1" }), ctx);
      eq([res.status, res.jsonBody.status, res.jsonBody.applyOutcome, res.jsonBody.currentValue], [200, "stale", "stale", "Someone changed it"]);
      eq(graphCalls.length, 1, "re-read only, no write");
      reset(); db.proposals.set(1, proposal(1, { status: "accepted", kind: "disable", field: null, current_value: "true", proposed_value: "false", due_date: yesterday })); graphUsers[UID].accountEnabled = false;
      res = await A.entraProposalApply(req(admin, { id: "1" }), ctx);
      eq([res.jsonBody.status, res.jsonBody.applyOutcome], ["stale", "stale"]); eq(graphCalls.length, 1); eq(db.userUpdates[0].accountEnabled, 0);
    });
    await test("apply: disable due today sends {accountEnabled:false}; enable sends true; Graph 403 -> failed with status + code only (no retry loop), 502", async () => {
      reset(); db.proposals.set(1, proposal(1, { status: "accepted", kind: "disable", field: null, current_value: "true", proposed_value: "false", due_date: today }));
      let res = await A.entraProposalApply(req(admin, { id: "1" }), ctx);
      eq(res.jsonBody.status, "applied"); eq(graphCalls[1], `PATCH ${UID} {"accountEnabled":false}`); eq(db.userUpdates[0].accountEnabled, 0);
      reset(); db.proposals.set(1, proposal(1, { status: "accepted", kind: "enable", field: null, current_value: "false", proposed_value: "true" })); graphUsers[UID].accountEnabled = false;
      res = await A.entraProposalApply(req(admin, { id: "1" }), ctx);
      eq(res.jsonBody.status, "applied"); eq(graphCalls[1], `PATCH ${UID} {"accountEnabled":true}`);
      reset(); db.proposals.set(1, proposal(1, { status: "accepted" })); graphFails = new GraphError(403, "Authorization_RequestDenied", "Graph 403 on PATCH /users/x: Authorization_RequestDenied");
      res = await A.entraProposalApply(req(admin, { id: "1" }), ctx);
      eq([res.status, res.jsonBody.status, res.jsonBody.applyOutcome, res.jsonBody.error], [502, "failed", "failed", "Graph 403: Authorization_RequestDenied"]);
      eq(graphCalls.length, 2, "one attempt"); eq(db.userUpdates, [], "snapshot untouched");
      reset(); db.proposals.set(1, proposal(1, { status: "accepted" })); graphUsers = {};
      res = await A.entraProposalApply(req(admin, { id: "1" }), ctx);
      eq([res.status, res.jsonBody.status, res.jsonBody.error], [502, "failed", "user not found in Entra"]);
    });
    await test("apply: group_add / group_remove proposals write the membership and refresh entra.group_members", async () => {
      reset(); db.proposals.set(1, proposal(1, { status: "accepted", kind: "group_add", field: null, group_id: GID, current_value: null, proposed_value: null, source: "rule", rule_id: 3 }));
      let res = await A.entraProposalApply(req(admin, { id: "1" }), ctx);
      eq(res.jsonBody.status, "applied"); eq(graphCalls, [`ADD ${GID} ${UID}`]); assert(db.members.has(`${GID}|${UID}`)); eq(audits[0].fields, ["group_add"]);
      reset(); db.members.add(`${GID}|${UID}`); db.proposals.set(1, proposal(1, { status: "accepted", kind: "group_remove", field: null, group_id: GID, current_value: null, proposed_value: null, source: "rule" }));
      res = await A.entraProposalApply(req(admin, { id: "1" }), ctx);
      eq(res.jsonBody.status, "applied"); eq(graphCalls, [`REMOVE ${GID} ${UID}`]); assert(!db.members.has(`${GID}|${UID}`));
    });
    await test("audit failure -> 503 and nothing changes (accept, reject, apply, managed, rule, link, unlink); SQL failure -> 503 and pool reset", async () => {
      for (const [name, fn, params, body] of ALL.filter(([n]) => !["decide", "members add", "members remove"].includes(n))) {
        reset(); auditFails = true; db.proposals.set(1, proposal(1, { status: name === "apply" ? "accepted" : "proposed" })); db.rules.set(10, ruleRow(10));
        const res = await fn(req(admin, params, body), ctx);
        eq(res.status, 503, `${name} audit down`); eq(graphCalls, [], `${name}: no Graph call`);
        eq(db.proposals.get(1).status, name === "apply" ? "accepted" : "proposed", `${name}: proposal untouched`);
        assert(db.rules.has(10) && db.links.has("E100") && !db.links.has("E300") && db.groups.get(GID).managed === true, `${name}: nothing changed`);
      }
      reset(); pool = fakePool(() => { throw new Error("db down"); });
      eq((await A.entraProposalAccept(req(admin, { id: "1" }), ctx)).status, 503); assert(resets >= 1);
    });

    // ------------------------------------------------------------ decide ------------------------------------------------------------
    await test("decide: bulk accept / reject with a per-id result and one audit per id; cap ENTRA_MAX_DECIDE; unknown and wrong-status ids reported, not fatal", async () => {
      reset(); db.proposals.set(2, proposal(2, { employee_id: "E200", user_object_id: UID2, status: "accepted" })); db.proposals.set(3, proposal(3, { status: "proposed", kind: "disable", field: null, due_date: tomorrow }));
      graphUsers[UID2] = { id: UID2, jobTitle: "Manager", accountEnabled: true };
      let res = await A.entraProposalsDecide(req(admin, {}, { ids: [1, "2", 3, 4, 1], action: "accept" }), ctx);
      eq(res.status, 200); eq(res.jsonBody.action, "accept");
      eq(res.jsonBody.results, [{ proposalId: 1, outcome: "applied", status: "applied", error: null }, { proposalId: 2, outcome: "conflict", status: "accepted" }, { proposalId: 3, outcome: "due_later", status: "accepted", error: null }, { proposalId: 4, outcome: "not_found", status: null }]);
      eq(audits.map(a => [a.endpoint, a.employeeId, a.fields]), [["POST /hub/entra/proposals/decide", "E100", ["jobTitle"]], ["POST /hub/entra/proposals/decide", "E100", ["disable"]]]);
      reset(); db.proposals.set(2, proposal(2, { status: "accepted" }));
      res = await A.entraProposalsDecide(req(admin, {}, { ids: [1, 2], action: "reject" }), ctx);
      eq(res.jsonBody.results.map(r => r.outcome), ["rejected", "rejected"]); eq(db.rejections.length, 2);
      reset(); process.env.ENTRA_MAX_DECIDE = "2";
      res = await A.entraProposalsDecide(req(admin, {}, { ids: [1, 2, 3], action: "accept" }), ctx);
      eq(res.status, 400); assert(/at most 2/.test(res.jsonBody.error)); eq(audits.length, 0);
      reset(false);
      res = await A.entraProposalsDecide(req(admin, {}, { ids: [1], action: "accept" }), ctx);
      eq(res.jsonBody.results[0], { proposalId: 1, outcome: "writes_disabled", status: "accepted", error: null }); eq(graphCalls, []);
      reset(); auditFails = true; db.proposals.set(2, proposal(2));
      res = await A.entraProposalsDecide(req(admin, {}, { ids: [1, 2], action: "accept" }), ctx);
      eq(res.status, 503); eq(db.proposals.get(1).status, "proposed"); eq(db.proposals.get(2).status, "proposed");
    });

    // ------------------------------------------------------------ manual group members ------------------------------------------------------------
    await test("members add: unlinked skipped, existing members skipped, others written to Graph now with one audit per employee and a manual applied proposal; writes disabled -> 409 before any Graph call", async () => {
      reset(); db.members.add(`${GID}|${UID2}`);
      let res = await A.entraGroupMembersAdd(req(admin, { gid: GID.toUpperCase() }, { employeeIds: ["E100", "E200", "E999", "E100"] }), ctx);
      eq(res.status, 200); eq(res.jsonBody.groupId, GID); eq(res.jsonBody.action, "add");
      eq(res.jsonBody.results, [{ employeeId: "E100", outcome: "added" }, { employeeId: "E200", outcome: "skipped_existing" }, { employeeId: "E999", outcome: "skipped_unlinked" }]);
      eq(graphCalls, [`ADD ${GID} ${UID}`]); assert(db.members.has(`${GID}|${UID}`));
      eq(audits.map(a => [a.endpoint, a.employeeId, a.fields, a.outcome]), [["POST /hub/entra/groups/{gid}/members", "E100", ["group_add"], "allowed"]]);
      eq(db.manual.length, 1); eq([db.manual[0].employee_id, db.manual[0].kind, db.manual[0].group_id, db.manual[0].source, db.manual[0].status], ["E100", "group_add", GID, "manual", "applied"]);
      eq(db.manual[0].dedupe_hash.toString("hex"), dedupeHash("E100", "group_add", null, GID, null));
      reset(false);
      res = await A.entraGroupMembersAdd(req(admin, { gid: GID }, { employeeIds: ["E100"] }), ctx);
      eq([res.status, res.jsonBody.error], [409, "writes_disabled"]); eq(graphCalls, []); eq(audits.length, 0);
    });
    await test("members remove: not a member skipped; Graph failure reported per employee; unmanaged / dynamic / role-assignable group -> 409; unknown group -> 404", async () => {
      reset(); db.members.add(`${GID}|${UID}`);
      let res = await A.entraGroupMembersRemove(req(admin, { gid: GID }, { employeeIds: ["E100", "E200"] }), ctx);
      eq(res.jsonBody.results, [{ employeeId: "E100", outcome: "removed" }, { employeeId: "E200", outcome: "skipped_not_member" }]);
      eq(graphCalls, [`REMOVE ${GID} ${UID}`]); assert(!db.members.has(`${GID}|${UID}`)); eq(audits[0].fields, ["group_remove"]); eq(audits[0].endpoint, "DELETE /hub/entra/groups/{gid}/members");
      reset(); graphFails = new GraphError(403, "Authorization_RequestDenied", "x");
      res = await A.entraGroupMembersAdd(req(admin, { gid: GID }, { employeeIds: ["E100"] }), ctx);
      eq(res.status, 200); eq(res.jsonBody.results, [{ employeeId: "E100", outcome: "failed", error: "Graph 403: Authorization_RequestDenied" }]); eq(db.manual, []);
      reset();
      eq((await A.entraGroupMembersAdd(req(admin, { gid: GID2 }, { employeeIds: ["E100"] }), ctx)).status, 409, "not managed");
      db.groups.get(GID).group_types = "DynamicMembership";
      res = await A.entraGroupMembersAdd(req(admin, { gid: GID }, { employeeIds: ["E100"] }), ctx); eq([res.status, res.jsonBody.error], [409, "group_not_manageable"]);
      db.groups.get(GID).group_types = ""; db.groups.get(GID).role_assignable = true;
      eq((await A.entraGroupMembersAdd(req(admin, { gid: GID }, { employeeIds: ["E100"] }), ctx)).status, 409);
      eq((await A.entraGroupMembersAdd(req(admin, { gid: "33333333-3333-3333-3333-333333333333" }, { employeeIds: ["E100"] }), ctx)).status, 404);
      eq(graphCalls, []); eq(audits.length, 0);
    });
    await test("managed: PUT toggles the flag (audited); dynamic / role-assignable cannot be managed -> 409; unknown -> 404", async () => {
      reset();
      let res = await A.entraGroupManaged(req(admin, { gid: GID2 }, { managed: true }), ctx);
      eq([res.status, res.jsonBody.objectId, res.jsonBody.managed, res.jsonBody.displayName], [200, GID2, true, "GMs"]);
      eq(audits.map(a => [a.endpoint, a.fields]), [["PUT /hub/entra/groups/{gid}/managed", ["managed"]]]);
      res = await A.entraGroupManaged(req(admin, { gid: GID }, { managed: false }), ctx); eq(res.jsonBody.managed, false);
      reset(); db.groups.get(GID2).group_types = "DynamicMembership";
      eq((await A.entraGroupManaged(req(admin, { gid: GID2 }, { managed: true }), ctx)).status, 409);
      eq((await A.entraGroupManaged(req(admin, { gid: GID2 }, { managed: false }), ctx)).status, 200, "switching off is always allowed");
      eq((await A.entraGroupManaged(req(admin, { gid: "33333333-3333-3333-3333-333333333333" }, { managed: true }), ctx)).status, 404);
    });

    // ------------------------------------------------------------ rules ------------------------------------------------------------
    await test("rules: PUT creates (csv tokens upper-cased, statuses default A,L, mode default add_only) and updates; the group must be managed; DELETE stales its proposals; audited", async () => {
      reset();
      let res = await A.entraRuleSave(req(admin, {}, { groupId: GID.toUpperCase(), name: " GMs ", jobCodes: ["gm", "agm"], districts: "t1 t2", stores: null, companies: "", notes: "x" }), ctx);
      eq(res.status, 200);
      eq([res.jsonBody.ruleId, res.jsonBody.groupId, res.jsonBody.name, res.jsonBody.jobCodes, res.jsonBody.districts, res.jsonBody.stores, res.jsonBody.companies, res.jsonBody.statuses, res.jsonBody.mode, res.jsonBody.enabled, res.jsonBody.notes, res.jsonBody.updatedBy],
         [10, GID, "GMs", "GM,AGM", "T1,T2", null, null, "A,L", "add_only", true, "x", "delegated:fraser@qsrgroup.ca"]);
      eq(audits.map(a => [a.endpoint, a.fields]), [["PUT /hub/entra/rules", ["rule"]]]);
      res = await A.entraRuleSave(req(admin, { id: "10" }, { groupId: GID, name: "GMs v2", jobCodes: "GM", statuses: ["a", "l", "t"], mode: "add_and_remove", enabled: false }), ctx);
      eq([res.status, res.jsonBody.name, res.jsonBody.statuses, res.jsonBody.mode, res.jsonBody.enabled], [200, "GMs v2", "A,L,T", "add_and_remove", false]);
      eq(audits[1].endpoint, "PUT /hub/entra/rules/{id}");
      eq((await A.entraRuleSave(req(admin, { id: "99" }, { groupId: GID, name: "x" }), ctx)).status, 404);
      eq((await A.entraRuleSave(req(admin, {}, { groupId: GID2, name: "x" }), ctx)).status, 409, "group not managed");
      eq((await A.entraRuleSave(req(admin, {}, { groupId: "33333333-3333-3333-3333-333333333333", name: "x" }), ctx)).status, 404);
      reset(); db.rules.set(10, ruleRow(10));
      res = await A.entraRuleDelete(req(admin, { id: "10" }), ctx);
      eq([res.status, res.jsonBody], [200, { ruleId: 10, deleted: true }]); assert(!db.rules.has(10)); eq(audits[0].endpoint, "DELETE /hub/entra/rules/{id}");
      eq((await A.entraRuleDelete(req(admin, { id: "10" }), ctx)).status, 404);
      assert(/UPDATE entra.proposals SET status = 'stale' WHERE rule_id = @id/.test(S.RULE_DELETE_SQL), "deleting a rule stales its open proposals");
    });

    // ------------------------------------------------------------ links ------------------------------------------------------------
    await test("links: POST creates a manual link (old link replaced, open proposals of the employee -> stale), user must be in the snapshot, user linked elsewhere -> 409; DELETE unlinks and stales; audited with the employee", async () => {
      reset();
      let res = await A.entraLinkCreate(req(admin, {}, { employeeId: "E100", userObjectId: UID3.toUpperCase() }), ctx);
      eq(res.status, 200); eq([res.jsonBody.employeeId, res.jsonBody.userObjectId, res.jsonBody.method, res.jsonBody.linkedBy], ["E100", UID3, "manual", "delegated:fraser@qsrgroup.ca"]);
      eq(db.proposals.get(1).status, "stale", "open proposals built on the old link are stale");
      eq(audits.map(a => [a.endpoint, a.employeeId, a.fields]), [["POST /hub/entra/links", "E100", ["link"]]]);
      reset();
      res = await A.entraLinkCreate(req(admin, {}, { employeeId: "E300", userObjectId: UID2 }), ctx);
      eq([res.status, res.jsonBody.error, res.jsonBody.employeeId], [409, "user_already_linked", "E200"]); eq(audits.length, 0);
      eq((await A.entraLinkCreate(req(admin, {}, { employeeId: "E300", userObjectId: "33333333-3333-3333-3333-333333333333" }), ctx)).status, 404);
      reset();
      res = await A.entraLinkDelete(req(admin, { employeeId: "E100" }), ctx);
      eq([res.status, res.jsonBody], [200, { employeeId: "E100", unlinked: true }]); assert(!db.links.has("E100")); eq(db.proposals.get(1).status, "stale");
      eq(audits.map(a => [a.endpoint, a.employeeId]), [["DELETE /hub/entra/links/{employeeId}", "E100"]]);
      eq((await A.entraLinkDelete(req(admin, { employeeId: "E100" }), ctx)).status, 404);
      assert(/DELETE FROM entra.links WHERE employee_id = @employeeId/.test(S.LINK_MANUAL_SQL) && /status = 'stale'/.test(S.LINK_MANUAL_SQL) && /'manual'/.test(S.LINK_MANUAL_SQL));
    });
    await test("store SQL: proposal upsert matches open rows by hash only, never reopens decided rows; stale never touches applying; auto links never overwrite manual", () => {
      assert(/ON t.dedupe_hash = s.dedupe_hash AND t.status IN \('proposed', 'accepted', 'applying', 'blocked'\)/.test(S.PROPOSALS_UPSERT_SQL));
      assert(/CASE WHEN t.status IN \('proposed', 'blocked'\) THEN s.status ELSE t.status END/.test(S.PROPOSALS_UPSERT_SQL), "accepted / applying rows keep their status");
      assert(/status IN \('proposed', 'accepted', 'blocked'\)/.test(S.PROPOSALS_STALE_SQL) && !/applying/.test(S.PROPOSALS_STALE_SQL));
      assert(/DELETE FROM entra.links WHERE method = 'matched_email'/.test(S.LINKS_REPLACE_AUTO_SQL) && /NOT EXISTS \(SELECT 1 FROM entra.links l WHERE l.employee_id = s.employeeId\)/.test(S.LINKS_REPLACE_AUTO_SQL));
      assert(/missing_since_utc = SYSUTCDATETIME\(\) WHERE fetched_utc < @fetchedUtc AND missing_since_utc IS NULL/.test(S.USERS_MARK_MISSING_SQL));
      assert(/FROM rpt.v_directory/.test(S.DIRECTORY_SQL) && /work_email/.test(S.DIRECTORY_SQL) && !/personal_email|phone|birth/.test(S.DIRECTORY_SQL), "the sync reads the directory view only");
      assert(/effective_date <= @today/.test(S.LATEST_EVENTS_SQL));
    });
  } finally { restore(); }

  report("entra admin endpoints");
};
