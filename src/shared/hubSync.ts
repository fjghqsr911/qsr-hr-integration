/*
  Workforce Data Hub - intraday sync of UKG employee changes.

  1. Window: from the end of the last successful intraday run (or the first backfill start), minus a 2-hour overlap.
  2. employee-changes for that window -> distinct employees (+ names, which this feed includes).
  3. Per employee: employment details (all companies) -> in scope? (active / leave / terminated within lookback)
     -> job history. Out-of-scope employees are skipped; nothing about them is stored.
  4. One transaction: replace those employees' employment + job-history rows.
  5. Rebuild their workforce events (if the event-rules procedure is installed).
  Stores names but never pay, SIN, DOB, contact details, termination or leave reasons
  (termination reason codes are converted to a category).
*/

export interface EmploymentRow {
  employee_id: string; company_id: string; employee_number: string | null; is_home_company: boolean | null;
  employee_status: string | null; status_start_date: string | null; original_hire_date: string | null;
  last_hire_date: string | null; termination_date: string | null; date_last_worked: string | null;
  termination_category: string | null; org_level1: string | null; org_level2: string | null; job_code: string | null;
  full_or_part_time: string | null; date_in_job: string | null;
  first_name: string | null; preferred_name: string | null; last_name: string | null;
}

export interface JobHistoryRow {
  system_id: string; employee_id: string; company_id: string | null; job_effective_date: string;
  date_time_created: string | null; employee_status: string | null; employee_type: string | null; job_code: string | null;
  job_description: string | null; org_level1: string | null; org_level2: string | null; full_or_part_time: string | null;
  salary_or_hourly: string | null; supervisor_id: string | null; reason_code: string | null; termination_category: string | null;
  is_job_change: boolean | null; is_orgchange: boolean | null; is_transfer: boolean | null; is_rate_change: boolean | null;
  home_company_id: string | null;
}

export interface TermCode { category: string; type: string; }
import { ContactConfig, ContactRow, extractBirthday, extractContact, hasAnyContact } from "./contacts";

export interface Names { first: string | null; preferred: string | null; last: string | null; }

export interface SnapshotRow {
  employee_id: string; company_id: string; employee_status: string;
  org_level1: string | null; org_level2: string | null; job_code: string | null; full_or_part_time: string | null;
}

export interface HubStore {
  /** End of the last successful intraday window, else the earliest backfill start, else null. */
  lastSyncedUntil(): Promise<Date | null>;
  /** True if a run of this type started in the last 30 minutes and has not finished. */
  isRunning(runType: "intraday" | "nightly"): Promise<boolean>;
  termCodes(): Promise<Map<string, TermCode>>;
  startRun(runType: "intraday" | "nightly", windowStart: Date | null, windowEnd: Date | null): Promise<string>;
  finishRun(runId: string, status: "succeeded" | "partial" | "failed", counts: { employees: number; ukgCalls: number; events?: number }, error?: string): Promise<void>;
  replaceEmployees(employeeIds: string[], employment: EmploymentRow[], jobHistory: JobHistoryRow[]): Promise<void>;
  /** Returns the number of events rebuilt, or null if the event-rules procedure is not installed yet. */
  rebuildEvents(employeeIds: string[]): Promise<number | null>;
  // ---- contacts (sensitive tier; active / on-leave employees only) ----
  upsertContacts(contacts: ContactRow[], deleteIds: string[]): Promise<void>;
  replaceAllContacts(contacts: ContactRow[]): Promise<void>;
  // ---- nightly ----
  writeSnapshot(snapshotDate: string, rows: SnapshotRow[]): Promise<void>;
  /** Insert/update current employment rows (including names) for the given records; does not touch job history. */
  upsertEmployment(rows: EmploymentRow[]): Promise<void>;
  /** Every row in stage.employment_current (one per employee and company), for comparison with UKG. */
  currentEmployment(): Promise<SnapshotRow[]>;
  purge(lookbackMonths: number): Promise<number>;
  hoursSinceIntradaySuccess(): Promise<number | null>;
}

export interface UkgSource {
  getAll<T = any>(path: string, perPage: number): Promise<T[]>;
}

