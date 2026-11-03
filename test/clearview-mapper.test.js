/* Clearview mapper (pure): one fixture per operation, exact payloads, $lookup placeholders, masks, hash rules, scope rules. */
const path = require("path");
const fs = require("fs");
const { DIST, FAKE_YEAR, test, report, assert, eq, noYear } = require("./helpers");

const FIXTURES = path.join(__dirname, "fixtures", "clearview");
const SIN = "123456789";

/** Code maps every fixture shares: Clearview store numbers / ids, organization job codes / ids, one termination reason. */
function codes() {
  const m = (pairs) => new Map(Object.entries(pairs).map(([k, [destinationCode, destinationId]]) => [k, { destinationCode, destinationId }]));
  return {
    store: m({ T22446: ["122446", "2283"], T02462: ["2462", "18"] }),
    job: m({ TM: ["1", "9441"], SH: ["10", "9444"], AM: ["4", "9442"], GM: ["4", "9442"] }),
    termination: m({ VOLUNTARY: ["13078", "13078"] }),
    category: new Map(), company: m({ SWN6T: ["18", null], SWNGK: ["1690", null] })
  };
}

function ctxFrom(f, over = {}) {
  const delivery = { deliveryId: 1, destination: "clearview", employeeId: "EWLTH200NRY0", eventKey: null, kind: "event", status: "pending", attempts: 0, ...f.delivery, ...(over.delivery ?? {}) };
  const event = f.event === null ? null : { eventType: delivery.eventType, effectiveDate: delivery.effectiveDate, fromCompany: null, toCompany: null, fromStore: null, toStore: null, fromJob: null, toJob: null, terminationCategory: null, ...f.event, ...(over.event ?? {}) };
  const employment = f.employment === null ? null : { employeeId: "EWLTH200NRY0", companyId: "SWN6T", employeeNumber: "100234", isHomeCompany: true, employeeStatus: "A", originalHireDate: null, lastHireDate: null, terminationDate: null, orgLevel2: "T22446", jobCode: "TM", fullOrPartTime: "P", firstName: "Ann", preferredName: null, lastName: "Example", ...f.employment, ...(over.employment ?? {}) };
  return { delivery, event, employment, xref: "xref" in over ? over.xref : f.xref, codes: over.codes ?? codes(), storeMode: "shadow", lastSent: new Map() };
}

