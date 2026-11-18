import { DeliveryContext, MappingError, Plan, PlanOutcome, PlanStep, Sensitive, SensitiveNeed, findCode } from "../delivery";
export { redactForHash, redactForStore } from "../masking";

/*
  PURE mapping from a hub delivery (+ what was read from UKG at send time) to the Rosnet EDT call(s). No I/O.

  Rosnet works per LOCATION (Aloha store) and decides nothing for us: whether a hire is an add or a rehire, and whether a
  job is already on file, depends on what Aloha holds at send time. So a plan carries the intent and the values, the
  steps listed are the candidates (shadow shows them), and the connector picks after a GET.

  Scope: company not in `companies` -> M9WOJ review ("HR to handle"), others skipped; a store that is not W##### ->
  skipped (transfer target: review). Unmapped store / job -> MappingError (dead at once).
  Validation (MappingError): payroll id numeric and 9 digits at most, date of birth present and 15+ on the effective
  date, hourly rate above zero (sent with 2 decimals), names present. Apostrophes are stripped from names (the EDT guide
  forbids them). The SIN is not sent unless `sendSin` (Rosnet accepts null).

  Ids: posProvider_EmployeeUID = the UKG employee id (or the id Aloha already holds, from the xref);
       payrollProvider_EmployeeUID = the UKG employee number (Aloha Export ID).
  "$now" marks insertDate / updateDate: the connector stamps them at send time, so they never change the payload hash.
*/

export interface RosnetMapperConfig {
  companies: string[];          // UKG companies sent to Rosnet
  clientCode: string;           // Rosnet client code (QUICKWEN)
  termCode: number;             // termination code used when ref.destination_codes has no row for the category
  sendSin: boolean;             // false: ssn is sent as null
  minAge: number;               // Aloha rejects employees younger than this
}
export const DEFAULT_ROSNET_CONFIG: RosnetMapperConfig = { companies: ["SWN1U"], clientCode: "QUICKWEN", termCode: 1, sendSin: false, minAge: 15 };

export const ROSNET_STORE = /^W\d{5}$/i;
export const NOW = "$now";

export interface JobInfo { jobCode: number; payRate: number; eventEffectiveDate: string; }
export interface Ident { posProvider_EmployeeUID: string; payrollProvider_EmployeeUID: string; firstName: string; lastName: string; }
export interface HirePayload extends Ident { clientCode: string; locationNumber: number; eventEffectiveDate: string;
                                              ssn: string | null; dob: string; emailId: string | null; jobInfo: JobInfo[]; }
export interface TerminatePayload extends Ident { clientCode: string; locationNumber: number; terminationEffectiveDate: string; employeeTerminationCode: number; }
export interface TransferPayload extends Ident { clientCode: string; newLocationNumber: number; originalLocationNumber: number | null; eventEffectiveDate: string;
                                                  ssn: string | null; dob: string; emailId: string | null; employeeTerminationCode: number; jobInfo: JobInfo[]; }
export interface JobPayload extends Ident { clientCode: string; locationNumber: number; add: JobInfo; remove: { jobCode: number; eventEffectiveDate: string } | null; }
export interface PayPayload extends Ident { clientCode: string; locationNumber: number; jobInfo: JobInfo; }

