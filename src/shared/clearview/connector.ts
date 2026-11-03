import { Connector, DeliveryContext, DeliveryError, ExecuteResult, PendingCreate, Plan, Sensitive, SensitiveNeed } from "../delivery";
import { ClearviewClient, ClearviewError } from "./client";
import { MapperConfig, DEFAULT_MAPPER_CONFIG, plan as planFor, redactForHash, redactForStore, sensitiveNeeds } from "./mapper";

/*
  Executes a mapper Plan against Clearview: resolves the "$lookup" placeholders with GETs, checks idempotency before
  every write (GET first), and classifies failures for the runner:
    network / timeout / 429 / 5xx -> retry   400 / 422 -> dead   employee not in Clearview -> waiting   401 / 403 -> abort.
  Log lines carry ids and Clearview messages only.
*/

const isActive = (status: unknown) => /^a/i.test(String(status ?? ""));
const sameName = (a: unknown, b: unknown) => String(a ?? "").trim().toUpperCase() === String(b ?? "").trim().toUpperCase();
const stdOf = (detail: any) => detail?.standardInformation ?? detail ?? {};
const idOf = (detail: any): number | null => { const id = Number(stdOf(detail)?.employeeId); return Number.isInteger(id) && id > 0 ? id : null; };

export function classify(e: any): DeliveryError {
  if (e instanceof DeliveryError) return e;
  if (e instanceof ClearviewError) {
    if (e.status === 401 || e.status === 403) return new DeliveryError("abort", e.message);
    if (e.status === 400 || e.status === 422 || e.status === 404) return new DeliveryError("dead", e.message);
    return new DeliveryError("retry", e.message);
  }
  return new DeliveryError("retry", String(e?.message ?? "error"));
}

export class ClearviewConnector implements Connector {
  readonly destination = "clearview";
  private reportingStoreWarned = false;
  constructor(private client: ClearviewClient, private cfg: MapperConfig = DEFAULT_MAPPER_CONFIG, private log: (m: string) => void = () => {}) {}

  hasCredentials(companyId: string | null): boolean { return this.client.hasKey(companyId); }
  sensitiveNeeds(ctx: DeliveryContext): SensitiveNeed[] { return sensitiveNeeds(ctx); }
  plan(ctx: DeliveryContext, sensitive: Sensitive) { return planFor(ctx, sensitive, this.cfg); }
  redactForHash(payload: unknown) { return redactForHash(payload); }
  redactForStore(payload: unknown) { return redactForStore(payload); }

  async execute(plan: Plan, ctx: DeliveryContext): Promise<ExecuteResult> {
    const company = ctx.employment?.companyId ?? "";
    try {
      switch (plan.operation) {
        case "import": return await this.import(company, plan, ctx);
        case "rehire": return await this.rehire(company, plan, ctx);
        case "terminate": return await this.terminate(company, plan, ctx);
        case "store": return await this.store(company, plan, ctx);
        case "job": return await this.job(company, plan, ctx);
        case "pay": return await this.pay(company, plan, ctx);
        case "update": return await this.update(company, plan, ctx);
        default: throw new DeliveryError("dead", `unsupported operation ${plan.operation}`);
      }
    } catch (e) { throw classify(e); }
  }

  /** Clearview's employeeId for the delivery's employee: xref, else GET by externalId, else by employeeNumber + last name. */
  private async resolveEmployee(company: string, ctx: DeliveryContext): Promise<{ id: number; xref?: ExecuteResult["xref"] }> {
    if (ctx.xref) {
      const id = Number(ctx.xref.externalId);
      if (Number.isInteger(id) && id > 0) return { id };
    }
    const emp = ctx.employment!;
    const byExternal = await this.client.getOrNull(company, `/employee/externalId/${encodeURIComponent(emp.employeeId)}`);
    const id1 = idOf(byExternal);
    if (id1) return { id: id1, xref: { externalId: String(id1), source: "matched" } };
    if (emp.employeeNumber) {
      const byNumber = await this.client.getOrNull(company, `/employee/employeeNumber/${encodeURIComponent(emp.employeeNumber)}`);
      const id2 = idOf(byNumber);
      if (id2 && sameName(stdOf(byNumber).lastName, emp.lastName)) return { id: id2, xref: { externalId: String(id2), source: "matched" } };
      if (id2) this.log(`employee ${emp.employeeId}: Clearview employeeNumber match has a different last name; not linked`);
    }
    throw new DeliveryError("waiting", "employee not in Clearview yet (import not added by Payroll, or never sent)");
  }