export interface SyncOptions {
  now?: Date;
  lookbackMonths: number;
  overlapHours?: number;
  log?: (msg: string) => void;
}

export interface SyncResult {
  status: "succeeded" | "partial" | "failed" | "skipped";
  windowStart?: string; windowEnd?: string;
  changeRecords?: number; employeesChanged?: number; employeesInScope?: number; employeesOutOfScope?: number;
  employeesFailed?: number; jobHistoryRows?: number; eventsRebuilt?: number | null; ukgCalls?: number; message?: string;
  contactsUpdated?: number; contactsRemoved?: number;
}

// ---------------- helpers ----------------
const nz = (v: any): string | null => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());
const toBool = (v: any): boolean | null => (v === null || v === undefined || v === "" ? null : v === true || String(v).toLowerCase() === "true");
/** "2026-04-20T00:00:00" -> "2026-04-20" */
export const toDateOnly = (v: any): string | null => { const s = nz(v); return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };
/** -> "2026-04-20T13:05:00" (no timezone; stored as UTC/as-given) */
export const toDateTime = (v: any): string | null => { const s = nz(v); return s && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) ? s.slice(0, 19) : (toDateOnly(s) ? `${toDateOnly(s)}T00:00:00` : null); };
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export function termCategory(code: string | null, termType: string | null, map: Map<string, TermCode>): string {
  const c = (code ?? "").trim().toUpperCase();
  const m = c ? map.get(c) : undefined;
  if (m) {
    if (m.category === "Termination") return m.type || "Unknown";      // Voluntary / Involuntary / Unknown (999)
    return m.category;                                                  // Transfer / No-show / Administrative
  }
  switch ((termType ?? "").trim().toUpperCase()) {
    case "V": return "Voluntary"; case "I": return "Involuntary"; case "T": return "Transfer"; default: return "Unknown";
  }
}

export function isInScope(records: EmploymentRow[], cutoff: string): boolean {
  return records.some(r => r.employee_status === "A" || r.employee_status === "L" ||
    (r.employee_status === "T" && !!r.termination_date && r.termination_date >= cutoff));
}

export function mapEmployment(r: any, names: { first: string | null; preferred: string | null; last: string | null } | undefined, map: Map<string, TermCode>): EmploymentRow {
  const status = nz(r.employeeStatusCode);
  return {
    employee_id: nz(r.employeeID)!, company_id: nz(r.companyID)!, employee_number: nz(r.employeeNumber),
    is_home_company: toBool(r.isHomeCompany), employee_status: status,
    status_start_date: toDateOnly(r.employeeStatusStartDate), original_hire_date: toDateOnly(r.originalHireDate),
    last_hire_date: toDateOnly(r.lastHireDate), termination_date: toDateOnly(r.terminationDate), date_last_worked: toDateOnly(r.dateLastWorked),
    termination_category: status === "T" ? termCategory(nz(r.terminationReasonCode), nz(r.termType), map) : null,
    org_level1: nz(r.orgLevel1Code), org_level2: nz(r.orgLevel2Code), job_code: nz(r.primaryJobCode) ?? nz(r.jobCode),
    full_or_part_time: nz(r.fullTimeOrPartTimeCode), date_in_job: toDateOnly(r.dateInJob),
    first_name: names?.first ?? null, preferred_name: names?.preferred ?? null, last_name: names?.last ?? null
  };
}

