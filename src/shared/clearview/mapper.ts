import { DeliveryContext, DestinationCode, MappingError, Plan, PlanOutcome, PlanStep, Sensitive, SensitiveNeed, findCode, payloadHash } from "../delivery";

/*
  PURE mapping from a hub delivery (+ what was read from UKG at send time) to the Clearview v2 call sequence.
  No I/O. Values Clearview must supply at send time (its employeeId, assignment / job / pay ids, the current primary
  rate) are "$lookup:<name>" placeholders: shadow stores them as-is, the connector resolves them with GETs in live.

  Scope: company not in `companies` -> M9WOJ review ("HR to handle"), others skipped; org_level2 OPS or an excluded job
  -> skipped; a store transfer to a non-store (OPS, FIN ...) -> review. Unmapped store / job code -> MappingError (dead).
  Validation (MappingError): SIN 9 digits, DOB present, rate > 0, hire date after the previous termination.
*/

export interface MapperConfig {
  companies: string[];              // UKG companies sent to Clearview
  excludedJobs: string[];           // UKG job codes never sent
  terminationReasonId: number;      // default Clearview terminationReasonId
}

export const DEFAULT_MAPPER_CONFIG: MapperConfig = { companies: ["SWN6T", "SWNGK"], excludedJobs: ["MM"], terminationReasonId: 13078 };

export const STORE_PATTERN = /^[TW]\d{5}$/i;
export const LOOKUP = {
  employeeId: "$lookup:employeeId",                 // Clearview employeeId (xref or GET /employee/externalId)
  assignmentId: "$lookup:previousAssignmentId",     // the store assignment being ended on a transfer
  primaryJobId: "$lookup:primaryJobId",             // the employee's current primary job id
  primaryRate: "$lookup:currentPrimaryRate",        // the employee's current primary pay rate
  primaryPayType: "$lookup:currentPrimaryPayType",  // H / S of that rate (carried to a new job)
  payId: "$lookup:existingPayId"
} as const;

export const DOB_MASK = "****-**-**", SIN_MASK = "*********", PAY_MASK = "***", EMAIL_MASK = "***@***";
const SIN_KEYS = new Set(["sin", "sinno", "nationalid", "ssn"]);
const EMAIL_KEYS = new Set(["email", "emailaddress", "personalemail"]);     // contact details are sensitive tier: masked like SIN
const DOB_KEYS = new Set(["birthdate", "dateofbirth"]);
const PAY_KEYS = new Set(["payrate", "hourlypayrate", "annualsalary"]);

const up = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();
const isStore = (code: string | null | undefined) => STORE_PATTERN.test(up(code));
const toInt = (v: string, what: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new MappingError(`clearview ${what} "${v}" is not an integer`);
  return n;
};

// ---------------------------------------------------------------- masking + hash ----------------------------------------------------------------
function redact(value: unknown, maskPay: boolean): unknown {
  const walk = (v: any, key: string | null): any => {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map(x => walk(x, key));
    if (typeof v === "object") { const o: Record<string, unknown> = {}; for (const k of Object.keys(v)) o[k] = walk(v[k], k.toLowerCase()); return o; }
    if (key && SIN_KEYS.has(key)) return SIN_MASK;
    if (key && DOB_KEYS.has(key)) return DOB_MASK;
    if (key && EMAIL_KEYS.has(key)) return EMAIL_MASK;
    if (maskPay && key && PAY_KEYS.has(key)) return PAY_MASK;
    return v;
  };
  return walk(value, null);
}

/** Masks DOB, SIN and email but keeps pay (a rate change must change the hash). Nothing derived from SIN, DOB or email survives. */
export const redactForHash = (payload: unknown) => redact(payload, false);
/** Masks DOB, SIN, email and pay: the copy kept in out.shadow_payloads for admins to inspect. */
export const redactForStore = (payload: unknown) => redact(payload, true);
export const hashPayload = (payload: unknown): Buffer => payloadHash(redactForHash(payload));

