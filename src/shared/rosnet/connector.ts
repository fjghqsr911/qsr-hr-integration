import { Connector, DeliveryContext, DeliveryError, ExecuteResult, Plan, Sensitive, SensitiveNeed, XrefIds } from "../delivery";
import { CfcEmployee, ROSNET_CODES, RosnetClient, RosnetError } from "./client";
import { DEFAULT_ROSNET_CONFIG, HirePayload, Ident, JobPayload, PayPayload, RosnetMapperConfig, TerminatePayload, TransferPayload,
         addBody, emailBody, jobBody, plan as planFor, redactForHash, redactForStore, rehireBody, sensitiveNeeds, terminateBody, transferBody } from "./mapper";

/*
  Executes a mapper Plan against Rosnet EDT. Every operation starts with a GET of the employee at the location (the
  Aloha CFC record), because that state decides the call and makes a repeat safe:
    hire       active here -> nothing; terminated profile here -> rehire in place; no profile here -> add, also when a
               terminated profile exists at another store (rehireEmployee "into a different location" answers 200 and
               does nothing: sandbox, three attempts 2026-11-17, so it is never sent)
    terminate  already terminated -> nothing; no profile -> retry (it may not have landed yet), dead after the schedule
    transfer   active at the new location -> only close the old one; terminated profile at the new one -> rehire there
               and close the old one; active at the old one -> transferEmployee; otherwise place at the new location
    job        addJob when the new code is missing, then removeJob when the old code is still on file
    pay        modifyJob unless POST /PayRate already shows the rate

  HR Bridge applies writes asynchronously (seconds to a minute), so nothing is verified by reading back; a repeat that
  Rosnet refuses as "already exists" (2500) or "already active" (2000) counts as done.
  Failures: 401 / 403 / Cloudflare challenge -> abort the run (rows untouched); 400 / 404 -> dead with Rosnet's message;
  network / timeout / 429 / 5xx -> retry. Log lines carry ids, locations and Rosnet's messages only.
*/

export function classify(e: any): DeliveryError {
  if (e instanceof DeliveryError) return e;
  if (e instanceof RosnetError) {
    if (e.challenge || e.status === 401 || e.status === 403) return new DeliveryError("abort", e.message);
    if (e.status === 400 || e.status === 404 || e.status === 422) return new DeliveryError("dead", e.message);
    return new DeliveryError("retry", e.message);
  }
  return new DeliveryError("retry", String(e?.message ?? "error"));
}

const hasCode = (e: unknown, code: number) => e instanceof RosnetError && e.status === 400 && e.code === code;
const cents = (n: number) => Math.round(n * 100);

const EMAIL_READS = 6;                  // looks at the new store before giving up on the email (a read takes 3-6 s)
const EMAIL_PAUSE_MS = 3000;

