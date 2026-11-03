/* Entra sync: the run (in-memory store + fake Graph), the lock, the timer gate, the after-sync hook, the manual endpoint, settings. */
const path = require("path");
const { DIST, test, report, assert, eq, stubModule, fakePool } = require("./helpers");

module.exports = async () => {
  // ---------------------------------------------------------------- the run itself ----------------------------------------------------------------
  const { runEntraSync } = require(path.join(DIST, "shared", "entra", "sync.js"));
  const { dedupeHash } = require(path.join(DIST, "shared", "entra", "compare.js"));

  /** In-memory EntraStore. */
  const memStore = (seed = {}) => {
    const s = {
      running: false, runs: [], userMap: new Map(), groupMap: new Map(seed.groups ?? []), members: new Map(), linkMap: new Map(seed.links ?? []), issues: [],
      proposalMap: new Map(seed.proposals ?? []), rejectionSet: new Set(seed.rejections ?? []), ruleRows: seed.rules ?? [], directoryRows: seed.directory ?? [], events: seed.events ?? new Map(), nextId: 100,
      async isRunning() { return s.running; },
      async startRun(trigger) { s.runs.push({ id: "r1", trigger, status: "running" }); return "r1"; },
      async finishRun(id, status, counts, error) { Object.assign(s.runs.find(r => r.id === id), { status, counts, error }); },
      async upsertUsers(users, fetchedUtc) { for (const u of users) s.userMap.set(u.id, { ...u, fetchedUtc, missing: false }); },
      async markMissingUsers(fetchedUtc) { let n = 0; for (const u of s.userMap.values()) if (u.fetchedUtc < fetchedUtc && !u.missing) { u.missing = true; n++; } return n; },
      async upsertGroups(groups) { for (const g of groups) s.groupMap.set(g.id, { ...(s.groupMap.get(g.id) ?? { managed: false }), ...g }); },
      async replaceGroupMembers(gid, ids) { s.members.set(gid, new Set(ids)); },
      async directory() { return s.directoryRows; },
      async users() { return [...s.userMap.values()].map(u => ({ objectId: u.id, upn: u.userPrincipalName, mail: u.mail, displayName: u.displayName ?? null, jobTitle: u.jobTitle ?? null, department: u.department ?? null, officeLocation: u.officeLocation ?? null, accountEnabled: u.accountEnabled !== false, employeeIdAttr: null, userType: u.userType ?? null, onpremSynced: !!u.onPremisesSyncEnabled, missingSinceUtc: u.missing ? "x" : null })); },
      async groups() { return [...s.groupMap.values()].map(g => ({ objectId: g.id, displayName: g.displayName ?? null, groupTypes: g.groupTypes ?? [], securityEnabled: true, mailEnabled: false, roleAssignable: !!g.isAssignableToRole, managed: !!g.managed })); },
      async memberships() { const out = new Map(); for (const [gid, ids] of s.members) for (const u of ids) { if (!out.has(u)) out.set(u, new Set()); out.get(u).add(gid); } return out; },
      async links() { return [...s.linkMap.values()]; },
      async replaceAutoLinks(rows) { for (const l of [...s.linkMap.values()]) if (l.method === "matched_email" && !rows.some(r => r.employeeId === l.employeeId && r.userObjectId === l.userObjectId)) s.linkMap.delete(l.employeeId);
        for (const r of rows) if (!s.linkMap.has(r.employeeId) && ![...s.linkMap.values()].some(l => l.userObjectId === r.userObjectId)) s.linkMap.set(r.employeeId, { ...r, method: "matched_email" }); return s.linkMap.size; },
      async replaceLinkIssues(issues) { s.issues = issues; },
      async openProposals() { return [...s.proposalMap.values()].filter(p => ["proposed", "accepted", "applying", "blocked"].includes(p.status)); },
      async rejections() { return new Set(s.rejectionSet); },
      async rules() { return s.ruleRows; },
      async latestEvents() { return s.events; },
      async upsertProposals(rows) { let n = 0; for (const r of rows) { const open = [...s.proposalMap.values()].find(p => p.dedupeHash === r.dedupeHash && ["proposed", "accepted", "applying", "blocked"].includes(p.status)); if (open) { open.seen = (open.seen ?? 1) + 1; continue; } s.proposalMap.set(s.nextId, { proposalId: s.nextId, ...r }); s.nextId++; n++; } return n; },
      async staleProposals(ids) { let n = 0; for (const id of ids) { const p = s.proposalMap.get(id); if (p && ["proposed", "accepted", "blocked"].includes(p.status)) { p.status = "stale"; n++; } } return n; },
      async pruneRejections(keep) { let n = 0; for (const h of [...s.rejectionSet]) if (!keep.includes(h)) { s.rejectionSet.delete(h); n++; } return n; }
    };
    return s;
  };
  const fakeGraph = (data) => {
    const calls = [];
    return { calls,
      async listUsers(domain) { calls.push(`users ${domain}`); return data.users ?? []; },
      async listGroups() { calls.push("groups"); return data.groups ?? []; },
      async listGroupMemberUserIds(gid) { calls.push(`members ${gid}`); return (data.members ?? {})[gid] ?? []; },
      async patchUser() { throw new Error("the sync must never write"); }, async addGroupMember() { throw new Error("never"); }, async removeGroupMember() { throw new Error("never"); }
    };
  };
  const dir = (id, email, over = {}) => ({ employeeId: id, employeeNumber: id, companyId: "SWN6T", companyCount: 1, employeeStatus: "A", displayName: id, district: "T1", store: "T00037", storeName: "Main Street", storeCity: "Ottawa", department: "Main Street", jobCode: "GM", jobTitle: "General Manager", fullOrPartTime: "F", originalHireDate: null, lastHireDate: null, terminationDate: null, dateLastWorked: null, workEmail: email, updatedUtc: null, ...over });
  const gu = (id, upn, over = {}) => ({ id, userPrincipalName: upn, mail: upn, displayName: id, jobTitle: "General Manager", department: "Main Street", officeLocation: "Ottawa", accountEnabled: true, employeeId: null, userType: "Member", onPremisesSyncEnabled: false, ...over });
  const logs = [];
  const log = (m) => logs.push(m);
  const opts = (over = {}) => ({ domains: ["qsrgroup.ca"], headOfficeCity: null, trigger: "manual", log, now: () => new Date("2026-11-03T12:00:00Z"), ...over });

  await test("sync run: snapshot (users per domain, groups, members of managed groups only) -> links -> proposals; run row carries the counts; nothing written to Graph", async () => {
    logs.length = 0;
    const store = memStore({ directory: [dir("E1", "pat@qsrgroup.ca"), dir("E2", "sam@qsrgroup.ca", { jobTitle: "Assistant Manager" }), dir("E3", null)], groups: [["g1", { id: "g1", managed: true }], ["g2", { id: "g2", managed: false }]], events: new Map([["E2", 55]]) });
    const graph = fakeGraph({ users: [gu("u1", "pat@qsrgroup.ca"), gu("u2", "sam@qsrgroup.ca"), gu("u9", "orphan@qsrgroup.ca")], groups: [{ id: "g1", displayName: "GMs", groupTypes: [], securityEnabled: true, mailEnabled: false, isAssignableToRole: false }, { id: "g2", displayName: "Other", groupTypes: [], securityEnabled: true, mailEnabled: false, isAssignableToRole: false }], members: { g1: ["u1"] } });
    const r = await runEntraSync(store, graph, opts({ domains: ["qsrgroup.ca", "other.test"] }));
    eq([r.status, r.message], ["succeeded", undefined]);
    eq([r.trigger, r.runId, r.usersFetched, r.groupsFetched, r.linked, r.linkIssues, r.proposalsNew, r.proposalsStale, r.proposalsBlocked], ["manual", "r1", 3, 2, 2, 1, 1, 0, 0]);
    eq(graph.calls, ["users qsrgroup.ca", "users other.test", "groups", "members g1"], "members fetched for managed groups only");
    eq(store.runs[0].status, "succeeded"); eq(store.runs[0].counts, { usersFetched: 3, groupsFetched: 2, linked: 2, proposalsNew: 1, proposalsStale: 0 });
    const p = [...store.proposalMap.values()][0];
    eq([p.employeeId, p.userObjectId, p.kind, p.field, p.currentValue, p.proposedValue, p.eventId, p.status], ["E2", "u2", "attribute", "jobTitle", "General Manager", "Assistant Manager", 55, "proposed"]);
    eq(store.issues.map(i => i.kind), ["user_without_employee"]);
    assert(logs.every(l => !/pat@|sam@|orphan@/.test(l)), "no emails in the log lines");
  });
  await test("sync run: second run -> same proposal not duplicated; difference gone -> stale; rejection cleared once equal; blocked for on-prem accounts", async () => {
    const h = dedupeHash("E1", "attribute", "jobTitle", null, "General Manager");
    const store = memStore({ directory: [dir("E1", "pat@qsrgroup.ca"), dir("E2", "sam@qsrgroup.ca")],
      proposals: [[7, { proposalId: 7, employeeId: "E2", status: "proposed", dedupeHash: "gone" }], [8, { proposalId: 8, employeeId: "E2", status: "applying", dedupeHash: "busy" }]],
      rejections: [h, "stale-rejection"] });
    const graph = fakeGraph({ users: [gu("u1", "pat@qsrgroup.ca", { jobTitle: "Manager" }), gu("u2", "sam@qsrgroup.ca", { department: "Wrong", onPremisesSyncEnabled: true })] });
    let r = await runEntraSync(store, graph, opts());
    eq([r.proposalsNew, r.proposalsStale, r.proposalsBlocked, r.proposalsOpen], [1, 1, 1, 0]);
    eq(store.proposalMap.get(7).status, "stale"); eq(store.proposalMap.get(8).status, "applying", "applying rows are never staled");
    eq([...store.rejectionSet], [h], "the rejection still suppressing a live difference is kept; the other is pruned");
    const blocked = [...store.proposalMap.values()].find(p => p.status === "blocked");
    eq([blocked.employeeId, blocked.field], ["E2", "department"]);
    r = await runEntraSync(store, graph, opts());
    eq([r.proposalsNew, r.proposalsStale], [0, 0], "nothing new on an unchanged second run");
  });
  await test("sync run: lock -> locked without a run row; Graph failure -> failed run row with the message (no query string), nothing thrown", async () => {
    let store = memStore(); store.running = true;
    eq(await runEntraSync(store, fakeGraph({}), opts()), { status: "locked", trigger: "manual", message: "an Entra sync is already running" });
    eq(store.runs, []);
    store = memStore();
    const graph = fakeGraph({}); graph.listUsers = async () => { throw new Error("Graph 403 on GET /users?$filter=secret: Authorization_RequestDenied"); };
    const r = await runEntraSync(store, graph, opts({ trigger: "timer" }));
    eq([r.status, r.trigger, r.runId, r.message], ["failed", "timer", "r1", "Graph 403 on GET /users"]);
    eq([store.runs[0].status, store.runs[0].error], ["failed", "Graph 403 on GET /users"]);
  });

  // ---------------------------------------------------------------- functions: timer, hook, endpoint ----------------------------------------------------------------
  const audits = [];
  let auditFails = false;
  const jobRuns = [];
  let jobResult = () => ({ status: "succeeded", trigger: "manual", runId: "r1", usersFetched: 3, groupsFetched: 2, linked: 2, proposalsNew: 1, proposalsStale: 0 });
  let syncResult = { status: "succeeded" };
  const realSql = require(path.join(DIST, "shared", "sql.js")).sql;
  stubModule("shared/sql.js", { getSharedHubPool: async () => fakePool(), resetSharedHubPool() {}, openHubPool: async () => fakePool(), sql: realSql });
  stubModule("shared/audit.js", { writeAudit: async (e) => { if (auditFails) throw new Error("down"); audits.push(e); }, probeAudit: async () => 1 });
  stubModule("shared/entra/runner.js", { runEntraSyncJob: async (_ctx, trigger) => { jobRuns.push(trigger); const r = jobResult(); if (r instanceof Error) throw r; return r; } });
  stubModule("shared/connectors.js", { runConnector: async () => ({ status: "succeeded" }), runDiscovery: async () => ({}) });
  stubModule("shared/hubSync.js", { runIntradaySync: async () => syncResult, runNightly: async () => ({ status: "succeeded" }) });
  stubModule("shared/hubStore.js", { SqlHubStore: class {} });
  const timers = {};
  const af = require("@azure/functions");
  const realTimer = af.app.timer;
  af.app.timer = (name, o) => { timers[name] = o; };
  delete require.cache[require.resolve(path.join(DIST, "functions", "hubSync.js"))];
  delete require.cache[require.resolve(path.join(DIST, "functions", "entraSync.js"))];
  const { runSyncThenDeliver } = require(path.join(DIST, "functions", "hubSync.js"));
  const { entraSyncRun } = require(path.join(DIST, "functions", "entraSync.js"));
  af.app.timer = realTimer;
  const { config } = require(path.join(DIST, "shared", "config.js"));

  const principal = (claims) => Buffer.from(JSON.stringify({ claims })).toString("base64");
  const entraAdmin = [{ typ: "scp", val: "Employees.Summary.Read Employees.Summary.Write" }, { typ: "roles", val: "Entra.Admin" }, { typ: "preferred_username", val: "fraser@qsrgroup.ca" }, { typ: "azp", val: "monitor-app" }];
  const summaryAdmin = [{ typ: "scp", val: "Employees.Summary.Read Employees.Summary.Write" }, { typ: "roles", val: "Summary.Admin" }];
  const noWriteScope = [{ typ: "scp", val: "Employees.Summary.Read" }, { typ: "roles", val: "Entra.Admin" }];
  const appRun = [{ typ: "idtyp", val: "app" }, { typ: "roles", val: "Integration.Run" }];
  const appOther = [{ typ: "idtyp", val: "app" }, { typ: "roles", val: "Roster.Read.All" }];
  const req = (claims) => ({ headers: new Headers(claims ? { "x-ms-client-principal": principal(claims) } : {}), params: {}, query: new URLSearchParams() });
  const ctxLogs = [];
  const ctx = { log(...a) { ctxLogs.push(a.join(" ")); }, error(...a) { ctxLogs.push("ERROR " + a.join(" ")); }, warn(...a) { ctxLogs.push("WARN " + a.join(" ")); } };
  const ENV = ["ENTRA_SYNC_ENABLED", "ENTRA_WRITE_ENABLED", "ENTRA_ACCOUNT_DOMAINS", "ENTRA_GRAPH_BASE", "ENTRA_HEAD_OFFICE_CITY", "ENTRA_MAX_DECIDE", "CLEARVIEW_ENABLED"];
  const saved = {}; for (const k of ENV) saved[k] = process.env[k];
  const reset = () => { audits.length = 0; auditFails = false; jobRuns.length = 0; ctxLogs.length = 0; for (const k of ENV) delete process.env[k]; };
  const restore = () => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };

  try {
    await test("entra timer: registered at 06:45 UTC daily; does nothing unless ENTRA_SYNC_ENABLED = true", async () => {
      reset();
      assert(timers.entraSyncTimer, "timer registered"); eq(timers.entraSyncTimer.schedule, "0 45 6 * * *");
      await timers.entraSyncTimer.handler({}, ctx); eq(jobRuns, []); assert(ctxLogs.some(l => /ENTRA_SYNC_ENABLED is not 'true'/.test(l)), ctxLogs.join("\n"));
      process.env.ENTRA_SYNC_ENABLED = "false"; await timers.entraSyncTimer.handler({}, ctx); eq(jobRuns, []);
      process.env.ENTRA_SYNC_ENABLED = "true"; await timers.entraSyncTimer.handler({}, ctx); eq(jobRuns, ["timer"]);
    });
    await test("after-sync hook: Entra run after a succeeded / partial sync only when ENTRA_SYNC_ENABLED; its errors never fail the sync", async () => {
      reset(); process.env.ENTRA_SYNC_ENABLED = "true"; syncResult = { status: "succeeded" };
      eq((await runSyncThenDeliver(ctx, "timer")).status, "succeeded"); eq(jobRuns, ["after-sync"]);
      reset(); process.env.ENTRA_SYNC_ENABLED = "true"; syncResult = { status: "partial" }; await runSyncThenDeliver(ctx, "manual"); eq(jobRuns, ["after-sync"]);
      reset(); process.env.ENTRA_SYNC_ENABLED = "true"; syncResult = { status: "failed", message: "x" }; await runSyncThenDeliver(ctx, "manual"); eq(jobRuns, []);
      reset(); syncResult = { status: "succeeded" }; await runSyncThenDeliver(ctx, "manual"); eq(jobRuns, [], "unset -> no Entra run");
      reset(); process.env.ENTRA_SYNC_ENABLED = "true"; jobResult = () => new Error("boom?token=1");
      eq((await runSyncThenDeliver(ctx, "manual")).status, "succeeded"); assert(ctxLogs.some(l => l === "ERROR [entra] after-sync run error: boom"), ctxLogs.join("\n"));
      jobResult = () => ({ status: "succeeded", trigger: "manual" });
    });
    await test("POST /hub/entra/sync: Entra.Admin + write scope or app role Integration.Run; Summary.Admin alone is refused; audited before running (503 fail-closed)", async () => {
      reset();
      eq((await entraSyncRun(req(null), ctx)).status, 401);
      eq((await entraSyncRun(req(summaryAdmin), ctx)).jsonBody.detail, "insufficient_role");
      eq((await entraSyncRun(req(noWriteScope), ctx)).jsonBody.detail, "insufficient_scope");
      eq((await entraSyncRun(req(appOther), ctx)).jsonBody.detail, "app_only_not_allowed");
      eq(jobRuns, []); eq(audits, []);
      const ok = await entraSyncRun(req(entraAdmin), ctx);
      eq([ok.status, ok.headers["Cache-Control"], ok.jsonBody.status], [200, "no-store", "succeeded"]); eq(jobRuns, ["manual"]);
      eq([audits[0].endpoint, audits[0].action, audits[0].fields, audits[0].outcome, audits[0].employeeId, audits[0].caller.user], ["POST /hub/entra/sync", "write", ["proposals"], "allowed", "", "fraser@qsrgroup.ca"]);
      reset(); eq((await entraSyncRun(req(appRun), ctx)).status, 200); eq(jobRuns, ["manual"]);
      reset(); auditFails = true; eq((await entraSyncRun(req(entraAdmin), ctx)).status, 503); eq(jobRuns, [], "nothing runs when the audit cannot be written");
    });
    await test("POST /hub/entra/sync: 409 while locked, 502 on a failed run, 503 when it cannot start (error audit)", async () => {
      reset(); jobResult = () => ({ status: "locked", trigger: "manual", message: "an Entra sync is already running" });
      const locked = await entraSyncRun(req(entraAdmin), ctx); eq(locked.status, 409); eq(locked.jsonBody.status, "locked");
      reset(); jobResult = () => ({ status: "failed", trigger: "manual", message: "Graph 403" });
      eq((await entraSyncRun(req(entraAdmin), ctx)).status, 502);
      reset(); jobResult = () => new Error("Missing required setting: HUB_SQL_SERVER?x=1");
      const r = await entraSyncRun(req(entraAdmin), ctx);
      eq(r.status, 503); eq(audits.map(a => a.outcome), ["allowed", "error"]);
      assert(ctxLogs.some(l => l.startsWith("ERROR [entra] manual sync error: Missing required setting: HUB_SQL_SERVER") && !l.includes("x=1")), ctxLogs.join("\n"));
      jobResult = () => ({ status: "succeeded", trigger: "manual" });
    });
    await test("config: Entra settings and defaults; Entra.Admin implies Summary.Read", () => {
      reset();
      eq([config.entraSyncEnabled, config.entraWriteEnabled, config.entraAccountDomains, config.entraGraphBase, config.entraHeadOfficeCity, config.entraMaxDecide],
         [false, false, ["qsrgroup.ca"], "https://graph.microsoft.com/v1.0", null, 200]);
      process.env.ENTRA_SYNC_ENABLED = "TRUE"; process.env.ENTRA_WRITE_ENABLED = "yes"; process.env.ENTRA_ACCOUNT_DOMAINS = "QSRGroup.ca, @other.test"; process.env.ENTRA_GRAPH_BASE = "https://graph.microsoft.com/beta/";
      process.env.ENTRA_HEAD_OFFICE_CITY = " Toronto "; process.env.ENTRA_MAX_DECIDE = "50";
      eq([config.entraSyncEnabled, config.entraWriteEnabled, config.entraAccountDomains, config.entraGraphBase, config.entraHeadOfficeCity, config.entraMaxDecide],
         [true, false, ["qsrgroup.ca", "other.test"], "https://graph.microsoft.com/beta", "Toronto", 50]);
      const { getCaller, Roles } = require(path.join(DIST, "shared", "auth.js"));
      eq(Roles.EntraAdmin, "Entra.Admin");
      const c = getCaller(req(entraAdmin));
      assert(c.roles.has("Entra.Admin") && c.roles.has("Summary.Read") && !c.roles.has("Summary.Admin"), [...c.roles].join(","));
    });
  } finally { restore(); }

  report("entra sync");
};