// ---------------------------------------------------------------- helpers ----------------------------------------------------------------
export function sensitiveNeeds(ctx: DeliveryContext): SensitiveNeed[] {
  switch (ctx.delivery.action) {
    case "create": return ctx.xref ? ["pay"] : ["person", "pay"];
    case "pay": return ["pay"];
    default: return [];
  }
}

/** UKG pay -> Clearview payTypeCode H / S and the rate (hourly rate or annual salary). */
export function payOf(s: Sensitive): { payTypeCode: "H" | "S"; payRate: number } {
  const type = up(s.salaryOrHourly);
  const salaried = type === "S";
  const rate = Number(salaried ? s.annualSalary : s.hourlyPayRate);
  if (!(rate > 0)) throw new MappingError(`pay rate missing or not above zero in UKG (${salaried ? "annual salary" : "hourly rate"})`);
  return { payTypeCode: salaried ? "S" : "H", payRate: rate };
}

/** The mapping for the employee's organization (company-specific row first, then the shared one). */
const lookup = (ctx: DeliveryContext, type: "store" | "job" | "termination", ukg: string | null | undefined): DestinationCode | undefined =>
  findCode(ctx.codes, type, ctx.employment?.companyId, ukg);
const code = (ctx: DeliveryContext, type: "store" | "job", ukg: string | null, what: string) => {
  const m = lookup(ctx, type, ukg);
  if (!m) throw new MappingError(`no clearview ${type === "store" ? "store" : "job code"} for UKG ${what} ${ukg ?? "(none)"}`);
  return m;
};
const storeId = (ctx: DeliveryContext, ukgStore: string | null) => {
  const m = code(ctx, "store", ukgStore, "store");
  if (!m.destinationId) throw new MappingError(`clearview store ${ukgStore} has no storeId in ref.destination_codes (run discover)`);
  return toInt(m.destinationId, "storeId");
};
const jobId = (ctx: DeliveryContext, ukgJob: string | null) => {
  const m = code(ctx, "job", ukgJob, "job");
  if (!m.destinationId) throw new MappingError(`clearview job ${ukgJob} has no jobId in ref.destination_codes`);
  return toInt(m.destinationId, "jobId");
};
const displayName = (e: { firstName: string | null; preferredName: string | null; lastName: string | null }) =>
  [e.preferredName || e.firstName, e.lastName].filter(Boolean).join(" ").trim() || null;