export class RosnetConnector implements Connector {
  readonly destination = "rosnet";
  constructor(private client: RosnetClient, private cfg: RosnetMapperConfig = DEFAULT_ROSNET_CONFIG, private log: (m: string) => void = () => {},
              private now: () => Date = () => new Date(), private sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {}

  hasCredentials(_companyId: string | null): boolean { return this.client.hasCredentials(); }
  sensitiveNeeds(ctx: DeliveryContext): SensitiveNeed[] { return sensitiveNeeds(ctx); }
  plan(ctx: DeliveryContext, sensitive: Sensitive) { return planFor(ctx, sensitive, this.cfg); }
  redactForHash(payload: unknown) { return redactForHash(payload); }
  redactForStore(payload: unknown) { return redactForStore(payload); }

  /** Before a create without an xref: is the employee already at a Rosnet location (the previous integration created
   *  them, or an earlier attempt landed)? Looks at the store the hub has them in. */
  async resolveExisting(ctx: DeliveryContext): Promise<({ externalId: string; source: "matched" } & XrefIds) | null> {
    const emp = ctx.employment, ev = ctx.event;
    if (!emp) return null;
    const company = (ev?.toCompany ?? emp.companyId ?? "").toUpperCase();
    const store = [ev?.toStore, ctx.delivery.store, emp.orgLevel2].map(s => (s ?? "").toUpperCase()).find(s => /^W\d{5}$/.test(s));
    const row = store ? ctx.codes.store.get(`${company}|${store}`) ?? ctx.codes.store.get(`|${store}`) : undefined;
    const loc = Number(row?.destinationCode);
    if (!Number.isInteger(loc)) return null;
    try {
      const firstName = (emp.firstName ?? "").replace(/['’‘`´]/g, "").trim(), lastName = (emp.lastName ?? "").replace(/['’‘`´]/g, "").trim();
      const found = await this.find({ posProvider_EmployeeUID: emp.employeeId, payrollProvider_EmployeeUID: (emp.employeeNumber ?? "").trim(), firstName, lastName }, loc, true);
      return found ? { externalId: found.uid, source: "matched", payrollId: found.payrollId, posId: found.posId } : null;
    } catch (e) { throw classify(e); }
  }

  async execute(plan: Plan, ctx: DeliveryContext): Promise<ExecuteResult> {
    try {
      switch (plan.operation) {
        case "hire": return await this.hire(plan.payload as HirePayload, ctx);
        case "terminate": return await this.terminate(plan.payload as TerminatePayload, ctx);
        case "transfer": return await this.transfer(plan.payload as TransferPayload, ctx);
        case "job": return await this.job(plan.payload as JobPayload, ctx);
        case "pay": return await this.pay(plan.payload as PayPayload, ctx);
        default: throw new DeliveryError("dead", `unsupported operation ${plan.operation}`);
      }
    } catch (e) { throw classify(e); }
  }

  // ---------------------------------------------------------------- helpers ----------------------------------------------------------------
  private stamp(): string { return this.now().toISOString().slice(0, 19); }

  /** The profile at a location: by POS UID, else (only while the hub has no xref) by name + payroll id, which finds an
   *  employee the previous integration created under another UID. */
  private async find(p: Ident, location: number, byName: boolean): Promise<CfcEmployee | null> {
    const direct = await this.client.employee(p.posProvider_EmployeeUID, location);
    if (direct || !byName || !p.firstName || !p.lastName || !p.payrollProvider_EmployeeUID) return direct;
    const same = (await this.client.employeesByName(p.firstName, p.lastName, location)).filter(e => e.payrollId === p.payrollProvider_EmployeeUID);
    if (same.length !== 1) return null;
    this.log(`rosnet location ${location}: employee found by name and payroll id under another POS UID; that UID is used from now on`);
    return same[0];
  }
  private xref(e: CfcEmployee | null, uid: string, payrollId: string, source: "created" | "matched"): ExecuteResult["xref"] {
    return { externalId: e?.uid ?? uid, source, payrollId: e?.payrollId ?? payrollId, posId: e?.posId ?? null };
  }
  /** A write Rosnet refuses with `code` because the state is already there counts as done. */
  private async writeUnless(code: number, method: "POST" | "PUT", route: string, body: unknown): Promise<boolean> {
    try { await this.client.write(method, route, body); return true; }
    catch (e) { if (hasCode(e, code)) return false; throw e; }
  }
  /** transferEmployee does not carry the email, and updateEmployeeInfo is refused (400) until Aloha holds the new profile,
   *  seconds after the transfer: wait for it, then set it. Best effort: a miss is a warning, never a failure. */
  private async setEmail(p: Ident & { clientCode: string; emailId: string | null }, location: number, uid: string): Promise<string | null> {
    if (!p.emailId) return null;
    try {
      for (let read = 1; !(await this.client.employee(uid, location)); read++) {
        if (read >= EMAIL_READS) return "email not set at the new location (the profile was not in Aloha yet)";
        await this.sleep(EMAIL_PAUSE_MS);
      }
      await this.client.write("PUT", "/Employee/updateEmployeeInfo", emailBody(p, location, p.emailId, this.stamp(), uid));
      return null;
    } catch (e: any) { return "email not set at the new location"; }
  }
  private static join(...notes: (string | null | undefined | false)[]): string | undefined { const n = notes.filter(Boolean); return n.length ? n.join("; ") : undefined; }

  // ---------------------------------------------------------------- operations ----------------------------------------------------------------
  private async hire(p: HirePayload, ctx: DeliveryContext): Promise<ExecuteResult> {
    const loc = p.locationNumber;
    const here = await this.find(p, loc, !ctx.xref);
    const uid = here?.uid ?? p.posProvider_EmployeeUID;
    if (here?.active) return { responseRef: `employee:${loc}`, warning: "already active at this location in Rosnet; nothing sent", xref: this.xref(here, uid, p.payrollProvider_EmployeeUID, "matched") };
    if (here) {                                                             // terminated profile at this location: rehire in place
      const sent = await this.writeUnless(ROSNET_CODES.alreadyActive, "POST", "/Employee/rehireEmployee", rehireBody(p, loc, this.stamp(), uid));
      return { responseRef: `rehire:${loc}`, warning: sent ? undefined : "Rosnet reports the employee already active", xref: this.xref(here, uid, p.payrollProvider_EmployeeUID, "matched") };
    }
    // no profile here: add, whatever other stores hold (a terminated profile elsewhere stays as it is)
    const added = await this.writeUnless(ROSNET_CODES.alreadyExists, "POST", "/Employee/addEmployee", addBody(p, this.stamp(), uid));
    return { responseRef: `add:${loc}`, warning: added ? undefined : "Rosnet reports the employee already exists at this location",
             xref: { externalId: uid, source: "created", payrollId: p.payrollProvider_EmployeeUID } };
  }

  private async terminate(p: TerminatePayload, ctx: DeliveryContext): Promise<ExecuteResult> {
    const loc = p.locationNumber;
    const here = await this.find(p, loc, !ctx.xref);
    if (!here) throw new DeliveryError("retry", `employee has no profile at Rosnet location ${loc} (not sent yet, still being processed, or created under another id)`);
    const xref = this.xref(here, here.uid, p.payrollProvider_EmployeeUID, "matched");
    if (!here.active) return { responseRef: `terminate:${loc}`, warning: `already terminated in Rosnet${here.lastDay ? ` (last day ${here.lastDay})` : ""}; nothing sent`, xref };
    await this.client.write("PUT", "/Employee/terminateEmployee", terminateBody(p, loc, p.terminationEffectiveDate, p.employeeTerminationCode, here.uid));
    return { responseRef: `terminate:${loc}`, xref };
  }

  private async transfer(p: TransferPayload, ctx: DeliveryContext): Promise<ExecuteResult> {
    const to = p.newLocationNumber, from = p.originalLocationNumber;
    const old = from === null ? null : await this.find(p, from, !ctx.xref);
    const uid = old?.uid ?? p.posProvider_EmployeeUID;
    const target = await this.client.employee(uid, to);
    const closeOld = async (): Promise<boolean> => {
      if (from === null || !old?.active) return false;
      await this.client.write("PUT", "/Employee/terminateEmployee", terminateBody(p, from, p.eventEffectiveDate, p.employeeTerminationCode, uid));
      return true;
    };

    if (target?.active) {                                                   // already there (an earlier attempt landed)
      const closed = await closeOld();
      return { responseRef: `transfer:${from ?? "-"}>${to}`, warning: closed ? "already active at the new location; old location closed" : "already transferred in Rosnet; nothing sent",
               xref: this.xref(target, uid, p.payrollProvider_EmployeeUID, "matched") };
    }
    if (target) {                                                           // back to a store they worked at before
      await this.writeUnless(ROSNET_CODES.alreadyActive, "POST", "/Employee/rehireEmployee", rehireBody(p, to, this.stamp(), uid));
      await closeOld();
      return { responseRef: `rehire:${to}`, warning: "returned to a former location: rehired there", xref: this.xref(target, uid, p.payrollProvider_EmployeeUID, "matched") };
    }
    if (from !== null && old?.active) {
      await this.client.write("POST", "/Employee/transferEmployee", transferBody(p, this.stamp(), uid));
      return { responseRef: `transfer:${from}>${to}`, warning: await this.setEmail(p, to, uid) ?? undefined,
               xref: { externalId: uid, source: "matched", payrollId: p.payrollProvider_EmployeeUID } };
    }
    // not active at the old location (or it is not a Rosnet store): place the employee at the new one
    const hire: HirePayload = { ...p, locationNumber: to };
    const added = await this.writeUnless(ROSNET_CODES.alreadyExists, "POST", "/Employee/addEmployee", addBody(hire, this.stamp(), uid));
    return { responseRef: `add:${to}`, warning: RosnetConnector.join(from === null ? null : `${old ? "not active" : "no profile"} at ${from} in Rosnet: added at ${to}`, !added && "Rosnet reports the employee already exists"),
             xref: { externalId: uid, source: "created", payrollId: p.payrollProvider_EmployeeUID } };
  }

  /** The active profile a job or pay change applies to. Not there, terminated, or without any job yet: retry (a hire,
   *  rehire or transfer sent minutes ago may not have landed: Aloha shows the profile before its jobs), dead after the schedule. */
  private async activeAt(p: Ident, location: number, ctx: DeliveryContext): Promise<CfcEmployee> {
    const here = await this.find(p, location, !ctx.xref);
    if (!here) throw new DeliveryError("retry", `employee has no profile at Rosnet location ${location}`);
    if (!here.active) throw new DeliveryError("retry", `employee is terminated at Rosnet location ${location}`);
    if (!here.jobs.length) throw new DeliveryError("retry", `employee has no job on file yet at Rosnet location ${location}`);
    return here;
  }

  private async job(p: JobPayload, ctx: DeliveryContext): Promise<ExecuteResult> {
    const here = await this.activeAt(p, p.locationNumber, ctx);
    const onFile = new Set(here.jobs);
    const xref = this.xref(here, here.uid, p.payrollProvider_EmployeeUID, "matched");
    const notes: string[] = [];
    let sent = false;
    if (!onFile.has(p.add.jobCode)) { await this.client.write("PUT", "/Employee/addJob", jobBody(p, p.add, here.uid)); sent = true; }
    if (!p.remove) notes.push("previous UKG job has no Rosnet code: no job removed");
    else if (onFile.has(p.remove.jobCode)) {
      const rates = await this.client.payRates(here.uid, p.locationNumber, p.clientCode);
      const rate = rates.find(r => r.jobCode === p.remove!.jobCode)?.payRate ?? p.add.payRate;
      await this.client.write("PUT", "/Employee/removeJob", jobBody(p, { jobCode: p.remove.jobCode, payRate: rate, eventEffectiveDate: p.remove.eventEffectiveDate }, here.uid));
      sent = true;
    }
    if (!sent) notes.unshift("job already as wanted in Rosnet; nothing sent");
    return { responseRef: `job:${p.locationNumber}:${p.add.jobCode}`, warning: RosnetConnector.join(...notes), xref };
  }

  private async pay(p: PayPayload, ctx: DeliveryContext): Promise<ExecuteResult> {
    const here = await this.activeAt(p, p.locationNumber, ctx);
    const xref = this.xref(here, here.uid, p.payrollProvider_EmployeeUID, "matched");
    let code = p.jobInfo.jobCode, note: string | null = null;
    if (!here.jobs.includes(code)) {
      // Aloha holds another job than UKG maps to: with a single job on file the rate plainly belongs to it
      if (here.jobs.length !== 1) throw new DeliveryError("dead", `job code ${code} is not on file at Rosnet location ${p.locationNumber} (jobs on file: ${here.jobs.join(", ") || "none"})`);
      note = `job code ${code} is not on file; the rate was applied to job ${here.jobs[0]}`;
      code = here.jobs[0];
    }
    const current = (await this.client.payRates(here.uid, p.locationNumber, p.clientCode)).find(r => r.jobCode === code);
    if (current && cents(current.payRate) === cents(p.jobInfo.payRate))
      return { responseRef: `pay:${p.locationNumber}:${code}`, warning: RosnetConnector.join("rate already current in Rosnet; nothing sent", note), xref };
    await this.client.write("PUT", "/Employee/modifyJob", jobBody(p, { ...p.jobInfo, jobCode: code }, here.uid));
    return { responseRef: `pay:${p.locationNumber}:${code}`, warning: note ?? undefined, xref };
  }
}