  private async import(company: string, plan: Plan, ctx: DeliveryContext): Promise<ExecuteResult> {
    const emp = ctx.employment!;
    const existing = await this.client.getOrNull(company, `/employee/externalId/${encodeURIComponent(emp.employeeId)}`);
    const id = idOf(existing);
    if (id) return { responseRef: `employee:${id}`, warning: "already in Clearview: xref recorded, nothing imported", xref: { externalId: String(id), source: "matched" } };
    const number = emp.employeeNumber!;
    const status = await this.client.getOrNull<string>(company, `/employee/import/${encodeURIComponent(number)}/status`);
    const staged = typeof status === "string" ? status : (status as any)?.status ?? (status as any)?.importStatus ?? null;
    if (staged && !/rejected|notfound/i.test(String(staged))) return { responseRef: `import:${number}`, warning: `already in Clearview staging (${staged})` };
    await this.client.post(company, "/employee/import", plan.payload);
    return { responseRef: `import:${number}` };
  }

  private async rehire(company: string, plan: Plan, ctx: DeliveryContext): Promise<ExecuteResult> {
    const { id, xref } = await this.resolveEmployee(company, ctx);
    const detail = await this.client.get(company, `/employee/${id}`);
    const payload: any = plan.payload;
    if (isActive(stdOf(detail).status)) return { responseRef: `employee:${id}`, warning: "already active in Clearview; rehire not sent", xref };
    const termDate = detail?.terminationInformation?.terminationDate ?? null;
    if (termDate && String(payload.rehireDate) <= String(termDate).slice(0, 10))
      throw new DeliveryError("dead", `rehire date ${payload.rehireDate} is not after the Clearview termination date ${String(termDate).slice(0, 10)}`);
    await this.client.put(company, `/employeeStatus/${id}/rehire`, payload);
    return { responseRef: `rehire:${id}`, xref };
  }

  private async terminate(company: string, plan: Plan, ctx: DeliveryContext): Promise<ExecuteResult> {
    const { id, xref } = await this.resolveEmployee(company, ctx);
    const detail = await this.client.get(company, `/employee/${id}`);
    const payload: any = plan.payload;
    if (!isActive(stdOf(detail).status)) {
      const termDate = String(detail?.terminationInformation?.terminationDate ?? "").slice(0, 10);
      if (termDate === payload.terminationDate) return { responseRef: `terminate:${id}`, warning: "already terminated in Clearview on this date", xref };
      await this.client.put(company, `/employeeStatus/${id}/terminate`, payload);
      return { responseRef: `terminate:${id}`, warning: termDate ? `termination date changed from ${termDate}` : undefined, xref };
    }
    await this.client.post(company, `/employeeStatus/${id}/terminate`, payload);
    return { responseRef: `terminate:${id}`, xref };
  }

  private async store(company: string, plan: Plan, ctx: DeliveryContext): Promise<ExecuteResult> {
    const { id, xref } = await this.resolveEmployee(company, ctx);
    const payload: any = plan.payload;
    const list: any[] = (await this.client.get(company, `/employeeStoreAssignment/${id}`, { includeInactiveStoreAssignment: false })) ?? [];
    const open = (a: any) => !a?.endDate;
    const warnings: string[] = [];
    let responseRef: string | null = null;
    const already = list.find(a => Number(a.storeId) === Number(payload.assignment.storeId) && open(a));
    if (already) { warnings.push("store assignment already present"); responseRef = `assignment:${already.assignmentId}`; }
    else {
      const created = await this.client.post(company, `/employeeStoreAssignment/${id}`, payload.assignment);
      responseRef = `assignment:${created?.assignmentId ?? "new"}`;
    }
    if (payload.endPrevious) {
      for (const a of list.filter(a => open(a) && Number(a.storeId) !== Number(payload.assignment.storeId))) {
        await this.client.put(company, `/employeeStoreAssignment/${id}/assignment/${a.assignmentId}`,
          { storeId: a.storeId, startDate: String(a.startDate).slice(0, 10), endDate: payload.endPrevious.endDate, nameOnRegister: a.employeeNameOnRegister ?? null, idOnRegister: a.idOnRegister ?? null });
      }
    }
    if (payload.reportingStoreId) {
      try { await this.client.patch(company, `/employee/${id}`, [{ op: "replace", path: "reportingStoreId", value: payload.reportingStoreId }]); }
      catch (e: any) {
        if (e instanceof ClearviewError && (e.status === 400 || e.status === 422 || e.status === 404)) {
          if (!this.reportingStoreWarned) { this.log(`reportingStoreId is not patchable: ${e.message}`); this.reportingStoreWarned = true; }
          warnings.push(`reporting store not changed: ${e.message}`);
        } else throw e;
      }
    }
    return { responseRef, warning: warnings.length ? warnings.join("; ") : undefined, xref };
  }