// ---------------------------------------------------------------- plan ----------------------------------------------------------------
export function plan(ctx: DeliveryContext, sensitive: Sensitive, cfg: MapperConfig = DEFAULT_MAPPER_CONFIG): PlanOutcome {
  const d = ctx.delivery, ev = ctx.event, emp = ctx.employment;
  if (!ev || !emp) throw new MappingError("delivery has no event or employment context");
  if (!d.action) throw new MappingError(`no action for event type ${ev.eventType}`);

  // ---- scope ----
  const company = up(ev.toCompany ?? emp.companyId);
  if (!cfg.companies.map(up).includes(company)) {
    return company === "M9WOJ" ? { decision: "review", reason: "HR to handle: company M9WOJ is not sent to Clearview" }
                               : { decision: "skipped", reason: `company ${company} is not sent to Clearview` };
  }
  const job = up(d.action === "job" ? ev.toJob : emp.jobCode);
  if (job && cfg.excludedJobs.map(up).includes(job)) return { decision: "skipped", reason: `UKG job ${job} is not sent to Clearview` };
  if (d.action === "store") {
    if (!isStore(ev.toStore)) return { decision: "review", reason: `transfer to ${ev.toStore ?? "(none)"} is not a store transfer` };
  } else if (up(emp.orgLevel2) === "OPS") {
    return { decision: "skipped", reason: "org_level2 OPS is not sent to Clearview" };
  }

  const ref = ctx.xref?.externalId ?? LOOKUP.employeeId;
  const eff = ev.effectiveDate;
  const employeeNumber = emp.employeeNumber;
  const steps: PlanStep[] = [];
  const done = (operation: string, payload: unknown): PlanOutcome => ({ decision: "send", plan: { operation, steps, payload } });

  switch (d.action) {
    case "create": {
      if (ctx.xref) {                                                    // Clearview already knows them: rehire
        const pay = payOf(sensitive);
        const store = (ev.toStore && isStore(ev.toStore)) ? ev.toStore : emp.orgLevel2;
        const sid = storeId(ctx, store);
        const payload = {
          rehireDate: emp.lastHireDate ?? eff, reportingStoreId: sid,
          storeAssignments: [{ storeId: sid, employeeNameOnRegister: displayName(emp), employeeIdOnRegister: null }],
          jobs: [{ jobId: jobId(ctx, emp.jobCode), payTypeCode: pay.payTypeCode, payRate: pay.payRate, primaryJob: true,
                   salaryHours: pay.payTypeCode === "S" ? 40 : null }]
        };
        steps.push({ method: "GET", path: `/employee/${ref}`, note: "already active -> sent; rehire date on or before the termination -> dead" });
        steps.push({ method: "PUT", path: `/employeeStatus/${ref}/rehire`, body: payload });
        return done("rehire", payload);
      }
      // import: new to Clearview, goes to the staging area for Payroll to add
      if (!employeeNumber) throw new MappingError("UKG employee number missing");
      const sin = String(sensitive.sin ?? "").replace(/\D/g, "");
      if (sin.length !== 9) throw new MappingError("SIN missing or not 9 digits in UKG");
      const dob = (sensitive.dateOfBirth ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new MappingError("date of birth missing in UKG");
      const hireDate = emp.lastHireDate ?? emp.originalHireDate ?? eff;
      if (emp.terminationDate && hireDate <= emp.terminationDate) throw new MappingError(`hire date ${hireDate} is not after the previous termination ${emp.terminationDate}`);
      const pay = payOf(sensitive);
      const store = (ev.toStore && isStore(ev.toStore)) ? ev.toStore : emp.orgLevel2;
      const payload = {
        standardInformation: {
          firstName: emp.firstName, lastName: emp.lastName, preferredFirstName: emp.preferredName,
          birthDate: dob, reportingStore: toInt(code(ctx, "store", store, "store").destinationCode, "store number"),
          email: sensitive.email, employeeStatus: "A", hireDate
        },
        payAndBenefitInformation: { employeeNumber, sin, calculateOvertimeFlag: "Y" },
        jobAndPayInformation: { primaryJobCode: toInt(code(ctx, "job", emp.jobCode, "job").destinationCode, "job code"), payTypeCode: pay.payTypeCode, payRate: pay.payRate },
        additionalInformation: { externalId: emp.employeeId }
      };
      steps.push({ method: "GET", path: `/employee/externalId/${emp.employeeId}`, note: "exists -> record xref, nothing to import" });
      steps.push({ method: "GET", path: `/employee/import/${employeeNumber}/status`, note: "already in staging -> sent" });
      steps.push({ method: "POST", path: "/employee/import", body: payload });
      return done("import", payload);
    }
    case "terminate": {
      const reason = lookup(ctx, "termination", ev.terminationCategory);
      const payload = { terminationDate: eff, terminationReasonId: reason ? toInt(reason.destinationId ?? reason.destinationCode, "terminationReasonId") : cfg.terminationReasonId };
      steps.push({ method: "GET", path: `/employee/${ref}`, note: "already inactive with the same date -> sent; different date -> PUT" });
      steps.push({ method: "POST", path: `/employeeStatus/${ref}/terminate`, body: payload });
      return done("terminate", payload);
    }
    case "store": {
      const sid = storeId(ctx, ev.toStore);
      const transfer = ev.eventType === "Store transfer";
      const previous = transfer ? lookup(ctx, "store", ev.fromStore) : undefined;      // unmapped previous store: the connector warns, nothing is ended
      const payload = {
        assignment: { storeId: sid, startDate: eff, nameOnRegister: displayName(emp) },
        endPrevious: transfer ? {
          fromStore: ev.fromStore, storeId: previous?.destinationId ? toInt(previous.destinationId, "storeId") : null,
          storeNumber: previous ? toInt(previous.destinationCode, "store number") : null,
          assignmentId: LOOKUP.assignmentId, endDate: dayBefore(eff)
        } : null,
        reportingStoreId: transfer ? sid : null
      };
      steps.push({ method: "GET", path: `/employeeStoreAssignment/${ref}`, note: "assignment for this store already present -> skip the POST" });
      steps.push({ method: "POST", path: `/employeeStoreAssignment/${ref}`, body: payload.assignment });
      if (transfer) {
        steps.push({ method: "PUT", path: `/employeeStoreAssignment/${ref}/assignment/${LOOKUP.assignmentId}`, body: { endDate: payload.endPrevious!.endDate }, note: "previous store assignment ended" });
        steps.push({ method: "PATCH", path: `/employee/${ref}`, body: [{ op: "replace", path: "reportingStoreId", value: sid }], note: "unverified: warning only if Clearview rejects it" });
      }
      return done("store", payload);
    }
    case "job": {
      const target = code(ctx, "job", ev.toJob, "job");
      const payload = {
        add: { jobCode: toInt(target.destinationCode, "job code"), jobStatus: "A", primaryJob: true, payTypeCode: LOOKUP.primaryPayType, payRate: LOOKUP.primaryRate, effectiveDate: eff },
        promote: { jobId: target.destinationId ? toInt(target.destinationId, "jobId") : null, primaryJob: true, jobStatus: "A" },
        demote: { jobId: LOOKUP.primaryJobId, primaryJob: false, jobStatus: "I" }
      };
      steps.push({ method: "GET", path: `/employeeJob/${ref}`, note: "is the target job already on file? current primary job and rate" });
      steps.push({ method: "PUT", path: `/employeeJob/${ref}/job/${payload.promote.jobId ?? "$lookup:targetJobId"}`, body: { primaryJob: true, jobStatus: "A" }, note: "when the job is already on file" });
      steps.push({ method: "POST", path: `/employeeJob/${ref}/job`, body: payload.add, note: "otherwise" });
      steps.push({ method: "PUT", path: `/employeeJob/${ref}/job/${LOOKUP.primaryJobId}`, body: payload.demote, note: "old primary job" });
      return done("job", payload);
    }
    case "pay": {
      const pay = payOf(sensitive);
      const payload = { effectiveDate: eff, payTypeCode: pay.payTypeCode, payRate: pay.payRate, salaryHours: pay.payTypeCode === "S" ? 40 : null };
      steps.push({ method: "GET", path: `/employeeJob/${ref}`, note: "pay row at this date with the same rate -> unchanged; different rate -> PUT" });
      steps.push({ method: "POST", path: `/employeeJob/${ref}/job/${LOOKUP.primaryJobId}/pay`, body: payload });
      return done("pay", payload);
    }
    case "update": {
      const ft = up(emp.fullOrPartTime) === "F" || ev.eventType === "Part-time to full-time";
      const payload = [{ op: "replace", path: "empCatCode", value: ft ? "FullTime" : "PartTime" }];
      steps.push({ method: "PATCH", path: `/employee/${ref}`, body: payload });
      return done("update", payload);
    }
    default:
      throw new MappingError(`unsupported action ${d.action}`);
  }
}

export function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function isPlan(o: PlanOutcome): o is { decision: "send"; plan: Plan } { return o.decision === "send"; }