export function mapJobHistory(r: any, employeeId: string, map: Map<string, TermCode>): JobHistoryRow | null {
  const eff = toDateOnly(r.jobEffectiveDate);
  if (!eff) return null;
  const status = nz(r.employeeStatus);
  const isTerm = status === "T";
  const sys = nz(r.systemId) ?? `${employeeId}|${nz(r.companyId)}|${eff}|${nz(r.dateTimeCreated)}|${nz(r.reasonCode)}`;
  return {
    system_id: sys, employee_id: employeeId, company_id: nz(r.companyId), job_effective_date: eff,
    date_time_created: toDateTime(r.dateTimeCreated), employee_status: status, employee_type: nz(r.employeeType),
    job_code: nz(r.jobCode), job_description: nz(r.jobDescription), org_level1: nz(r.orgLevel1Code), org_level2: nz(r.orgLevel2Code),
    full_or_part_time: nz(r.fullTimeOrPartTime), salary_or_hourly: nz(r.salaryOrHourly), supervisor_id: nz(r.supervisorId),
    reason_code: isTerm ? null : nz(r.reasonCode),                                       // termination reasons never stored
    termination_category: isTerm ? termCategory(nz(r.reasonCode), null, map) : null,
    is_job_change: toBool(r.isJobChange), is_orgchange: toBool(r.isOrgchange), is_transfer: toBool(r.isTransfer),
    is_rate_change: toBool(r.isRateChange), home_company_id: nz(r.homeCompanyId)
  };
}

// ---------------- shared per-employee processing ----------------
export interface Collected {
  employment: EmploymentRow[]; jobHistory: JobHistoryRow[];
  done: string[]; failed: string[]; outOfScope: number;
  employmentRaw: Map<string, any[]>;            // raw employment records per employee (for contacts)
}

/** For each employee: employment details (scope check) + job history. Out-of-scope employees are skipped. */
export async function collectEmployees(
  ids: string[], names: Map<string, Names>, getAll: <T>(path: string, perPage: number) => Promise<T[]>,
  termMap: Map<string, TermCode>, cutoff: string, log: (m: string) => void
): Promise<Collected> {
  const out: Collected = { employment: [], jobHistory: [], done: [], failed: [], outOfScope: 0, employmentRaw: new Map() };
  const seenSys = new Set<string>();
  for (const id of ids) {
    try {
      const empRaw = (await getAll<any>(`/personnel/v1/employee-employment-details?employeeId=${encodeURIComponent(id)}`, 200))
        .filter(r => (nz(r.employeeID) ?? "").toUpperCase() === id.toUpperCase());
      const emp = empRaw.map(r => mapEmployment(r, names.get(id), termMap));
      if (!isInScope(emp, cutoff)) { out.outOfScope++; continue; }
      const jhRaw = (await getAll<any>(`/personnel/v1/employee-job-history-details?employeeId=${encodeURIComponent(id)}`, 200))
        .filter(r => (nz(r.employeeId) ?? "").toUpperCase() === id.toUpperCase());
      const seenKey = new Set<string>();
      for (const e of emp) { const k = `${e.employee_id}|${e.company_id}`; if (!seenKey.has(k)) { seenKey.add(k); out.employment.push(e); } }
      for (const r of jhRaw) {
        const m = mapJobHistory(r, id, termMap);
        if (m && !seenSys.has(m.system_id)) { seenSys.add(m.system_id); out.jobHistory.push(m); }
      }
      out.employmentRaw.set(id, empRaw);
      out.done.push(id);
    } catch (e: any) {
      if (e?.status === 401) throw e;                // stop: never retry bad credentials
      out.failed.push(id);
      log(`employee ${id} failed: ${e?.message ?? "error"}`);
    }
  }
  return out;
}

/** Employees the database knows whose UKG status, district, store, job or FT/PT differs from their stored row, who have
 *  a company record the database lacks, or whose active / on-leave company record is no longer active / on leave in UKG
 *  while another one is (`ukg` = UKG's A/L rows). Employees the database has never seen are not included. */
export function changedEmployees(ukg: EmploymentRow[], db: SnapshotRow[]): string[] {
  const key = (r: { employee_id: string; company_id: string }) => `${r.employee_id}|${r.company_id}`;
  const sig = (r: { employee_status: string | null; org_level1: string | null; org_level2: string | null; job_code: string | null; full_or_part_time: string | null }) =>
    [r.employee_status, r.org_level1, r.org_level2, r.job_code, r.full_or_part_time].map(v => v ?? "").join("|");
  const stored = new Map(db.map(r => [key(r), sig(r)]));
  const known = new Set(db.map(r => r.employee_id));
  const inUkg = new Set(ukg.map(key));
  const ukgIds = new Set(ukg.map(r => r.employee_id));
  const out = new Set<string>();
  for (const r of ukg) if (known.has(r.employee_id) && stored.get(key(r)) !== sig(r)) out.add(r.employee_id);
  for (const r of db) if ((r.employee_status === "A" || r.employee_status === "L") && ukgIds.has(r.employee_id) && !inUkg.has(key(r))) out.add(r.employee_id);
  return [...out];
}

