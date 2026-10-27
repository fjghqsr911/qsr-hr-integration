import { ukgGet } from "./ukg";

/*
  Exact-match lookups by UKG system employeeId (e.g. "EWLTH200NRY0").
  If UKG ignores a filter, the exact-match check means we return 404 - never another employee.
*/

export const ID_PATTERN = /^[A-Za-z0-9]{1,20}$/;
/**
 * Store codes in orgLevel2: brand letter + 5 digits.
 *   T = Tim Hortons, W = Wendy's.
 *   Internal store number = the 5 digits without leading zeros (T00913 -> 913, T22446 -> 22446).
 *   Brand, TDL number and other store attributes live in the Location Master, keyed by this code.
 */
export const STORE_PATTERN = /^[TW]\d{5}$/i;

const same = (a: any, b: string) => String(a ?? "").toUpperCase() === b.toUpperCase();

export interface Lookup<T> { record: T | null; filterIgnored: boolean; }

/** Employment details (job, store, status, dates, pay). Prefers the home-company record. */
export async function findEmployment(id: string): Promise<Lookup<any>> {
  const rows = await ukgGet<any[]>(
    `/personnel/v1/employee-employment-details?employeeId=${encodeURIComponent(id)}&per_Page=100`);
  const list = Array.isArray(rows) ? rows : [];
  const matches = list.filter(r => same(r.employeeID, id));
  return {
    record: matches.find(r => r.isHomeCompany) ?? matches[0] ?? null,
    filterIgnored: list.length > 1 && matches.length === 0
  };
}

/** Person details (SIN, DOB, address, personal contact). */
export async function findPerson(id: string): Promise<Lookup<any>> {
  const rows = await ukgGet<any[]>(
    `/personnel/v1/person-details?employeeId=${encodeURIComponent(id)}&per_Page=100`);
  const list = Array.isArray(rows) ? rows : [];
  const matches = list.filter(r => same(r.employeeId, id));
  return { record: matches[0] ?? null, filterIgnored: list.length > 1 && matches.length === 0 };
}

export function storeFields(orgLevel2: string | null | undefined) {
  const code = String(orgLevel2 ?? "").toUpperCase();
  const isStore = STORE_PATTERN.test(code);
  return {
    store: isStore ? code : null,                                        // join key to the Location Master; null = head office
    storeNumber: isStore ? String(parseInt(code.slice(1), 10)) : null    // internal number, e.g. T22446 -> 22446
  };
}

/** "123456789" -> "***-***-789". Null if empty. */
export function maskSin(raw: string | null | undefined): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return `***-***-${digits.slice(-3).padStart(3, "*")}`;
}

/** "123456789" -> "123-456-789" (full reveal; Sensitive.Admin + Reveal scope only). */
export function formatSin(raw: string | null | undefined): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.length === 9 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : digits;
}

export const dateOnly = (v: any) => (v ? String(v).slice(0, 10) : null);
