/* Generic delivery runner with a fake store and a fake connector: shadow / live / unchanged, retries, dead, waiting,
   per-employee stop, blocking rule, kill switch, resolveCreated, purge, log lines. Also the SqlDeliveryStore SQL text. */
const path = require("path");
const { DIST, FAKE_YEAR, test, report, assert, eq, noYear, fakePool } = require("./helpers");

const SIN = "123456789";
const NOW = new Date("2026-11-02T15:00:00Z");

module.exports = async () => {
  const { runDeliveries, RETRY_DELAYS_MS, WAITING_DELAY_MS, MappingError, DeliveryError, canonicalJson, payloadHash, orderDeliveries, pickEmployment } =
    require(path.join(DIST, "shared", "delivery.js"));
  const { SqlDeliveryStore, CLAIM_SQL, CONTEXT_SQL, STATS_SQL, PENDING_CREATES_SQL, PURGE_SHADOW_SQL, mapCodeRows, mapClaimedRow } =
    require(path.join(DIST, "shared", "deliveryStore.js"));

  // ---------------------------------------------------------------- fakes ----------------------------------------------------------------
  const row = (id, over = {}) => ({ deliveryId: id, destination: "clearview", employeeId: "E1", eventKey: null, kind: "event", eventType: "Pay change",
    action: "pay", effectiveDate: "2026-11-01", store: "T22446", status: "pending", attempts: 0, nextAttemptUtc: null, lastError: null, ...over });

  /** In-memory store: rows change status like SQL would; the claim applies the blocking rule and ordering. */
  function fakeStore(rows, opts = {}) {
    const s = {
      rows, runs: [], shadow: new Map(), lastSent: new Map(), xref: new Map(Object.entries(opts.xref ?? {})), purged: 0, running: !!opts.running,
      modes: opts.modes ?? { T22446: "live" }, employment: opts.employment, event: opts.event, codes: opts.codes,
      async isRunning() { return s.running; },
      async startRun() { s.runs.push({ status: "running" }); return "run-1"; },
      async finishRun(_id, status, counts, error) { Object.assign(s.runs[s.runs.length - 1], { status, counts, error }); },
      async claim(destination, limit) {
        const blocked = new Set(s.rows.filter(r => r.destination === destination && (r.status === "dead" || (["failed", "waiting"].includes(r.status) && r.nextAttemptUtc > NOW))).map(r => r.employeeId));
        return orderDeliveries(s.rows.filter(r => r.destination === destination && ["pending", "failed", "waiting"].includes(r.status)
          && (!r.nextAttemptUtc || r.nextAttemptUtc <= NOW) && !blocked.has(r.employeeId))).slice(0, limit).map(r => ({ ...r }));
      },
      async loadContext(d) {
        return {
          delivery: d, event: s.event === null ? null : { eventType: d.eventType, effectiveDate: d.effectiveDate, fromCompany: null, toCompany: "SWN6T", fromStore: null, toStore: d.store, fromJob: null, toJob: null, terminationCategory: null },
          employment: s.employment === null ? null : { employeeId: d.employeeId, companyId: "SWN6T", employeeNumber: "100234", isHomeCompany: true, employeeStatus: "A", originalHireDate: null, lastHireDate: null, terminationDate: null, orgLevel2: d.store, jobCode: "TM", fullOrPartTime: "P", firstName: "Ann", preferredName: null, lastName: "Example" },
          xref: s.xref.has(d.employeeId) ? { externalId: s.xref.get(d.employeeId).externalId, source: s.xref.get(d.employeeId).source } : null,
          codes: s.codes ?? { store: new Map(), job: new Map(), termination: new Map(), category: new Map(), company: new Map() },
          storeMode: s.modes[d.store] ?? "off",
          lastSent: new Map([...s.lastSent.entries()].filter(([k]) => k.startsWith(`${d.employeeId}|`)).map(([k, v]) => [k.split("|")[1], v]))
        };
      },
      find(id) { return s.rows.find(r => r.deliveryId === id); },
      async markShadow(id, hash, stored, operation) { Object.assign(s.find(id), { status: "shadow", hash, modeAtSend: "shadow", responseRef: `shadow:${operation}` }); s.shadow.set(id, stored); },
      async markSent(id, hash, operation, responseRef, warning) { const r = s.find(id); Object.assign(r, { status: "sent", hash, modeAtSend: "live", attempts: r.attempts + 1, responseRef, lastError: warning }); s.lastSent.set(`${r.employeeId}|${operation}`, hash); },
      async markUnchanged(id, hash) { Object.assign(s.find(id), { status: "unchanged", hash, modeAtSend: "live" }); },
      async markFailed(id, attempts, next, error) { Object.assign(s.find(id), { status: "failed", attempts, nextAttemptUtc: next, lastError: error }); },
      async markDead(id, attempts, error) { Object.assign(s.find(id), { status: "dead", attempts, nextAttemptUtc: null, lastError: error }); },
      async markWaiting(id, next, reason) { Object.assign(s.find(id), { status: "waiting", nextAttemptUtc: next, lastError: reason }); },
      async markSkipped(id, reason) { Object.assign(s.find(id), { status: "skipped", lastError: reason }); },
      async markReview(id, reason) { Object.assign(s.find(id), { status: "review", lastError: reason }); },
      async upsertXref(_d, employeeId, externalId, source) { s.xref.set(employeeId, { externalId, source }); },
      async pendingCreates() {
        return s.rows.filter(r => r.action === "create" && r.status === "sent" && String(r.responseRef ?? "").startsWith("import:") && !s.xref.has(r.employeeId))
          .map(r => ({ deliveryId: r.deliveryId, employeeId: r.employeeId, companyId: "SWN6T", employeeNumber: "100234", lastName: "Example", finishedUtc: r.finishedUtc ?? NOW }));
      },
      async queueStats() {
        const n = st => s.rows.filter(r => r.status === st).length;
        return { pending: n("pending"), waiting: n("waiting"), failed: n("failed"), dead: n("dead"), oldestPendingMinutes: n("pending") ? 42 : null };
      },
      async purgeShadowPayloads() { s.purged++; return 3; }
    };
    return s;
  }

  /** Fake connector: plan = {operation: action, payload with DOB / SIN / pay}; execute programmable. */
  function fakeConnector(over = {}) {
    const c = {
      destination: "clearview", executed: [], resolved: [], credentials: over.credentials ?? (() => true),
      hasCredentials(company) { return c.credentials(company); },
      sensitiveNeeds(ctx) { return ctx.delivery.action === "create" ? ["person", "pay"] : ctx.delivery.action === "pay" ? ["pay"] : []; },
      plan: over.plan ?? ((ctx, s) => ({ decision: "send", plan: { operation: ctx.delivery.action === "create" ? "import" : ctx.delivery.action,
        steps: [{ method: "POST", path: `/x/${ctx.xref?.externalId ?? "$lookup:employeeId"}`, body: { sin: s.sin } }],
        payload: { employeeId: ctx.delivery.employeeId, effectiveDate: ctx.delivery.effectiveDate, sin: s.sin, birthDate: s.dateOfBirth, payRate: s.hourlyPayRate, email: s.email } } })),
      redactForHash(p) { return mask(p, false); }, redactForStore(p) { return mask(p, true); },
      execute: over.execute ?? (async (plan) => { c.executed.push(plan); return { responseRef: `${plan.operation}:ok` }; }),
      resolveCreated: over.resolveCreated ?? (async (p) => { c.resolved.push(p.employeeId); return null; })
    };
    return c;
  }
  function mask(v, pay) {
    const walk = (x, k) => x && typeof x === "object" ? (Array.isArray(x) ? x.map(i => walk(i, k)) : Object.fromEntries(Object.entries(x).map(([kk, vv]) => [kk, walk(vv, kk)]))) :
      k === "sin" ? "*********" : k === "birthDate" ? "****-**-**" : (pay && k === "payRate") ? "***" : x;
    return walk(v, null);
  }
  const ukg = (over = {}) => ({
    calls: [],
    async person(id) { this.calls.push(`person:${id}`); return over.person === null ? null : { sin: SIN, dateOfBirth: `${FAKE_YEAR}-07-14`, email: "ann@example.com", ...(over.person ?? {}) }; },
    async pay(id) { this.calls.push(`pay:${id}`); return { salaryOrHourly: "H", hourlyPayRate: 17.5, annualSalary: null }; }
  });
  const logs = () => { const l = { all: [], log(m) { l.all.push(m); }, warn(m) { l.all.push(`WARN ${m}`); }, error(m) { l.all.push(`ERROR ${m}`); } }; return l; };
  const run = (store, connector, u = ukg(), over = {}) => {
    const l = logs();
    return runDeliveries(store, connector, u, { liveEnabled: true, maxPerRun: 200, waitingAlertDays: 5, shadowRetentionDays: 30, now: () => NOW, ...l, ...over }).then(r => ({ r, logs: l.all }));
  };

  // ---------------------------------------------------------------- runner ----------------------------------------------------------------
  await test("runner: shadow store -> masked copy stored (no DOB year, no SIN digits, pay masked), status shadow, hash set, UKG read at send time", async () => {
    const store = fakeStore([row(1, { action: "create", eventType: "New hire" })], { modes: { T22446: "shadow" } });
    const c = fakeConnector(); const u = ukg();
    const { r } = await run(store, c, u);
    eq([r.status, r.shadow, r.sent, r.claimed], ["succeeded", 1, 0, 1]);
    const d = store.find(1);
    eq(d.status, "shadow"); eq(d.modeAtSend, "shadow"); eq(d.responseRef, "shadow:import"); assert(Buffer.isBuffer(d.hash) && d.hash.length === 32, "hash");
    const stored = store.shadow.get(1);
    noYear(stored, "shadow payload"); assert(!stored.includes(SIN), "SIN digits in shadow payload"); assert(!stored.includes("17.5"), "pay in shadow payload");
    assert(stored.includes('"mode":"shadow"') && stored.includes('"operation":"import"') && stored.includes("$lookup:employeeId"), "stored copy shape");
    eq(u.calls, ["person:E1", "pay:E1"], "person + pay read in shadow too");
    eq(c.executed.length, 0, "nothing sent in shadow");
    eq(store.runs[0].status, "succeeded");
  });

  await test("runner: live -> execute, last_sent recorded; same payload next time -> unchanged without execute; changed pay -> sent", async () => {
    const store = fakeStore([row(1)]);
    const c = fakeConnector();
    const { r } = await run(store, c);
    eq([r.status, r.sent], ["succeeded", 1]); eq(store.find(1).status, "sent"); eq(store.find(1).modeAtSend, "live"); eq(store.find(1).responseRef, "pay:ok");
    eq(store.find(1).attempts, 1); eq(c.executed.length, 1);
    assert(store.lastSent.get("E1|pay").equals(store.find(1).hash), "last_sent hash = delivery hash");
    store.rows.push(row(2));
    const second = await run(store, c);
    eq([second.r.unchanged, second.r.sent], [1, 0]); eq(store.find(2).status, "unchanged"); eq(c.executed.length, 1, "execute not called for an unchanged payload");
    store.rows.push(row(3));
    const u = ukg(); u.pay = async () => ({ salaryOrHourly: "H", hourlyPayRate: 19, annualSalary: null });
    const third = await run(store, c, u);
    eq([third.r.sent, third.r.unchanged], [1, 0]); eq(c.executed.length, 2);
  });

  await test("runner: retry schedule 5m / 30m / 2h / 12h then dead on the 5th failure, with the exact dead log line", async () => {
    const store = fakeStore([row(7)]);
    const c = fakeConnector({ execute: async () => { throw new Error("socket hang up"); } });
    const expected = [5, 30, 120, 720];
    for (let i = 0; i < 4; i++) {
      store.find(7).nextAttemptUtc = null;                               // make it due again
      const { r, logs: l } = await run(store, c);
      const d = store.find(7);
      eq([r.status, r.failed, d.status, d.attempts], ["partial", 1, "failed", i + 1], `attempt ${i + 1}`);
      eq((d.nextAttemptUtc.getTime() - NOW.getTime()) / 60000, expected[i], `delay after failure ${i + 1}`);
      eq(d.lastError, "socket hang up"); assert(!l.some(x => x.includes("[delivery] dead")), "not dead yet");
    }
    eq(RETRY_DELAYS_MS.map(ms => ms / 60000), expected);
    store.find(7).nextAttemptUtc = null;
    const { r, logs: l } = await run(store, c);
    eq([r.dead, store.find(7).status, store.find(7).attempts], [1, "dead", 5]);
    assert(l.includes("ERROR [delivery] dead: destination=clearview delivery_id=7 employee=E1 attempts=5"), l.join("\n"));
  });

  await test("runner: failure classification - dead at once (400), waiting (+1 h, attempts unchanged), abort (401) leaves rows untouched", async () => {
    let store = fakeStore([row(1)]);
    let { r, logs: l } = await run(store, fakeConnector({ execute: async () => { throw new DeliveryError("dead", "Clearview 400 on POST /x: No information was changed"); } }));
    eq([r.dead, store.find(1).status, store.find(1).attempts], [1, "dead", 1]);
    assert(l.includes("ERROR [delivery] dead: destination=clearview delivery_id=1 employee=E1 attempts=1"), l.join("\n"));

    store = fakeStore([row(1, { attempts: 2 })]);
    ({ r } = await run(store, fakeConnector({ execute: async () => { throw new DeliveryError("waiting", "employee not in Clearview yet"); } })));
    eq([r.waiting, r.status, store.find(1).status, store.find(1).attempts], [1, "partial", "waiting", 2]);
    eq(store.find(1).nextAttemptUtc.getTime() - NOW.getTime(), WAITING_DELAY_MS); eq(store.find(1).lastError, "employee not in Clearview yet");

    store = fakeStore([row(1), row(2, { employeeId: "E2" })]);
    ({ r, logs: l } = await run(store, fakeConnector({ execute: async () => { throw new DeliveryError("abort", "Clearview 401 on GET /employee/1"); } })));
    eq(r.status, "failed"); eq(r.message, "Clearview 401 on GET /employee/1");
    eq([store.find(1).status, store.find(2).status], ["pending", "pending"], "rows untouched on abort");
    eq(store.runs[0].status, "failed"); assert(l.some(x => /ERROR .*run aborted, rows untouched/.test(x)));
  });

  await test("runner: a failed / waiting / dead delivery stops that employee's later ones this run; other employees continue", async () => {
    const store = fakeStore([row(1, { action: "store", effectiveDate: "2026-10-01" }), row(2, { action: "pay", effectiveDate: "2026-10-02" }), row(3, { employeeId: "E2" })]);
    let n = 0;
    const c = fakeConnector({ execute: async (plan) => { n++; if (plan.operation === "store") throw new Error("timeout"); return { responseRef: "ok" }; } });
    const { r } = await run(store, c);
    eq([r.failed, r.sent], [1, 1]);
    eq([store.find(1).status, store.find(2).status, store.find(3).status], ["failed", "pending", "sent"]);
    eq(n, 2, "E1's pay delivery was not attempted");
  });

  await test("runner: blocked employees (dead, or failed / waiting not yet due) are not claimed; due retries are; order create<job<store<pay<update<terminate", async () => {
    const later = new Date(NOW.getTime() + 60000), earlier = new Date(NOW.getTime() - 60000);
    const store = fakeStore([
      row(1, { employeeId: "E1", status: "dead" }), row(2, { employeeId: "E1" }),                                   // E1 blocked by a dead row
      row(3, { employeeId: "E2", status: "failed", nextAttemptUtc: later }), row(4, { employeeId: "E2" }),            // E2 blocked until the retry is due
      row(5, { employeeId: "E3", status: "waiting", nextAttemptUtc: earlier }), row(6, { employeeId: "E3", action: "terminate" }),   // E3 due
      row(7, { employeeId: "E4", action: "terminate", effectiveDate: "2026-11-01" }), row(8, { employeeId: "E4", action: "create", effectiveDate: "2026-11-01" }),
      row(9, { employeeId: "E4", action: "job", effectiveDate: "2026-10-01" })
    ]);
    const order = [];
    const c = fakeConnector({ execute: async (plan) => { order.push(plan.payload.employeeId + ":" + plan.operation); return { responseRef: "ok" }; } });
    const { r } = await run(store, c);
    eq(r.claimed, 5);
    eq([store.find(2).status, store.find(4).status], ["pending", "pending"], "blocked employees untouched");
    eq(order, ["E3:pay", "E3:terminate", "E4:job", "E4:import", "E4:terminate"]);
    eq(orderDeliveries([row(1, { action: "terminate" }), row(2, { action: "create" }), row(3, { action: "update" }), row(4, { action: "job" }), row(5, { action: "pay" }), row(6, { action: "store" })]).map(x => x.action),
       ["create", "job", "store", "pay", "update", "terminate"]);
  });

  await test("runner: CLEARVIEW_LIVE_ENABLED false or missing credentials force shadow for live stores, one warning per run; off -> skipped", async () => {
    let store = fakeStore([row(1), row(2, { employeeId: "E2" })]);
    let c = fakeConnector();
    let { r, logs: l } = await run(store, c, ukg(), { liveEnabled: false });
    eq([r.shadow, r.sent], [2, 0]); eq(c.executed.length, 0); eq(store.find(1).modeAtSend, "shadow");
    eq(l.filter(x => x.startsWith("WARN")).length, 1); assert(l.some(x => /WARN .*CLEARVIEW_LIVE_ENABLED is not true/.test(x)), l.join("\n"));
    store = fakeStore([row(1)]); c = fakeConnector({ credentials: () => false });
    ({ r, logs: l } = await run(store, c));
    eq(r.shadow, 1); assert(l.some(x => /WARN .*no credentials for SWN6T/.test(x)), l.join("\n"));
    store = fakeStore([row(1, { store: "T00001" })], { modes: {} });
    ({ r } = await run(store, fakeConnector()));
    eq([r.skipped, store.find(1).status, store.find(1).lastError], [1, "skipped", "store switched off"]);
  });

  await test("runner: MappingError -> dead with the message and the dead log line; skipped / review outcomes recorded; review stops the employee", async () => {
    const store = fakeStore([row(1, { action: "create" }), row(2, { employeeId: "E2" }), row(3, { employeeId: "E3", effectiveDate: "2026-10-01" }), row(4, { employeeId: "E3", effectiveDate: "2026-10-02" })]);
    const c = fakeConnector({ plan: (ctx) => {
      if (ctx.delivery.employeeId === "E1") throw new MappingError("no clearview job code for UKG job SH");
      if (ctx.delivery.employeeId === "E2") return { decision: "skipped", reason: "UKG job MM is not sent to Clearview" };
      return { decision: "review", reason: "HR to handle: company M9WOJ is not sent to Clearview" };
    } });
    const { r, logs: l } = await run(store, c);
    eq([r.dead, r.skipped, r.review, r.status], [1, 1, 1, "partial"]);
    eq([store.find(1).status, store.find(1).lastError], ["dead", "no clearview job code for UKG job SH"]);
    eq([store.find(2).status, store.find(3).status, store.find(4).status], ["skipped", "review", "pending"]);
    assert(l.includes("ERROR [delivery] dead: destination=clearview delivery_id=1 employee=E1 attempts=0"), l.join("\n"));
  });

  await test("runner: missing event or employment context -> dead; UKG read failure -> retry", async () => {
    let store = fakeStore([row(1)], { event: null });
    await run(store, fakeConnector());
    eq([store.find(1).status, store.find(1).lastError], ["dead", "event no longer exists in rpt.workforce_events"]);
    store = fakeStore([row(1)], { employment: null });
    await run(store, fakeConnector());
    eq(store.find(1).status, "dead");
    store = fakeStore([row(1)]);
    const u = ukg(); u.pay = async () => { const e = new Error("UKG 503 on /personnel/v1/employee-employment-details"); e.status = 503; throw e; };
    const { r } = await run(store, fakeConnector(), u);
    eq([r.failed, store.find(1).status, store.find(1).attempts], [1, "failed", 1]);
  });

  await test("runner: resolveCreated inserts xref for sent imports; waiting alert line after CLEARVIEW_WAITING_ALERT_DAYS; purge and queue line", async () => {
    const old = new Date(NOW.getTime() - 6 * 86400000);
    const store = fakeStore([
      row(1, { employeeId: "E1", action: "create", status: "sent", responseRef: "import:100234", finishedUtc: old }),
      row(2, { employeeId: "E2", action: "create", status: "sent", responseRef: "import:100235", finishedUtc: NOW }),
      row(3, { employeeId: "E3", action: "create", status: "sent", responseRef: "employee:9", finishedUtc: old }),
      row(4, { employeeId: "E9" })
    ]);
    const c = fakeConnector({ resolveCreated: async (p) => (p.employeeId === "E2" ? { externalId: "60001", source: "created" } : null) });
    const { r, logs: l } = await run(store, c);
    eq(r.resolved, 1); eq(store.xref.get("E2"), { externalId: "60001", source: "created" }); assert(!store.xref.has("E1"));
    assert(l.includes("ERROR [delivery] waiting: destination=clearview delivery_id=1 employee=E1 days=6 import not yet added by Payroll"), l.join("\n"));
    assert(!l.some(x => x.includes("employee=E2") && x.includes("waiting")), "a resolved import does not alert");
    assert(!l.some(x => x.includes("employee=E3")), "only import: references are pending creates");
    eq(r.purged, 3); eq(store.purged, 1);
    eq(r.queue, { pending: 0, waiting: 0, failed: 0, dead: 0, oldestPendingMinutes: null });
    assert(l.includes("[delivery] queue: destination=clearview pending=0 oldest_pending_minutes=0"), l.join("\n"));
    const busy = fakeStore([row(5)]);
    const q = await run(busy, fakeConnector({ execute: async () => { throw new Error("x"); } }));
    assert(q.logs.includes("[delivery] queue: destination=clearview pending=0 oldest_pending_minutes=0"));
    const idle = fakeStore([row(6), row(7, { employeeId: "E2", status: "dead" }), row(8, { employeeId: "E2" })]);
    const q2 = await run(idle, fakeConnector({ credentials: () => true }), ukg(), { maxPerRun: 0 });
    assert(q2.logs.includes("[delivery] queue: destination=clearview pending=2 oldest_pending_minutes=42"), q2.logs.join("\n"));
  });

  await test("runner: a second run while one is in progress is skipped; cap honoured; resolveCreated skipped without credentials", async () => {
    const store = fakeStore([row(1)], { running: true });
    const { r } = await run(store, fakeConnector());
    eq([r.status, store.runs.length], ["skipped", 0]);
    const many = fakeStore([row(1), row(2, { employeeId: "E2" }), row(3, { employeeId: "E3" })]);
    eq((await run(many, fakeConnector(), ukg(), { maxPerRun: 2 })).r.claimed, 2);
    const s2 = fakeStore([row(1, { action: "create", status: "sent", responseRef: "import:1", finishedUtc: NOW })]);
    const c = fakeConnector({ credentials: () => false });
    await run(s2, c); eq(c.resolved, [], "no Clearview calls without a key");
  });

  await test("runner: pickEmployment prefers the event's company, then the home company", () => {
    const rows = [{ employeeId: "E1", companyId: "SWNGK", isHomeCompany: false }, { employeeId: "E1", companyId: "SWN6T", isHomeCompany: true }];
    eq(pickEmployment(rows, { toCompany: "SWNGK" }).companyId, "SWNGK");
    eq(pickEmployment(rows, { toCompany: null, fromCompany: null }).companyId, "SWN6T");
    eq(pickEmployment(rows, null).companyId, "SWN6T"); eq(pickEmployment([], null), null);
    eq(pickEmployment(rows, { toCompany: "ZZZ" }).companyId, "SWN6T", "unknown company falls back to home");
  });

  // ---------------------------------------------------------------- SqlDeliveryStore ----------------------------------------------------------------
  await test("store SQL: claim applies the blocking rule, due filter, action order and TOP cap; lock uses run_type delivery", async () => {
    assert(/status = 'dead' OR \(status IN \('failed', 'waiting'\) AND next_attempt_utc > SYSUTCDATETIME\(\)\)/.test(CLAIM_SQL), "blocking rule");
    assert(/d\.status IN \('pending', 'failed', 'waiting'\)/.test(CLAIM_SQL) && /next_attempt_utc IS NULL OR d\.next_attempt_utc <= SYSUTCDATETIME\(\)/.test(CLAIM_SQL), "due filter");
    assert(/WHEN 'create' THEN 0 WHEN 'job' THEN 1 WHEN 'store' THEN 2 WHEN 'pay' THEN 3\s+WHEN 'update' THEN 4 WHEN 'terminate' THEN 5/.test(CLAIM_SQL), "action order");
    assert(/ORDER BY d\.employee_id, d\.effective_date, CASE/.test(CLAIM_SQL) && /, d\.delivery_id;$/.test(CLAIM_SQL.trim()) && /TOP \(@limit\)/.test(CLAIM_SQL), "ordering + cap");
    assert(/NOT EXISTS \(SELECT 1 FROM blocked b WHERE b\.employee_id = d\.employee_id\)/.test(CLAIM_SQL));
    for (const t of ["rpt.workforce_events", "stage.employment_current", "xref.employees", "ref.store_modes", "[out].last_sent"]) assert(CONTEXT_SQL.includes(t), `context reads ${t}`);
    assert(/response_ref LIKE 'import:%'/.test(PENDING_CREATES_SQL) && /NOT EXISTS \(SELECT 1 FROM xref\.employees/.test(PENDING_CREATES_SQL));
    assert(/DELETE TOP \(5000\) p FROM \[out\]\.shadow_payloads/.test(PURGE_SHADOW_SQL) && /DATEADD\(day, -@days/.test(PURGE_SHADOW_SQL));
    assert(/SUM\(CASE WHEN status = 'waiting'/.test(STATS_SQL) && /oldest_pending_minutes/.test(STATS_SQL));

    const pool = fakePool((text) => /INSERT INTO stage.sync_runs/.test(text) ? { recordset: [{ run_id: "RUN" }] } :
      /SELECT COUNT\(\*\) AS n FROM stage.sync_runs/.test(text) ? { recordset: [{ n: 0 }] } : { recordset: [], recordsets: [[], [], [], [], []] });
    const s = new SqlDeliveryStore(pool, "clearview");
    eq(await s.isRunning(), false); eq(await s.startRun(), "RUN");
    await s.finishRun("RUN", "succeeded", { processed: 3, calls: 2 });
    assert(/run_type = 'delivery' AND status = 'running'/.test(pool.calls[0].text) && /'delivery'/.test(pool.calls[1].text), "lock on run_type delivery");
    eq(pool.calls[2].inputs, { id: "RUN", s: "succeeded", p: 3, c: 2, err: null });
    await s.claim("clearview", 200);
    eq(pool.calls[3].text, CLAIM_SQL); eq(pool.calls[3].inputs, { destination: "clearview", limit: 200 });
  });

  await test("store SQL: mark transitions write the right statuses and never a value; context maps rows; codes map upper-cases UKG codes", async () => {
    const pool = fakePool((text) => /ref.destination_codes/.test(text) ? { recordset: [{ code_type: "store", ukg_code: "t22446", destination_code: "122446", destination_id: "2283" }, { code_type: "bogus", ukg_code: "x", destination_code: "1" }] } :
      /rpt.workforce_events/.test(text) ? { recordsets: [
        [{ event_type: "Pay change", effective_date: new Date("2026-11-01T00:00:00Z"), from_company: null, to_company: "SWN6T", from_store: null, to_store: "T22446", from_job: null, to_job: null, termination_category: null }],
        [{ employee_id: "E1", company_id: "SWNGK", employee_number: "1", is_home_company: false, employee_status: "A", org_level2: "T22446", job_code: "TM", first_name: "A", last_name: "B" },
         { employee_id: "E1", company_id: "SWN6T", employee_number: "100234", is_home_company: true, employee_status: "A", last_hire_date: "2026-01-02T00:00:00", org_level2: "T22446", job_code: "TM", first_name: "A", last_name: "B" }],
        [{ external_id: "55501", source: "extract" }], [{ mode: "LIVE" }], [{ operation: "pay", payload_hash: Buffer.alloc(32, 1) }]] } : { recordset: [] });
    const s = new SqlDeliveryStore(pool, "clearview");
    const d = mapClaimedRow({ delivery_id: "9", destination: "clearview", event_key: Buffer.alloc(32), kind: "event", employee_id: "E1", event_type: "Pay change", action: "pay", effective_date: new Date("2026-11-01T00:00:00Z"), store: "T22446", status: "pending", attempts: 0 });
    eq([d.deliveryId, d.effectiveDate, d.attempts], [9, "2026-11-01", 0]);
    const ctx = await s.loadContext(d);
    eq(ctx.storeMode, "live"); eq(ctx.employment.companyId, "SWN6T"); eq(ctx.employment.lastHireDate, "2026-01-02"); eq(ctx.xref, { externalId: "55501", source: "extract" });
    eq(ctx.event.toStore, "T22446"); eq(ctx.codes.store.get("T22446"), { destinationCode: "122446", destinationId: "2283" }); eq(ctx.codes.store.size, 1);
    assert(ctx.lastSent.get("pay").equals(Buffer.alloc(32, 1)));
    eq(mapCodeRows([]).job.size, 0);
    await s.loadContext(d); eq(pool.calls.filter(c => /ref.destination_codes/.test(c.text)).length, 1, "codes read once per run");

    const hash = payloadHash({ a: 1 });
    pool.calls.length = 0;
    await s.markUnchanged(9, hash); await s.markFailed(9, 2, NOW, `UKG ${FAKE_YEAR}`); await s.markDead(9, 5, "x"); await s.markWaiting(9, NOW, "w"); await s.markSkipped(9, "s"); await s.markReview(9, "r");
    const texts = pool.calls.map(c => c.text);
    assert(/status = 'unchanged'/.test(texts[0]) && /status = 'failed'/.test(texts[1]) && /status = 'dead'/.test(texts[2]) && /status = 'waiting'/.test(texts[3]) && /status = 'skipped'/.test(texts[4]) && /status = 'review'/.test(texts[5]));
    eq(pool.calls[1].inputs.attempts, 2); eq(pool.calls[1].inputs.next, NOW); eq(pool.calls[1].inputs.err, `UKG ${FAKE_YEAR}`);
    assert(texts.every(t => !/VALUES \(.*\d{9}/.test(t)), "no literal values in SQL");
    eq(await s.purgeShadowPayloads("clearview", 30), 0);
    eq(await s.queueStats("clearview"), { pending: 0, waiting: 0, failed: 0, dead: 0, oldestPendingMinutes: null });
    await s.upsertXref("clearview", "E1", "55501", "created");
    eq(pool.calls[pool.calls.length - 1].inputs, { destination: "clearview", employeeId: "E1", externalId: "55501", source: "created" });
  });

  await test("canonicalJson / payloadHash: deterministic", () => {
    eq(canonicalJson({ z: [3, { b: 2, a: 1 }], a: "x" }), '{"a":"x","z":[3,{"a":1,"b":2}]}');
    assert(payloadHash({ a: 1, b: 2 }).equals(payloadHash({ b: 2, a: 1 })));
    assert(!payloadHash({ a: 1 }).equals(payloadHash({ a: 2 })));
  });

  report("delivery runner");
};