const isActiveOrLeave = (rows: EmploymentRow[]) => rows.some(r => r.employee_status === "A" || r.employee_status === "L");
const cutoffFor = (now: Date, months: number) => { const d = new Date(now); d.setUTCMonth(d.getUTCMonth() - months); return d.toISOString().slice(0, 10); };

/** Today's date in Toronto as yyyy-mm-dd. */
export function torontoDate(now: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = (t: string) => p.find(x => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

// ---------------- intraday ----------------
export async function runIntradaySync(store: HubStore, ukg: UkgSource, opts: SyncOptions & { contacts?: ContactConfig }): Promise<SyncResult> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const overlapMs = (opts.overlapHours ?? 2) * 3600_000;

  if (await store.isRunning("intraday")) return { status: "skipped", message: "Another sync is running" };

  const last = await store.lastSyncedUntil();
  const windowStart = new Date((last ? last.getTime() : now.getTime() - 24 * 3600_000) - overlapMs);
  const windowEnd = now;
  const cutoff = cutoffFor(now, opts.lookbackMonths);

  let calls = 0;
  const getAll = async <T>(path: string, perPage: number) => {
    const rows = await ukg.getAll<T>(path, perPage);
    calls += Math.floor(rows.length / perPage) + 1;      // pages requested
    return rows;
  };

  const runId = await store.startRun("intraday", windowStart, windowEnd);
  try {
    const termMap = await store.termCodes();
    const changes = await getAll<any>(`/personnel/v1/employee-changes?startDate=${encodeURIComponent(iso(windowStart))}&endDate=${encodeURIComponent(iso(windowEnd))}`, 200);

    const names = new Map<string, Names>();
    const changeRecs = new Map<string, any[]>();
    for (const c of changes) {
      const id = nz(c.employeeId) ?? nz(c.employeeID);
      if (!id) continue;
      if (!names.has(id)) names.set(id, { first: nz(c.firstName), preferred: nz(c.preferredName), last: nz(c.lastName) });
      changeRecs.set(id, [...(changeRecs.get(id) ?? []), c]);
    }
    const ids = [...names.keys()];
    log(`window ${iso(windowStart)} -> ${iso(windowEnd)}: ${changes.length} change records, ${ids.length} employees`);

    const c = await collectEmployees(ids, names, getAll, termMap, cutoff, log);

    let events: number | null = null;
    let contactsUpdated = 0, contactsRemoved = 0;
    if (c.done.length > 0) {
      await store.replaceEmployees(c.done, c.employment, c.jobHistory);
      events = await store.rebuildEvents(c.done);
      if (opts.contacts) {
        const upserts: ContactRow[] = []; const removes: string[] = [];
        for (const id of c.done) {
          const rows = c.employment.filter(e => e.employee_id === id);
          if (!isActiveOrLeave(rows)) { removes.push(id); continue; }
          // Current staff are always upserted, even with no contact details: the store clears their old details but
          // keeps the birthday from the nightly (this feed has none), and drops the row only if nothing is left.
          upserts.push(extractContact(id, [...(changeRecs.get(id) ?? []), ...(c.employmentRaw.get(id) ?? [])], opts.contacts));
        }
        await store.upsertContacts(upserts, removes);
        contactsUpdated = upserts.length; contactsRemoved = removes.length;
      }
    }

    const status = c.failed.length > 0 ? "partial" : "succeeded";
    await store.finishRun(runId, status, { employees: c.done.length, ukgCalls: calls, events: events ?? undefined },
      c.failed.length ? `${c.failed.length} employee(s) failed; they will be retried by the next run's overlapping window` : undefined);

    return {
      status, windowStart: iso(windowStart), windowEnd: iso(windowEnd), changeRecords: changes.length, employeesChanged: ids.length,
      employeesInScope: c.done.length, employeesOutOfScope: c.outOfScope, employeesFailed: c.failed.length,
      jobHistoryRows: c.jobHistory.length, eventsRebuilt: events, ukgCalls: calls,
      contactsUpdated, contactsRemoved
    } as SyncResult;
  } catch (e: any) {
    const msg = String(e?.message ?? "error").replace(/\?.*$/, "");
    await store.finishRun(runId, "failed", { employees: 0, ukgCalls: calls }, msg).catch(() => {});
    return { status: "failed", windowStart: iso(windowStart), windowEnd: iso(windowEnd), ukgCalls: calls, message: msg };
  }
}

// ---------------- nightly ----------------
export interface NightlyResult {
  status: "succeeded" | "partial" | "failed" | "skipped";
  snapshotDate?: string; activeOrLeave?: number; snapshotRows?: number;
  newEmployees?: number; noLongerActive?: number; employeesChanged?: number; employeesFailed?: number;
  contactsStored?: number; purged?: number | null; hoursSinceIntradaySuccess?: number | null;
  staleAlert?: boolean; ukgCalls?: number; message?: string;
}

/*
  Nightly:
   1. Employment details for status A and L (filtered pages) -> today's snapshot.
   2. Person details (all pages) -> names + contacts (+ birth month/day, never the year) for active / on-leave employees.
      Everything else is discarded.
   3. Compared with the database before anything is overwritten: employees active in the database but no longer A/L in
      UKG (missed terminations), A/L employees the database has never seen, and employees whose status, district, store,
      job or FT/PT differs (changes the intraday sync missed) -> full refresh (employment + job history + events) for
      just those. Everyone else's current rows (with names) are refreshed from step 1.
   4. Contacts: full replace (active / on-leave only), so leavers' contact details are removed.
   5. 1st of the month (Toronto): purge employees terminated more than the lookback ago.
   6. Stale check: no successful intraday sync in 24 hours -> alert.
*/
export async function runNightly(store: HubStore, ukg: UkgSource,
                                 opts: SyncOptions & { contacts: ContactConfig; storeBirthday?: boolean }): Promise<NightlyResult> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const cutoff = cutoffFor(now, opts.lookbackMonths);
  const snapshotDate = torontoDate(now);
  if (await store.isRunning("nightly")) return { status: "skipped", message: "Another nightly run is in progress" };

  let calls = 0;
  const getAll = async <T>(path: string, perPage: number) => {
    const rows = await ukg.getAll<T>(path, perPage);
    calls += Math.floor(rows.length / perPage) + 1;
    return rows;
  };

  const runId = await store.startRun("nightly", null, now);
  try {
    const termMap = await store.termCodes();

    // 1-2. UKG: active + leave employment rows, and person details (names + contacts)
    const empRaw = [
      ...(await getAll<any>(`/personnel/v1/employee-employment-details?employeeStatusCode=A`, 200)),
      ...(await getAll<any>(`/personnel/v1/employee-employment-details?employeeStatusCode=L`, 200))
    ].filter(r => ["A", "L"].includes(String(r.employeeStatusCode ?? "").toUpperCase()));
    const activeIds = new Set(empRaw.map(r => nz(r.employeeID)!).filter(Boolean));
    if (activeIds.size === 0) throw new Error("UKG returned no active or on-leave employees - nothing changed");

    const people = await getAll<any>(`/personnel/v1/person-details`, 200);
    const names = new Map<string, Names>();
    const personById = new Map<string, any>();
    for (const p of people) {
      const id = nz(p.employeeId) ?? nz(p.employeeID);
      if (!id || names.has(id)) continue;
      names.set(id, { first: nz(p.firstName), preferred: nz(p.preferredName), last: nz(p.lastName) });
      if (activeIds.has(id)) personById.set(id, p);           // keep person records only for current staff
    }
    log(`nightly ${snapshotDate}: ${activeIds.size} active/leave employees, ${people.length} person records read`);

    const empById = new Map<string, any[]>();
    for (const r of empRaw) { const id = nz(r.employeeID)!; empById.set(id, [...(empById.get(id) ?? []), r]); }
    const employment = empRaw.map(r => mapEmployment(r, names.get(nz(r.employeeID)!), termMap));

    // 1. snapshot
    const snap: SnapshotRow[] = employment.map(e => ({
      employee_id: e.employee_id, company_id: e.company_id, employee_status: e.employee_status!,
      org_level1: e.org_level1, org_level2: e.org_level2, job_code: e.job_code, full_or_part_time: e.full_or_part_time
    }));
    await store.writeSnapshot(snapshotDate, snap);

    // 3. who needs a full refresh, decided against the database BEFORE the current rows are overwritten:
    //    missed terminations, never-seen employees, and status / store / job / FT-PT changes the intraday sync missed
    const db = await store.currentEmployment();
    const dbActive = new Set(db.filter(r => r.employee_status === "A" || r.employee_status === "L").map(r => r.employee_id));
    const known = new Set(db.map(r => r.employee_id));
    const noLongerActive = [...dbActive].filter(id => !activeIds.has(id));
    const unseen = [...activeIds].filter(id => !known.has(id));
    const changed = changedEmployees(employment, db);
    const refreshIds = [...new Set([...noLongerActive, ...unseen, ...changed])];
    if (refreshIds.length) log(`refreshing ${refreshIds.length}: ${noLongerActive.length} no longer active, ${unseen.length} new, ${changed.length} changed`);

    // refresh current rows (with names) for everyone else. Employees being refreshed get theirs from the full refresh;
    // if that fails, their old row stays, so the next night finds the difference again and retries.
    const refreshing = new Set(refreshIds);
    const rest = employment.filter(e => !refreshing.has(e.employee_id));
    if (rest.length) await store.upsertEmployment(rest);

    let failed = 0;
    if (refreshIds.length) {
      const c = await collectEmployees(refreshIds, names, getAll, termMap, cutoff, log);
      if (c.done.length) { await store.replaceEmployees(c.done, c.employment, c.jobHistory); await store.rebuildEvents(c.done); }
      failed = c.failed.length;
    }

    // 4. contacts: full replace, current staff only
    const contacts: ContactRow[] = [];
    for (const id of activeIds) {
      const contact = extractContact(id, [personById.get(id), ...(empById.get(id) ?? [])].filter(Boolean), opts.contacts);
      if (opts.storeBirthday) {
        const b = extractBirthday(personById.get(id)?.dateOfBirth);    // month + day only; the year is never kept
        contact.birth_month = b.month; contact.birth_day = b.day;
      }
      if (hasAnyContact(contact)) contacts.push(contact);
    }
    await store.replaceAllContacts(contacts);

    // 5. monthly purge
    const purged = snapshotDate.endsWith("-01") ? await store.purge(opts.lookbackMonths) : null;

    // 6. stale check
    const hours = await store.hoursSinceIntradaySuccess();
    const staleAlert = hours === null || hours > 24;
    if (staleAlert) log(`ALERT: no successful intraday sync in ${hours === null ? "ever" : Math.round(hours) + " hours"}`);

    const status = failed > 0 ? "partial" : "succeeded";
    await store.finishRun(runId, status, { employees: activeIds.size, ukgCalls: calls },
      failed ? `${failed} employee refresh(es) failed` : (staleAlert ? "Stale intraday sync" : undefined));
    return {
      status, snapshotDate, activeOrLeave: activeIds.size, snapshotRows: snap.length, newEmployees: unseen.length,
      noLongerActive: noLongerActive.length, employeesChanged: changed.length, employeesFailed: failed, contactsStored: contacts.length, purged,
      hoursSinceIntradaySuccess: hours === null ? null : Math.round(hours * 10) / 10, staleAlert, ukgCalls: calls
    };
  } catch (e: any) {
    const msg = String(e?.message ?? "error").replace(/\?.*$/, "");
    await store.finishRun(runId, "failed", { employees: 0, ukgCalls: calls }, msg).catch(() => {});
    return { status: "failed", snapshotDate, ukgCalls: calls, message: msg };
  }
}