const up = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();
const stamp = (date: string) => `${date.slice(0, 10)}T00:00:00`;
const toInt = (v: string, what: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new MappingError(`rosnet ${what} "${v}" is not an integer`);
  return n;
};
/** The first candidate that is a Rosnet store (W#####). */
const pickStore = (...candidates: (string | null | undefined)[]): string | null => candidates.map(up).find(s => ROSNET_STORE.test(s)) ?? null;
/** Names as Rosnet accepts them: no apostrophes (straight, curly or backtick), single spaces. */
export const cleanName = (s: string | null | undefined) => String(s ?? "").replace(/['’‘`´]/g, "").replace(/\s+/g, " ").trim();

export function sensitiveNeeds(ctx: DeliveryContext): SensitiveNeed[] {
  switch (ctx.delivery.action) {
    case "create": case "store": return ["person", "pay"];
    case "job": case "pay": return ["pay"];
    default: return [];
  }
}

/** The hourly rate, 2 decimals. Rosnet takes an hourly rate for hourly and salaried employees alike. */
export function rateOf(s: Sensitive): number {
  const rate = Number(s.hourlyPayRate);
  if (!(rate > 0)) throw new MappingError("hourly pay rate missing or not above zero in UKG");
  return Math.round(rate * 100) / 100;
}

function location(ctx: DeliveryContext, company: string, store: string): number {
  const m = findCode(ctx.codes, "store", company, store);
  if (!m) throw new MappingError(`no rosnet location for UKG store ${store} (run discover or provisioning/25)`);
  return toInt(m.destinationCode, "location number");
}
function jobCode(ctx: DeliveryContext, company: string, ukgJob: string | null): number {
  const m = findCode(ctx.codes, "job", company, ukgJob);
  if (!m) throw new MappingError(`no rosnet job code for UKG job ${ukgJob ?? "(none)"}`);
  return toInt(m.destinationCode, "job code");
}
/** Termination code for a category: its row, else the 'Default' row, else the configured code. */
function termCode(ctx: DeliveryContext, company: string, category: string | null, cfg: RosnetMapperConfig): number {
  const m = findCode(ctx.codes, "termination", company, category) ?? findCode(ctx.codes, "termination", company, "Default");
  return m ? toInt(m.destinationCode, "termination code") : cfg.termCode;
}
const TERMINATE_CATEGORY: Record<string, string> = {
  "Leave of absence": "Leave", "Cross-company transfer out": "Transfer", "Hired but never worked": "No-show", "Administrative termination": "Administrative"
};

function ident(ctx: DeliveryContext): Ident {
  const emp = ctx.employment!;
  const payroll = String(ctx.xref?.payrollId ?? emp.employeeNumber ?? "").trim();
  if (!/^\d{1,9}$/.test(payroll)) throw new MappingError("payroll id (UKG employee number) missing or not numeric with 9 digits at most");
  const firstName = cleanName(emp.firstName), lastName = cleanName(emp.lastName);      // legal first name, not the preferred one
  if (!firstName || !lastName) throw new MappingError("first or last name missing in UKG");
  return { posProvider_EmployeeUID: ctx.xref?.externalId ?? emp.employeeId, payrollProvider_EmployeeUID: payroll, firstName, lastName };
}

function person(sensitive: Sensitive, effective: string, cfg: RosnetMapperConfig): { ssn: string | null; dob: string; emailId: string | null } {
  const dob = (sensitive.dateOfBirth ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new MappingError("date of birth missing in UKG");
  const cutoff = `${String(Number(effective.slice(0, 4)) - cfg.minAge).padStart(4, "0")}${effective.slice(4, 10)}`;
  if (dob > cutoff) throw new MappingError(`employee is younger than ${cfg.minAge} on the effective date`);
  let ssn: string | null = null;
  if (cfg.sendSin) {
    ssn = String(sensitive.sin ?? "").replace(/\D/g, "");
    if (ssn.length !== 9) throw new MappingError("SIN missing or not 9 digits in UKG");
  }
  return { ssn, dob: stamp(dob), emailId: (sensitive.email ?? "").trim() || null };
}

// ---------------------------------------------------------------- plan ----------------------------------------------------------------
export function plan(ctx: DeliveryContext, sensitive: Sensitive, cfg: RosnetMapperConfig = DEFAULT_ROSNET_CONFIG): PlanOutcome {
  const d = ctx.delivery, ev = ctx.event, emp = ctx.employment;
  if (!ev || !emp) throw new MappingError("delivery has no event or employment context");
  if (!d.action) throw new MappingError(`no action for event type ${ev.eventType}`);

  // ---- scope: a termination belongs to the company being left, everything else to the company joined ----
  const company = up(d.action === "terminate" ? (ev.fromCompany ?? emp.companyId) : (ev.toCompany ?? emp.companyId));
  if (!cfg.companies.map(up).includes(company)) {
    return company === "M9WOJ" ? { decision: "review", reason: "HR to handle: company M9WOJ is not sent to Rosnet" }
                               : { decision: "skipped", reason: `company ${company} is not sent to Rosnet` };
  }
  if (d.action === "update") return { decision: "skipped", reason: `${ev.eventType} is not sent to Rosnet` };

  const eff = stamp(ev.effectiveDate);
  const steps: PlanStep[] = [];
  const done = (operation: string, payload: unknown): PlanOutcome => ({ decision: "send", plan: { operation, steps, payload } });
  const notRosnet = (store: string | null | undefined): PlanOutcome => ({ decision: "skipped", reason: `store ${store ?? "(none)"} is not a Rosnet location` });
  const get = (uid: string, loc: number, note: string) => steps.push({ method: "GET", path: `/Employee/getEmployee/${uid}/${loc}`, note });

  switch (d.action) {
    case "create": {
      const store = pickStore(ev.toStore, d.store, emp.orgLevel2);
      if (!store) return notRosnet(ev.toStore ?? d.store ?? emp.orgLevel2);
      const id = ident(ctx);
      const loc = location(ctx, company, store);
      // a return from leave or a move in from another company starts on the event day, a hire on the hire date
      const start = ev.eventType === "Return from leave" || ev.eventType === "Cross-company transfer in" ? eff : stamp(emp.lastHireDate ?? ev.effectiveDate);
      const payload: HirePayload = {
        ...id, clientCode: cfg.clientCode, locationNumber: loc, eventEffectiveDate: start,
        ...person(sensitive, start, cfg), jobInfo: [{ jobCode: jobCode(ctx, company, emp.jobCode), payRate: rateOf(sensitive), eventEffectiveDate: start }]
      };
      get(id.posProvider_EmployeeUID, loc, "active here -> nothing sent; terminated profile here -> rehire; no profile here -> add");
      steps.push({ method: "POST", path: "/Employee/addEmployee", body: addBody(payload), note: "no profile at this location" });
      steps.push({ method: "POST", path: "/Employee/rehireEmployee", body: rehireBody(payload, loc), note: "terminated profile at this location" });
      return done("hire", payload);
    }
    case "terminate": {
      const store = pickStore(ev.fromStore, d.store, ev.toStore, emp.orgLevel2);
      if (!store) return notRosnet(ev.fromStore ?? d.store ?? emp.orgLevel2);
      const id = ident(ctx);
      const payload: TerminatePayload = {
        ...id, clientCode: cfg.clientCode, locationNumber: location(ctx, company, store), terminationEffectiveDate: eff,
        employeeTerminationCode: termCode(ctx, company, ev.terminationCategory ?? TERMINATE_CATEGORY[ev.eventType] ?? null, cfg)
      };
      get(id.posProvider_EmployeeUID, payload.locationNumber, "already terminated here -> nothing sent");
      steps.push({ method: "PUT", path: "/Employee/terminateEmployee", body: terminateBody(payload) });
      return done("terminate", payload);
    }
    case "store": {
      const to = pickStore(ev.toStore);
      if (!to) return { decision: "review", reason: `transfer to ${ev.toStore ?? "(none)"} is not a store transfer` };
      const id = ident(ctx);
      const from = pickStore(ev.fromStore);
      const payload: TransferPayload = {
        ...id, clientCode: cfg.clientCode, newLocationNumber: location(ctx, company, to),
        originalLocationNumber: from && from !== to ? location(ctx, company, from) : null, eventEffectiveDate: eff,
        ...person(sensitive, eff, cfg), employeeTerminationCode: termCode(ctx, company, "Transfer", cfg),
        jobInfo: [{ jobCode: jobCode(ctx, company, emp.jobCode), payRate: rateOf(sensitive), eventEffectiveDate: eff }]
      };
      get(id.posProvider_EmployeeUID, payload.newLocationNumber, "already active here -> only the old location is closed; terminated profile here -> rehire here, then close the old location");
      if (payload.originalLocationNumber !== null) get(id.posProvider_EmployeeUID, payload.originalLocationNumber, "not active there -> added (or rehired) at the new location instead");
      steps.push({ method: "POST", path: "/Employee/transferEmployee", body: transferBody(payload), note: "adds at the new location and terminates at the old one" });
      return done("transfer", payload);
    }
    case "job": {
      const store = pickStore(d.store, ev.toStore, emp.orgLevel2);
      if (!store) return notRosnet(d.store ?? emp.orgLevel2);
      const to = jobCode(ctx, company, ev.toJob);
      const fromRow = findCode(ctx.codes, "job", company, ev.fromJob);
      const from = fromRow ? toInt(fromRow.destinationCode, "job code") : null;
      const id = ident(ctx);
      if (from === to) {
        // Two UKG jobs with one Rosnet code (RMIT -> RMH, both 610): no job to add or remove, but the rate usually changes
        // with the job and the hub raises no separate Pay change event for that row. Bring the rate in line, as Flexspring does.
        const same: PayPayload = { ...id, clientCode: cfg.clientCode, locationNumber: location(ctx, company, store),
                                   jobInfo: { jobCode: to, payRate: rateOf(sensitive), eventEffectiveDate: eff } };
        get(id.posProvider_EmployeeUID, same.locationNumber, `UKG jobs ${ev.fromJob} and ${ev.toJob} are the same Rosnet job code ${to}: only the rate is checked`);
        steps.push({ method: "POST", path: "/PayRate", body: { posProvider_EmployeeUID: id.posProvider_EmployeeUID, locationNumber: same.locationNumber, clientCode: cfg.clientCode }, note: "same rate already -> nothing sent" });
        steps.push({ method: "PUT", path: "/Employee/modifyJob", body: jobBody(same, same.jobInfo) });
        return done("pay", same);
      }
      const payload: JobPayload = {
        ...id, clientCode: cfg.clientCode, locationNumber: location(ctx, company, store),
        add: { jobCode: to, payRate: rateOf(sensitive), eventEffectiveDate: eff }, remove: from === null ? null : { jobCode: from, eventEffectiveDate: eff }
      };
      get(id.posProvider_EmployeeUID, payload.locationNumber, "jobs on file: add only when the new one is missing, remove only when the old one is still there");
      steps.push({ method: "PUT", path: "/Employee/addJob", body: jobBody(payload, payload.add) });
      if (payload.remove) steps.push({ method: "PUT", path: "/Employee/removeJob", body: jobBody(payload, { ...payload.remove, payRate: payload.add.payRate }), note: "rate = the old job's current rate (POST /PayRate)" });
      return done("job", payload);
    }
    case "pay": {
      const store = pickStore(d.store, ev.toStore, emp.orgLevel2);
      if (!store) return notRosnet(d.store ?? emp.orgLevel2);
      const id = ident(ctx);
      const payload: PayPayload = { ...id, clientCode: cfg.clientCode, locationNumber: location(ctx, company, store),
                                    jobInfo: { jobCode: jobCode(ctx, company, emp.jobCode), payRate: rateOf(sensitive), eventEffectiveDate: eff } };
      get(id.posProvider_EmployeeUID, payload.locationNumber, "the job must be on file");
      steps.push({ method: "POST", path: "/PayRate", body: { posProvider_EmployeeUID: id.posProvider_EmployeeUID, locationNumber: payload.locationNumber, clientCode: cfg.clientCode }, note: "same rate already -> nothing sent" });
      steps.push({ method: "PUT", path: "/Employee/modifyJob", body: jobBody(payload, payload.jobInfo) });
      return done("pay", payload);
    }
    default:
      throw new MappingError(`unsupported action ${d.action}`);
  }
}

// ---------------------------------------------------------------- request bodies ----------------------------------------------------------------
// Built from a payload by the mapper (for the shadow copy) and by the connector (at send time, with the real "$now" and
// the POS UID Aloha actually holds). Field names are the EDT schema's.
const idOf = (p: Ident, uid?: string) => ({ posProvider_EmployeeUID: uid ?? p.posProvider_EmployeeUID, payrollProvider_EmployeeUID: p.payrollProvider_EmployeeUID, firstName: p.firstName, lastName: p.lastName });

export const addBody = (p: HirePayload, now: string = NOW, uid?: string) => ({
  eventEffectiveDate: p.eventEffectiveDate, jobInfo: p.jobInfo, clientCode: p.clientCode, ...idOf(p, uid), ssn: p.ssn, dob: p.dob,
  locationNumber: p.locationNumber, insertDate: now, updateDate: now, emailId: p.emailId
});
/** Always a rehire in place: the terminated profile is at `location` itself. The API's other form ("into a different
 *  location") answered 200 and changed nothing in the sandbox (three attempts, 2026-11-17), so it is not built. */
export const rehireBody = (p: Ident & { clientCode: string; ssn: string | null; jobInfo: JobInfo[] }, location: number, now: string = NOW, uid?: string) => ({
  jobInfo: p.jobInfo, clientCode: p.clientCode, ...idOf(p, uid), ssn: p.ssn, locationNumber: location, oldLocationNumber: location,
  insertDate: now, updateDate: now, rehireIntoDifferentLocationFlag: false
});
export const terminateBody = (p: Ident & { clientCode: string }, location?: number, date?: string, code?: number, uid?: string) => {
  const t = p as Partial<TerminatePayload>;
  return { ...idOf(p, uid), terminationEffectiveDate: date ?? t.terminationEffectiveDate, clientCode: p.clientCode, locationNumber: location ?? t.locationNumber,
           employeeTerminationCode: code ?? t.employeeTerminationCode };
};
export const transferBody = (p: TransferPayload, now: string = NOW, uid?: string) => ({
  eventEffectiveDate: p.eventEffectiveDate, clientCode: p.clientCode, ...idOf(p, uid), ssn: p.ssn, dob: p.dob,
  newLocationNumber: p.newLocationNumber, originalLocationNumber: p.originalLocationNumber, insertDate: now, updateDate: now,
  employeeTerminationCode: p.employeeTerminationCode, jobInfo: p.jobInfo
});
export const jobBody = (p: Ident & { locationNumber: number }, jobInfo: JobInfo, uid?: string) => ({ ...idOf(p, uid), locationNumber: p.locationNumber, jobInfo });
export const emailBody = (p: Ident & { clientCode: string }, location: number, emailId: string, now: string = NOW, uid?: string) => ({
  clientCode: p.clientCode, payrollProvider_EmployeeUID: p.payrollProvider_EmployeeUID, posProvider_EmployeeUID: uid ?? p.posProvider_EmployeeUID,
  locationNumber: location, updateDate: now, emailId
});

export function isPlan(o: PlanOutcome): o is { decision: "send"; plan: Plan } { return o.decision === "send"; }
