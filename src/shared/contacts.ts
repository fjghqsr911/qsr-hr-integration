/*
  Contact details from UKG records -> { personal_email, work_email, work_phone, company_phone, birth_month, birth_day }.
  Emails are classified by domain (work domains = config), so it does not matter which UKG field holds which.
  Birthday = month + day only; the year, full date of birth and age are never kept. Values are never logged.
*/
export interface ContactRow {
  employee_id: string;
  personal_email: string | null;
  work_email: string | null;
  work_phone: string | null;
  company_phone: string | null;
  birth_month: number | null;     // 1-12; both birth fields filled or both null
  birth_day: number | null;       // 1-31, valid for the month (Feb 29 allowed)
}

export interface ContactConfig {
  workDomains: string[];
  emailFields: string[];
  workPhoneFields: string[];
  companyPhoneFields: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v: any): string | null => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());

/** Case-insensitive property lookup (UKG field casing varies between endpoints). */
function getField(rec: any, name: string): any {
  if (!rec) return undefined;
  if (name in rec) return rec[name];
  const k = Object.keys(rec).find(x => x.toLowerCase() === name.toLowerCase());
  return k ? rec[k] : undefined;
}

function phoneWithExt(rec: any, field: string): string | null {
  const p = clean(getField(rec, field));
  if (!p) return null;
  // employment-details splits the extension out
  const ext = field.toLowerCase() === "workphonenumber" ? clean(getField(rec, "workPhoneExtension")) : null;
  return ext ? `${p} x${ext}` : p;
}

/**
 * Builds a contact row from one or more UKG records for the same employee (e.g. change record + person details
 * + employment details). Earlier records win for each field.
 */
export function extractContact(employeeId: string, records: any[], cfg: ContactConfig): ContactRow {
  const emails: string[] = [];
  for (const rec of records) for (const f of cfg.emailFields) {
    const e = clean(getField(rec, f));
    if (e && EMAIL.test(e) && !emails.some(x => x.toLowerCase() === e.toLowerCase())) emails.push(e);
  }
  const isWork = (e: string) => cfg.workDomains.some(d => e.toLowerCase().endsWith("@" + d) || e.toLowerCase().endsWith("." + d));
  const firstPhone = (fields: string[]) => {
    for (const rec of records) for (const f of fields) { const p = phoneWithExt(rec, f); if (p) return p; }
    return null;
  };
  return {
    employee_id: employeeId,
    personal_email: emails.find(e => !isWork(e)) ?? null,
    work_email: emails.find(e => isWork(e)) ?? null,
    work_phone: firstPhone(cfg.workPhoneFields),
    company_phone: cfg.companyPhoneFields.length ? firstPhone(cfg.companyPhoneFields) : null,
    birth_month: null, birth_day: null               // the change feed has no date of birth; the nightly sets these
  };
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];   // Feb 29 allowed (no year to check against)

/**
 * Month + day from a UKG dateOfBirth ("1987-07-14T00:00:00" or a Date). The year is discarded here and never returned.
 * Strings are parsed as text (no Date conversion, so time zones cannot shift the day). Invalid or missing -> both null.
 */
export function extractBirthday(value: any): { month: number | null; day: number | null } {
  let month: number, day: number;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return { month: null, day: null };
    month = value.getUTCMonth() + 1; day = value.getUTCDate();
  } else if (typeof value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (!m) return { month: null, day: null };
    month = Number(m[2]); day = Number(m[3]);
  } else {
    return { month: null, day: null };
  }
  if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]) return { month: null, day: null };
  return { month, day };
}

export const hasAnyContact = (c: ContactRow) =>
  !!(c.personal_email || c.work_email || c.work_phone || c.company_phone || (c.birth_month && c.birth_day));
