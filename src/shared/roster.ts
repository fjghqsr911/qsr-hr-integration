import { storeFields } from "./employees";

/* Roster filters: all optional, comma-separated. Codes are validated; nothing user-supplied is concatenated into SQL. */
export interface RosterFilters {
  jobCodes: string[] | null; stores: string[] | null; districts: string[] | null;
  companies: string[] | null; statuses: string[];
}

const CODE = /^[A-Z0-9]{1,20}$/;

function parseList(raw: string | null, name: string, max = 100): { list: string[] | null; error?: string } {
  if (raw === null || raw.trim() === "") return { list: null };
  const list = [...new Set(raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean))];
  if (list.length > max) return { list: null, error: `${name}: at most ${max} values` };
  const bad = list.find(v => !CODE.test(v));
  if (bad) return { list: null, error: `${name}: invalid value '${bad.slice(0, 20)}'` };
  return { list };
}

export function parseRosterFilters(q: URLSearchParams): { filters?: RosterFilters; error?: string } {
  const jobCodes = parseList(q.get("jobCodes"), "jobCodes");
  const stores = parseList(q.get("store") ?? q.get("stores"), "store");
  const districts = parseList(q.get("district") ?? q.get("districts"), "district");
  const companies = parseList(q.get("company") ?? q.get("companies"), "company");
  const statusRaw = parseList(q.get("status"), "status", 2);
  for (const r of [jobCodes, stores, districts, companies, statusRaw]) if (r.error) return { error: r.error };
  const statuses = statusRaw.list ?? ["A", "L"];
  if (statuses.some(s => s !== "A" && s !== "L")) return { error: "status: only A (active) and/or L (leave)" };
  return { filters: { jobCodes: jobCodes.list, stores: stores.list, districts: districts.list, companies: companies.list, statuses } };
}

/* Parameterised query against rpt.v_current_roster (filters passed as JSON arrays). */
export const ROSTER_SQL = `
SELECT r.employee_id, r.employee_number, r.company_id, r.is_home_company, r.employee_status,
       r.first_name, r.preferred_name, r.last_name, r.display_name,
       r.district, r.store, r.job_code, r.job_description,
       r.date_in_job, r.status_start_date, r.original_hire_date, r.last_hire_date,
       r.is_future_start, r.full_or_part_time
FROM rpt.v_current_roster r
WHERE r.employee_status IN (SELECT value FROM OPENJSON(@statuses))
  AND (@jobCodes  IS NULL OR r.job_code   IN (SELECT value FROM OPENJSON(@jobCodes)))
  AND (@stores    IS NULL OR r.store      IN (SELECT value FROM OPENJSON(@stores)))
  AND (@districts IS NULL OR r.district   IN (SELECT value FROM OPENJSON(@districts)))
  AND (@companies IS NULL OR r.company_id IN (SELECT value FROM OPENJSON(@companies)))
ORDER BY r.store, r.job_code, r.last_name, r.first_name;

SELECT COALESCE(
  (SELECT MAX(window_end_utc) FROM stage.sync_runs WHERE run_type = 'intraday' AND status = 'succeeded'),
  (SELECT MAX(finished_utc)   FROM stage.sync_runs WHERE run_type = 'backfill' AND status = 'succeeded')) AS data_as_of_utc;`;

const d = (v: any): string | null => (v ? new Date(v).toISOString().slice(0, 10) : null);

export function mapRosterRow(r: any) {
  const s = storeFields(r.store);
  return {
    employeeId: r.employee_id,
    employeeNumber: r.employee_number,
    displayName: r.display_name,
    firstName: r.first_name,
    preferredName: r.preferred_name,
    lastName: r.last_name,
    companyId: r.company_id,
    isHomeCompany: r.is_home_company === null ? null : !!r.is_home_company,
    store: s.store,                       // null for head-office departments
    storeNumber: s.storeNumber,
    orgLevel2: r.store,                   // raw value (store code or department, e.g. HR)
    district: r.district,
    jobCode: r.job_code,
    jobDescription: r.job_description,
    status: r.employee_status,            // A = active, L = on leave
    isFutureStart: !!r.is_future_start,
    dateInJob: d(r.date_in_job),
    statusStartDate: d(r.status_start_date),
    originalHireDate: d(r.original_hire_date),
    lastHireDate: d(r.last_hire_date),
    fullOrPartTime: r.full_or_part_time
  };
}

/* Roster + contact details (sensitive tier). Same filters as the roster. */
export const ROSTER_CONTACTS_SQL = ROSTER_SQL
  .replace("r.is_future_start, r.full_or_part_time",
           "r.is_future_start, r.full_or_part_time, c.personal_email, c.work_email, c.work_phone, c.company_phone, c.birth_month, c.birth_day")
  .replace("FROM rpt.v_current_roster r", "FROM rpt.v_current_roster r LEFT JOIN stage.employee_contact c ON c.employee_id = r.employee_id");

export function mapRosterContactRow(r: any) {
  // birth month + day only (no year); both or neither
  const both = r.birth_month != null && r.birth_day != null;
  return { ...mapRosterRow(r), personalEmail: r.personal_email ?? null, workEmail: r.work_email ?? null,
           workPhone: r.work_phone ?? null, companyPhone: r.company_phone ?? null,
           birthMonth: both ? Number(r.birth_month) : null, birthDay: both ? Number(r.birth_day) : null };
}
