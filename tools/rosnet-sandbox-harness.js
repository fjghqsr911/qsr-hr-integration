/*
  Rosnet sandbox harness: runs the REAL connector (dist/src/shared/rosnet) against the Rosnet SANDBOX with the one
  synthetic employee, so the code that will run in Azure is proven end to end before production credentials exist.
  It never touches the hub database or UKG: delivery contexts are built here from made-up values.

  Safety: the API and token hosts must be rosnetqa.com (or localhost, for the local mock); the employee must be the
  synthetic one (POS UID HUBTEST..., payroll id 9990.....). Dry run unless --write: the plans are printed, masked.

  Lifecycle (--write), each step followed by a wait until Aloha shows the result (HR Bridge is asynchronous):
    1 hire at location 1          -> the connector decides: add, or rehire when a terminated profile is there
    2 pay change                  -> modifyJob
    3 job change (CM -> SS)       -> addJob 200, removeJob 1
    4 store transfer 1 -> 2       -> transferEmployee, or rehire at 2 + terminate at 1 when a profile exists at 2
    5 leave of absence at 2       -> terminateEmployee (code 3)
    6 repeat of step 5            -> nothing sent (already terminated)
    7 rehire at location 3        -> no profile there (terminated at 2): addEmployee. rehireEmployee "into a different
                                     location" answered 200 and did nothing here on 2026-11-17 (this step, first run), so the
                                     connector no longer sends it. --loc3 0 skips steps 7 and 8; --from 7 runs only those two.
                                     Once location 3 holds a profile, step 7 becomes a rehire in place.
    8 termination at location 3   -> terminateEmployee (code 20)
  End state: terminated at every location used.

  Usage (from hrint-api, after npm run build):
    node tools/rosnet-sandbox-harness.js                 dry run
    node tools/rosnet-sandbox-harness.js --write         executes against the sandbox
  The client secret is read from ROSNET_CLIENT_SECRET, or asked for with hidden input. Options (defaults in brackets):
    --base https://wfmt-api.rosnetqa.com  --token https://iam.rosnetqa.com/connect/token  --client wfm.QUICKWEN.Rosnet
    --uid HUBTESTHESWX  --payroll 999055957  --loc1 6000  --loc2 6010  --loc3 6018  --wait 180  --from 1
*/
const path = require("path");
const readline = require("readline");

const DIST = path.join(__dirname, "..", "dist", "src", "shared");
const { RosnetClient, nodeTransport } = require(path.join(DIST, "rosnet", "client.js"));
const { RosnetConnector } = require(path.join(DIST, "rosnet", "connector.js"));
const { DEFAULT_ROSNET_CONFIG } = require(path.join(DIST, "rosnet", "mapper.js"));
const { codeKey, DeliveryError } = require(path.join(DIST, "delivery.js"));

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const WRITE = args.includes("--write");
const BASE = opt("base", "https://wfmt-api.rosnetqa.com"), TOKEN = opt("token", "https://iam.rosnetqa.com/connect/token");
const CLIENT_ID = opt("client", "wfm.QUICKWEN.Rosnet");
const UID = opt("uid", "HUBTESTHESWX"), PAYROLL = opt("payroll", "999055957");
const LOC1 = Number(opt("loc1", "6000")), LOC2 = Number(opt("loc2", "6010")), LOC3 = Number(opt("loc3", "6018")), WAIT = Number(opt("wait", "180")), FROM = Number(opt("from", "1"));

const sandboxHost = u => { try { const h = new URL(u).hostname.toLowerCase(); return h === "localhost" || h === "rosnetqa.com" || h.endsWith(".rosnetqa.com"); } catch { return false; } };
if (!sandboxHost(BASE) || !sandboxHost(TOKEN)) { console.error("Refusing to run: --base and --token must be rosnetqa.com hosts."); process.exit(2); }
if (!/^HUBTEST[A-Z0-9]{1,13}$/.test(UID) || !/^9990\d{5}$/.test(PAYROLL)) { console.error("Refusing to run: only the synthetic employee (UID HUBTEST..., payroll id 9990.....)."); process.exit(2); }

function promptHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question + String.fromCharCode(10));                // own line: readline clears the line it starts on
    rl._writeToOutput = () => {};                       // nothing typed is echoed
    rl.question("", v => { rl.close(); process.stdout.write("\n"); resolve(v.trim()); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = n => `W0${n}`;

function codes() {
  const m = pairs => new Map(Object.entries(pairs).map(([k, v]) => [codeKey("", k), { ukgCode: k, company: "", destinationCode: String(v), destinationId: null }]));
  return { store: m({ [store(LOC1)]: LOC1, [store(LOC2)]: LOC2, ...(LOC3 ? { [store(LOC3)]: LOC3 } : {}) }), job: m({ CM: 1, SS: 200 }),
           termination: m({ Voluntary: 20, Leave: 3, Transfer: 100, Default: 1 }), category: new Map(), company: new Map() };
}
const today = new Date().toISOString().slice(0, 10);
function ctx(action, eventType, over = {}) {
  const delivery = { deliveryId: 1, destination: "rosnet", employeeId: UID, eventKey: null, kind: "event", status: "pending", attempts: 0, eventType, action, effectiveDate: today, store: store(LOC1), ...(over.delivery ?? {}) };
  const event = { eventType, effectiveDate: today, fromCompany: null, toCompany: null, fromStore: null, toStore: null, fromJob: null, toJob: null, terminationCategory: null, ...(over.event ?? {}) };
  const employment = { employeeId: UID, companyId: "SWN1U", employeeNumber: PAYROLL, isHomeCompany: true, employeeStatus: "A", originalHireDate: today, lastHireDate: today, terminationDate: null,
                       orgLevel2: store(LOC1), jobCode: "CM", fullOrPartTime: "P", firstName: "ZZTEST", preferredName: null, lastName: "HUBCONNECTOR", ...(over.employment ?? {}) };
  return { delivery, event, employment, xref: { externalId: UID, source: "matched", payrollId: PAYROLL }, codes: codes(), storeMode: "live", lastSent: new Map() };
}
const sensitive = rate => ({ sin: null, dateOfBirth: "1990-01-15", email: "zztest.hubconnector@example.com", salaryOrHourly: "H", hourlyPayRate: rate, annualSalary: null });

(async () => {
  console.log(`\n################ Rosnet sandbox harness ################\nAPI   ${BASE}\nToken ${TOKEN}`);
  console.log(WRITE ? "MODE: --write: the real connector WILL write to the sandbox (one synthetic employee)." : "MODE: dry run: plans only. Add --write to execute.");
  console.log(`Synthetic employee: ZZTEST HUBCONNECTOR  UID=${UID}  payroll id=${PAYROLL}  locations ${LOC1}, ${LOC2}${LOC3 ? ` and ${LOC3}` : ""}`);

  // every HTTP call the connector makes, as method + route + status + time (synthetic ids only; never a body)
  const transport = async req => {
    const started = Date.now();
    const res = await nodeTransport(req);
    const u = new URL(req.url);
    if (u.pathname.startsWith("/api/")) console.log(`      ${req.method.padEnd(4)} ${u.pathname.replace(/^\/api\/v[^/]+/, "")} -> ${res.status} (${Date.now() - started} ms)`);
    return res;
  };
  const steps = [
    { name: "1 hire at location 1", ctx: ctx("create", "Rehire", { event: { toStore: store(LOC1) } }), rate: 17.0, expect: [LOC1, e => e && e.active && e.jobs.length > 0, `active with a job at ${LOC1}`] },
    { name: "2 pay change", ctx: ctx("pay", "Pay change"), rate: 17.75 },
    { name: "3 job change CM -> SS", ctx: ctx("job", "Promotion", { event: { fromJob: "CM", toJob: "SS" }, employment: { jobCode: "SS" } }), rate: 17.75, expect: [LOC1, e => e && e.jobs.includes(200) && !e.jobs.includes(1), `job 200 only at ${LOC1}`] },
    { name: "4 store transfer 1 -> 2", ctx: ctx("store", "Store transfer", { delivery: { store: store(LOC2) }, event: { fromStore: store(LOC1), toStore: store(LOC2) }, employment: { orgLevel2: store(LOC2), jobCode: "SS" } }), rate: 17.75,
      expect: [LOC2, e => e && e.active && e.jobs.length > 0, `active with a job at ${LOC2}`], expect2: [LOC1, e => e && !e.active, `terminated at ${LOC1}`] },
    { name: "5 leave of absence at location 2", ctx: ctx("terminate", "Leave of absence", { delivery: { store: store(LOC2) }, employment: { orgLevel2: store(LOC2), jobCode: "SS" } }), rate: 17.75, expect: [LOC2, e => e && !e.active, `terminated at ${LOC2}`] },
    { name: "6 the same leave again", ctx: ctx("terminate", "Leave of absence", { delivery: { store: store(LOC2) }, employment: { orgLevel2: store(LOC2), jobCode: "SS" } }), rate: 17.75 },
    ...(LOC3 ? [
    { name: `7 rehire at location 3 (${LOC3}), coming from ${LOC2}`, ctx: ctx("create", "Rehire", { delivery: { store: store(LOC3) }, event: { fromStore: store(LOC2), toStore: store(LOC3) }, employment: { orgLevel2: store(LOC3), jobCode: "SS" } }), rate: 17.75,
      expect: [LOC3, e => e && e.active && e.jobs.length > 0, `active with a job at ${LOC3}`] },
    { name: "8 termination at location 3", ctx: ctx("terminate", "Termination", { delivery: { store: store(LOC3) }, event: { terminationCategory: "Voluntary" }, employment: { orgLevel2: store(LOC3), jobCode: "SS" } }), rate: 17.75,
      expect: [LOC3, e => e && !e.active, `terminated at ${LOC3}`] }
    ] : [])
  ].filter((_, i) => i + 1 >= FROM);
  if (FROM > 1) console.log(`Starting at step ${FROM}: the earlier steps are skipped.`);

  if (!WRITE) {
    const connector = new RosnetConnector(new RosnetClient({ baseUrl: BASE, apiVersion: "1.0", credential: null, timeoutMs: 90000 }), DEFAULT_ROSNET_CONFIG);
    for (const s of steps) {
      const o = connector.plan(s.ctx, sensitive(s.rate));
      console.log(`\n[${s.name}] ${o.decision}${o.decision === "send" ? `: operation ${o.plan.operation}` : `: ${o.reason}`}`);
      if (o.decision === "send") for (const st of connector.redactForStore(o.plan.steps)) console.log(`      ${st.method.padEnd(4)} ${st.path}${st.note ? `   (${st.note})` : ""}`);
    }
    console.log("\nNothing was sent. Add --write to run these through the connector against the sandbox.");
    return;
  }

  const secret = process.env.ROSNET_CLIENT_SECRET || await promptHidden("Paste the Rosnet SANDBOX client secret (input is hidden): ");
  if (!secret) { console.error("No secret given."); process.exit(1); }
  const client = new RosnetClient({ baseUrl: BASE, apiVersion: "1.0", timeoutMs: 90000, transport, allowSandboxWrites: true,
                                    credential: { tokenUrl: TOKEN, scope: "wfm.write", clientId: CLIENT_ID, clientSecret: secret } });
  const connector = new RosnetConnector(client, DEFAULT_ROSNET_CONFIG, m => console.log(`      log: ${m}`));
  const waitFor = async ([loc, test, what]) => {
    const started = Date.now();
    for (;;) {
      const e = await client.employee(UID, loc);
      if (test(e)) { console.log(`      Aloha shows ${what} after ${Math.round((Date.now() - started) / 1000)} s (POS number ${e ? e.posId : "-"}, jobs ${e ? e.jobs.join("+") || "none" : "-"})`); return true; }
      if (Date.now() - started > WAIT * 1000) { console.log(`      Aloha does NOT show ${what} within ${WAIT} s`); return false; }
      await sleep(6000);
    }
  };

  let failed = 0;
  for (const s of steps) {
    console.log(`\n[${s.name}]`);
    try {
      const o = connector.plan(s.ctx, sensitive(s.rate));
      if (o.decision !== "send") { console.log(`   ${o.decision}: ${o.reason}`); failed++; continue; }
      const r = await connector.execute(o.plan, s.ctx);
      console.log(`   sent: ${r.responseRef}${r.warning ? `   note: ${r.warning}` : ""}`);
      if (s.expect && !(await waitFor(s.expect))) { failed++; console.log("   stopping: the next step needs this one to have landed."); break; }
      if (s.expect2) await waitFor(s.expect2);
    } catch (e) {
      failed++;
      console.log(`   FAILED (${e instanceof DeliveryError ? e.kind : "error"}): ${e.message}`);
      if (e instanceof DeliveryError && e.kind === "abort") break;
    }
  }
  console.log(failed ? `\n${failed} step(s) did not complete. Send Rosnet the UID ${UID} and the time of this run if HR Bridge needs checking.` : "\nAll steps completed through the real connector.");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(`harness failed: ${e.message}`); process.exit(1); });