module.exports = async () => {
  const { plan, redactForHash, redactForStore, hashPayload, sensitiveNeeds, dayBefore, DOB_MASK, SIN_MASK, PAY_MASK } = require(path.join(DIST, "shared", "clearview", "mapper.js"));
  const { MappingError, canonicalJson, payloadHash } = require(path.join(DIST, "shared", "delivery.js"));
  const fixtures = fs.readdirSync(FIXTURES).filter(n => n.endsWith(".json")).map(n => ({ file: n, ...JSON.parse(fs.readFileSync(path.join(FIXTURES, n), "utf8")) }));
  const byOp = Object.fromEntries(fixtures.map(f => [f.expected.operation, f]));
  const same = (a, b, msg) => eq(canonicalJson(a), canonicalJson(b), msg);

  for (const f of fixtures) {
    await test(`mapper fixture ${f.file}: ${f.name}`, () => {
      const out = plan(ctxFrom(f), f.sensitive);
      eq(out.decision, "send", `decision (${out.reason ?? ""})`);
      eq(out.plan.operation, f.expected.operation);
      same(out.plan.payload, f.expected.payload, "payload");
      eq(out.plan.steps.map(s => s.method), f.expected.stepMethods, "call sequence");
      eq(out.plan.steps[out.plan.steps.length - 1].path, f.expected.lastStepPath, "last step path");
      for (const s of out.plan.steps) assert(/^\/[a-zA-Z]/.test(s.path) && !/undefined|null/.test(s.path), `step path ${s.path}`);
    });
  }

  await test("mapper: $lookup placeholders stand in for everything Clearview must supply (shadow never guesses ids)", () => {
    const store = plan(ctxFrom(byOp.store), byOp.store.sensitive).plan;
    eq(store.payload.endPrevious.assignmentId, "$lookup:previousAssignmentId");
    const job = plan(ctxFrom(byOp.job), byOp.job.sensitive).plan;
    eq([job.payload.add.payRate, job.payload.demote.jobId], ["$lookup:currentPrimaryRate", "$lookup:primaryJobId"]);
    const term = plan(ctxFrom(byOp.terminate), byOp.terminate.sensitive).plan;   // no xref: the employee id itself is a lookup
    assert(term.steps.every(s => s.path.includes("$lookup:employeeId")), "terminate without xref uses the employeeId placeholder");
    const withXref = plan(ctxFrom(byOp.terminate, { xref: { externalId: "777", source: "matched" } }), byOp.terminate.sensitive).plan;
    assert(withXref.steps.every(s => s.path.includes("/777")), "with an xref the Clearview id is used");
  });

  await test("mapper: import vs rehire is decided by xref presence, not by event type", () => {
    const f = byOp.import;
    eq(plan(ctxFrom(f), f.sensitive).plan.operation, "import");
    const rehireSensitive = { ...f.sensitive };
    eq(plan(ctxFrom(f, { xref: { externalId: "55501", source: "extract" } }), rehireSensitive).plan.operation, "rehire", "a New hire Clearview already has is a rehire");
    const r = byOp.rehire;
    eq(plan(ctxFrom(r, { xref: null, employment: { terminationDate: null } }), { ...r.sensitive, sin: SIN, dateOfBirth: `${FAKE_YEAR}-07-14` }).plan.operation, "import", "a Rehire Clearview never had is an import");
    eq(sensitiveNeeds(ctxFrom(f)), ["person", "pay"]); eq(sensitiveNeeds(ctxFrom(r)), ["pay"]);
    eq(sensitiveNeeds(ctxFrom(byOp.pay)), ["pay"]); eq(sensitiveNeeds(ctxFrom(byOp.terminate)), []);
  });

  await test("mapper: masks - stored copy hides DOB, SIN and pay; hash copy keeps pay", () => {
    const f = byOp.import;
    const p = plan(ctxFrom(f), f.sensitive).plan;
    const stored = redactForStore(p.payload), hashed = redactForHash(p.payload);
    eq(stored.standardInformation.birthDate, DOB_MASK); eq(stored.payAndBenefitInformation.sin, SIN_MASK); eq(stored.jobAndPayInformation.payRate, PAY_MASK);
    eq(hashed.standardInformation.birthDate, DOB_MASK); eq(hashed.payAndBenefitInformation.sin, SIN_MASK); eq(hashed.jobAndPayInformation.payRate, 17.5);
    const text = JSON.stringify(stored);
    noYear(text, "stored shadow payload"); assert(!text.includes(SIN) && !text.includes("456789"), "SIN digits in stored copy");
    noYear(JSON.stringify(hashed), "hash input"); assert(!JSON.stringify(hashed).includes(SIN), "SIN digits in hash input");
    const steps = redactForStore(p.steps);
    noYear(JSON.stringify(steps), "stored steps"); assert(!JSON.stringify(steps).includes(SIN), "SIN in stored steps");
    eq(stored.standardInformation.firstName, "Ann", "names are not masked");
  });

  await test("mapper: hash stable across key order, changes with pay, not with SIN or DOB", () => {
    const f = byOp.import;
    const base = plan(ctxFrom(f), f.sensitive).plan.payload;
    const reverse = (v) => Array.isArray(v) ? v.map(reverse) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map(k => [k, reverse(v[k])])) : v;
    const reordered = reverse(base);
    assert(JSON.stringify(reordered) !== JSON.stringify(base), "the reordered copy differs textually");
    assert(hashPayload(base).equals(payloadHash(redactForHash(reordered))), "key order must not matter");
    const otherSin = plan(ctxFrom(f), { ...f.sensitive, sin: "987654321" }).plan.payload;
    assert(hashPayload(base).equals(hashPayload(otherSin)), "SIN must not affect the hash");
    const otherDob = plan(ctxFrom(f), { ...f.sensitive, dateOfBirth: "1990-01-01" }).plan.payload;
    assert(hashPayload(base).equals(hashPayload(otherDob)), "DOB must not affect the hash");
    const otherPay = plan(ctxFrom(f), { ...f.sensitive, hourlyPayRate: 18 }).plan.payload;
    assert(!hashPayload(base).equals(hashPayload(otherPay)), "a rate change must change the hash");
    eq(canonicalJson({ b: 1, a: null, c: { z: undefined, y: [null, 2] } }), '{"b":1,"c":{"y":[null,2]}}', "nulls dropped, keys sorted");
    eq(hashPayload(base).length, 32);
  });

  await test("mapper: unmapped store / job code -> MappingError (dead), never a default", () => {
    const f = byOp.import;
    const noJob = codes(); noJob.job.delete("TM");
    let err = null; try { plan(ctxFrom(f, { codes: noJob }), f.sensitive); } catch (e) { err = e; }
    assert(err instanceof MappingError, "MappingError expected"); eq(err.message, "no clearview job code for UKG job TM");
    const noStore = codes(); noStore.store.delete("T22446");
    err = null; try { plan(ctxFrom(f, { codes: noStore }), f.sensitive); } catch (e) { err = e; }
    assert(err instanceof MappingError && /no clearview store for UKG store T22446/.test(err.message), err && err.message);
    const t = byOp.terminate;                                                     // termination reason: default allowed
    eq(plan(ctxFrom(t), t.sensitive).plan.payload.terminationReasonId, 13078);
    eq(plan(ctxFrom(t, { event: { terminationCategory: "Voluntary" } }), t.sensitive).plan.payload.terminationReasonId, 13078);
    const mapped = codes(); mapped.termination.set("INVOLUNTARY", { destinationCode: "13090", destinationId: "13090" });
    eq(plan(ctxFrom(t, { codes: mapped }), t.sensitive).plan.payload.terminationReasonId, 13090, "a mapped category overrides the default");
  });

  await test("mapper: validation - SIN 9 digits, DOB present, rate > 0, hire date after the previous termination", () => {
    const f = byOp.import;
    const fails = (sensitive, over, re) => {
      let err = null; try { plan(ctxFrom(f, over), sensitive); } catch (e) { err = e; }
      assert(err instanceof MappingError && re.test(err.message), `expected ${re}, got ${err && err.message}`);
      assert(!err.message.includes(SIN) && !err.message.includes(FAKE_YEAR), "error text must not carry values");
    };
    fails({ ...f.sensitive, sin: "12345" }, {}, /SIN missing or not 9 digits/);
    fails({ ...f.sensitive, sin: null }, {}, /SIN missing/);
    fails({ ...f.sensitive, dateOfBirth: null }, {}, /date of birth missing/);
    fails({ ...f.sensitive, hourlyPayRate: 0 }, {}, /pay rate missing or not above zero/);
    fails({ ...f.sensitive, salaryOrHourly: "S", annualSalary: null }, {}, /annual salary/);
    fails(f.sensitive, { employment: { terminationDate: "2026-11-05" } }, /hire date 2026-11-05 is not after the previous termination/);
    fails(f.sensitive, { employment: { terminationDate: "2026-12-01" } }, /not after the previous termination/);
    eq(plan(ctxFrom(f, { employment: { terminationDate: "2026-11-04" } }), f.sensitive).decision, "send", "a termination before the hire date is fine");
    const p = byOp.pay;
    let err = null; try { plan(ctxFrom(p), { ...p.sensitive, hourlyPayRate: -1 }); } catch (e) { err = e; }
    assert(err instanceof MappingError, "pay rate <= 0 on a pay change");
  });

  await test("mapper: scope - companies outside CLEARVIEW_COMPANIES (M9WOJ -> review, others skipped), OPS and excluded jobs skipped", () => {
    const f = byOp.pay;
    eq(plan(ctxFrom(f, { event: { toCompany: "M9WOJ" } }), f.sensitive), { decision: "review", reason: "HR to handle: company M9WOJ is not sent to Clearview" });
    eq(plan(ctxFrom(f, { event: { toCompany: "ZZZ1" } }), f.sensitive), { decision: "skipped", reason: "company ZZZ1 is not sent to Clearview" });
    eq(plan(ctxFrom(f, { event: { toCompany: null }, employment: { companyId: "M9WOJ" } }), f.sensitive).decision, "review", "falls back to the employment company");
    eq(plan(ctxFrom(f, { employment: { orgLevel2: "OPS" } }), f.sensitive), { decision: "skipped", reason: "org_level2 OPS is not sent to Clearview" });
    eq(plan(ctxFrom(f, { employment: { jobCode: "MM" } }), f.sensitive), { decision: "skipped", reason: "UKG job MM is not sent to Clearview" });
    const j = byOp.job;
    eq(plan(ctxFrom(j, { event: { toJob: "MM" } }), j.sensitive).decision, "skipped", "promotion into an excluded job");
    const s = byOp.store;
    eq(plan(ctxFrom(s, { event: { toStore: "OPS" } }), s.sensitive), { decision: "review", reason: "transfer to OPS is not a store transfer" });
    eq(plan(ctxFrom(s, { event: { toStore: "FIN" } }), s.sensitive).decision, "review");
    eq(plan(ctxFrom(f), f.sensitive, { companies: ["SWNGK"], excludedJobs: [], terminationReasonId: 1 }).decision, "skipped", "config drives the company list");
    eq(plan(ctxFrom(f, { employment: { jobCode: "MM" } }), f.sensitive, { companies: ["SWN6T"], excludedJobs: [], terminationReasonId: 1 }).decision, "send", "config drives the excluded jobs");
  });

  await test("mapper: store action - temporary transfer adds an assignment without ending the old one; update FT/PT from the event", () => {
    const s = byOp.store;
    const temp = plan(ctxFrom(s, { delivery: { eventType: "Temporary transfer" }, event: { eventType: "Temporary transfer" } }), s.sensitive).plan;
    eq(temp.payload.endPrevious, null); eq(temp.payload.reportingStoreId, null); eq(temp.steps.map(x => x.method), ["GET", "POST"]);
    eq(dayBefore("2026-03-01"), "2026-02-28"); eq(dayBefore("2026-01-01"), "2025-12-31");
    const u = byOp.update;
    eq(plan(ctxFrom(u, { delivery: { eventType: "Full-time to part-time" }, event: { eventType: "Full-time to part-time" }, employment: { fullOrPartTime: "P" } }), u.sensitive).plan.payload[0].value, "PartTime");
  });

  report("clearview mapper");
};