  private async job(company: string, plan: Plan, ctx: DeliveryContext): Promise<ExecuteResult> {
    const { id, xref } = await this.resolveEmployee(company, ctx);
    const payload: any = plan.payload;
    const jobs: any[] = (await this.client.get(company, `/employeeJob/${id}`, { includeInactiveJobs: true })) ?? [];
    const primary = jobs.find(j => j.primary && isActive(j.jobStatus)) ?? jobs.find(j => j.primary) ?? null;
    const target = jobs.find(j => Number(j.jobCode) === Number(payload.add.jobCode) || (payload.promote.jobId && Number(j.jobId) === Number(payload.promote.jobId))) ?? null;
    if (target && primary && Number(target.jobId) === Number(primary.jobId) && isActive(target.jobStatus))
      return { responseRef: `job:${target.jobId}`, warning: "already the primary job in Clearview", xref };
    let responseRef: string;
    if (target) {
      await this.client.put(company, `/employeeJob/${id}/job/${target.jobId}`, { primaryJob: true, jobStatus: "A" });
      responseRef = `job:${target.jobId}`;
    } else {
      const rate = currentRate(primary);
      if (!(rate > 0)) throw new DeliveryError("dead", "no current primary pay rate in Clearview to carry over to the new job");
      const added = await this.client.post(company, `/employeeJob/${id}/job`, { ...payload.add, payRate: rate });
      const newJob = Array.isArray(added) ? added.find((j: any) => Number(j.jobCode) === Number(payload.add.jobCode)) : added;
      responseRef = `job:${newJob?.jobId ?? payload.add.jobCode}`;
    }
    if (primary && (!target || Number(primary.jobId) !== Number(target.jobId)))
      await this.client.put(company, `/employeeJob/${id}/job/${primary.jobId}`, { primaryJob: false, jobStatus: "I" });
    return { responseRef, xref };
  }

  private async pay(company: string, plan: Plan, ctx: DeliveryContext): Promise<ExecuteResult> {
    const { id, xref } = await this.resolveEmployee(company, ctx);
    const payload: any = plan.payload;
    const jobs: any[] = (await this.client.get(company, `/employeeJob/${id}`, { includeInactiveJobs: false })) ?? [];
    const primary = jobs.find(j => j.primary) ?? null;
    if (!primary) throw new DeliveryError("dead", "no primary job in Clearview to attach the pay change to");
    const existing = (primary.payRates ?? []).find((p: any) => String(p.effectiveDate ?? "").slice(0, 10) === payload.effectiveDate) ?? null;
    if (existing) {
      if (Number(existing.payRate) === Number(payload.payRate)) return { responseRef: `pay:${existing.payId}`, warning: "pay row already present with this rate", xref };
      await this.client.put(company, `/employeeJob/${id}/job/${primary.jobId}/pay/${existing.payId}`, payload);
      return { responseRef: `pay:${existing.payId}`, xref };
    }
    const added = await this.client.post(company, `/employeeJob/${id}/job/${primary.jobId}/pay`, payload);
    return { responseRef: `pay:${added?.payId ?? primary.jobId}`, xref };
  }

  private async update(company: string, plan: Plan, ctx: DeliveryContext): Promise<ExecuteResult> {
    const { id, xref } = await this.resolveEmployee(company, ctx);
    await this.client.patch(company, `/employee/${id}`, plan.payload);
    return { responseRef: `employee:${id}`, xref };
  }

  /** After an import: has Payroll added the employee? By externalId, else by employeeNumber + last name. */
  async resolveCreated(p: PendingCreate): Promise<{ externalId: string; source: "created" | "matched" } | null> {
    const company = p.companyId ?? "";
    try {
      const byExternal = await this.client.getOrNull(company, `/employee/externalId/${encodeURIComponent(p.employeeId)}`);
      const id1 = idOf(byExternal);
      if (id1) return { externalId: String(id1), source: "created" };
      if (p.employeeNumber) {
        const byNumber = await this.client.getOrNull(company, `/employee/employeeNumber/${encodeURIComponent(p.employeeNumber)}`);
        const id2 = idOf(byNumber);
        if (id2 && sameName(stdOf(byNumber).lastName, p.lastName)) return { externalId: String(id2), source: "created" };
      }
      return null;
    } catch (e) { throw classify(e); }
  }
}

/** The latest pay rate on a Clearview job (effective on or before today). */
export function currentRate(job: any): number {
  const today = new Date().toISOString().slice(0, 10);
  const rows: any[] = (job?.payRates ?? []).filter((p: any) => String(p.effectiveDate ?? "").slice(0, 10) <= today);
  rows.sort((a, b) => String(b.effectiveDate).localeCompare(String(a.effectiveDate)));
  return Number(rows[0]?.payRate ?? 0);
}
