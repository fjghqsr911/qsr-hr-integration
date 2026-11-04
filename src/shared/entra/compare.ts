import { createHash } from "crypto";

/*
  Pure comparison of what UKG says an employee should look like in Entra with what the Entra snapshot says.
  No I/O: the sync hands in the directory row, the linked user, the open proposals, the rejected hashes, the rules and
  the group memberships, and gets back the proposals to upsert, the open proposals that are now stale, and the
  rejections that still suppress a live difference. Values compared here are job titles, store names and cities:
  nothing sensitive.
*/

export type ProposalKind = "attribute" | "group_add" | "group_remove" | "disable" | "enable";
export type AttributeField = "jobTitle" | "department" | "officeLocation";
export type ProposalStatus = "proposed" | "accepted" | "applying" | "applied" | "rejected" | "stale" | "failed" | "blocked";
export const OPEN_STATUSES: readonly ProposalStatus[] = ["proposed", "accepted", "applying", "blocked"];
export const ATTRIBUTE_FIELDS: readonly AttributeField[] = ["jobTitle", "department", "officeLocation"];
export const HEAD_OFFICE = "Head Office";
/** org_level2 codes that are stores (T00037, W06302, T22446); anything else (HR, FIN, OPS ...) is head office. */
export const STORE_CODE = /^[A-Z]\d{4,}$/;
export const isStoreCode = (code: string | null | undefined) => STORE_CODE.test(String(code ?? "").trim().toUpperCase());

export interface DirectoryRow {
  employeeId: string; employeeNumber: string | null; companyId: string | null; companyCount: number; employeeStatus: string | null;
  displayName: string | null; district: string | null; store: string | null; storeName: string | null; storeCity: string | null;
  department: string | null; jobCode: string | null; jobTitle: string | null; fullOrPartTime: string | null;
  originalHireDate: string | null; lastHireDate: string | null; terminationDate: string | null; dateLastWorked: string | null;
  workEmail: string | null; updatedUtc: string | null;
}

export interface EntraUserSnapshot {
  objectId: string; upn: string | null; mail: string | null; displayName: string | null; jobTitle: string | null;
  department: string | null; officeLocation: string | null; accountEnabled: boolean; employeeIdAttr: string | null;
  userType: string | null; onpremSynced: boolean; missingSinceUtc: string | null;
}

export interface GroupSnapshot {
  objectId: string; displayName: string | null; groupTypes: string[]; securityEnabled: boolean; mailEnabled: boolean;
  roleAssignable: boolean; managed: boolean;
}

export interface Rule {
  ruleId: number; groupId: string; name: string; jobCodes: string | null; districts: string | null; stores: string | null;
  companies: string | null; statuses: string; mode: "add_only" | "add_and_remove"; enabled: boolean;
}

export interface OpenProposal { proposalId: number; status: ProposalStatus; dedupeHash: string; employeeId: string; }

export interface Desired {
  jobTitle: string | null;                 // null = leave alone
  department: string | null;               // null = store without a ref.stores row yet: leave alone
  officeLocation: string | null;           // null = leave alone (no city known)
  accountEnabled: boolean;
  dueDate: string | null;                  // disable date for a termination (date_last_worked, else termination_date)
}

export interface ProposalCandidate {
  employeeId: string; userObjectId: string; kind: ProposalKind; field: AttributeField | null; groupId: string | null;
  currentValue: string | null; proposedValue: string | null; dueDate: string | null; source: "compare" | "rule";
  eventId: number | null; ruleId: number | null; status: "proposed" | "blocked"; dedupeHash: string;
}

export interface DiffInput {
  employee: DirectoryRow;
  desired: Desired;
  user: EntraUserSnapshot | null;          // null = unlinked
  openProposals: OpenProposal[];           // this employee's open proposals
  rejections: Set<string>;                 // dedupe hashes (hex) of rejected changes
  rules: Rule[];
  groups: Map<string, GroupSnapshot>;      // by object id
  memberships: Set<string>;                // group ids the user is a member of (managed groups only)
  eventId: number | null;                  // latest workforce event for context
  today: string;                           // yyyy-mm-dd, Toronto
}

export interface DiffResult {
  create: ProposalCandidate[];             // upsert (new or still current); status proposed
  blocked: ProposalCandidate[];            // same, status blocked (on-prem synced account)
  stale: number[];                         // open proposal ids whose difference is gone
  suppressed: string[];                    // rejected hashes that still match a live difference (keep the rejection)
}

const ACTIVE = new Set(["A", "L"]);
const norm = (v: string | null | undefined) => (v === null || v === undefined ? "" : String(v).trim());
const same = (a: string | null | undefined, b: string | null | undefined) => norm(a).toLowerCase() === norm(b).toLowerCase();

/** Today in Toronto as yyyy-mm-dd. */
export function torontoToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** sha256 of employee|kind|field|group|value as hex; the open-proposal uniqueness key. */
export function dedupeHash(employeeId: string, kind: ProposalKind, field: string | null, groupId: string | null, proposedValue: string | null): string {
  return createHash("sha256").update([employeeId, kind, field ?? "", groupId ?? "", proposedValue ?? ""].join("|")).digest("hex");
}

/** What UKG wants the Entra user to look like. */
export function computeDesired(row: DirectoryRow, opts: { headOfficeCity: string | null }): Desired {
  const atStore = isStoreCode(row.store);
  const status = norm(row.employeeStatus).toUpperCase();
  const active = ACTIVE.has(status);
  return {
    jobTitle: norm(row.jobTitle) || null,
    department: atStore ? (norm(row.storeName) || null) : HEAD_OFFICE,
    officeLocation: atStore ? (norm(row.storeCity) || null) : (opts.headOfficeCity ? norm(opts.headOfficeCity) : null),
    accountEnabled: active,
    dueDate: status === "T" ? (row.dateLastWorked ?? row.terminationDate ?? null) : null
  };
}

const csvSet = (csv: string | null | undefined): Set<string> | null => {
  const items = norm(csv).split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  return items.length ? new Set(items) : null;
};
const inCsv = (csv: string | null | undefined, value: string | null | undefined): boolean => {
  const set = csvSet(csv);
  return set === null || set.has(norm(value).toUpperCase());
};

/** True when the rule's predicates (all of them; NULL = any) match the employee. */
export function ruleMatches(rule: Rule, row: DirectoryRow): boolean {
  return inCsv(rule.statuses || "A,L", row.employeeStatus) && inCsv(rule.jobCodes, row.jobCode) && inCsv(rule.districts, row.district)
      && inCsv(rule.stores, row.store) && inCsv(rule.companies, row.companyId);
}

/** A group the rules and the manual member endpoints may target: managed, not dynamic, not role-assignable. */
export function groupManageable(g: GroupSnapshot | undefined): boolean {
  return !!g && g.managed && !g.roleAssignable && !g.groupTypes.some(t => t.toLowerCase() === "dynamicmembership");
}

export function diff(input: DiffInput): DiffResult {
  const { employee, desired, user, openProposals, rejections, rules, groups, memberships, eventId, today } = input;
  const result: DiffResult = { create: [], blocked: [], stale: [], suppressed: [] };
  const employeeId = employee.employeeId;
  const status = norm(employee.employeeStatus).toUpperCase();

  if (!user) {                                                            // unlinked: nothing to propose, open rows no longer apply
    result.stale = openProposals.filter(p => p.status !== "applying").map(p => p.proposalId);
    return result;
  }

  const candidates: ProposalCandidate[] = [];
  const add = (c: Omit<ProposalCandidate, "dedupeHash" | "status" | "employeeId" | "userObjectId" | "eventId">) =>
    candidates.push({ ...c, employeeId, userObjectId: user.objectId, eventId, status: "proposed", dedupeHash: dedupeHash(employeeId, c.kind, c.field, c.groupId, c.proposedValue) });

  const active = ACTIVE.has(status);
  if (active) {
    const current: Record<AttributeField, string | null> = { jobTitle: user.jobTitle, department: user.department, officeLocation: user.officeLocation };
    for (const field of ATTRIBUTE_FIELDS) {
      const want = desired[field];
      if (want === null || want === undefined) continue;                      // leave alone
      if (same(want, current[field])) continue;
      add({ kind: "attribute", field, groupId: null, currentValue: norm(current[field]) || null, proposedValue: want, dueDate: null, source: "compare", ruleId: null });
    }
    if (!user.accountEnabled) add({ kind: "enable", field: null, groupId: null, currentValue: "false", proposedValue: "true", dueDate: null, source: "compare", ruleId: null });
  } else if (status === "T" && user.accountEnabled) {
    add({ kind: "disable", field: null, groupId: null, currentValue: "true", proposedValue: "false", dueDate: desired.dueDate ?? today, source: "compare", ruleId: null });
  }

  // rules: per group, should the employee be a member?
  const byGroup = new Map<string, Rule[]>();
  for (const r of rules) {
    if (!r.enabled || !groupManageable(groups.get(r.groupId))) continue;
    const list = byGroup.get(r.groupId) ?? []; list.push(r); byGroup.set(r.groupId, list);
  }
  for (const [groupId, groupRules] of byGroup) {
    const matching = groupRules.find(r => ruleMatches(r, employee));
    const member = memberships.has(groupId);
    if (matching && !member) {
      add({ kind: "group_add", field: null, groupId, currentValue: null, proposedValue: null, dueDate: null, source: "rule", ruleId: matching.ruleId });
    } else if (!matching && member) {
      const remover = groupRules.find(r => r.mode === "add_and_remove");
      // a leaver keeps group access until the last shift: same due date as the disable
      if (remover) add({ kind: "group_remove", field: null, groupId, currentValue: null, proposedValue: null, dueDate: status === "T" ? (desired.dueDate ?? today) : null, source: "rule", ruleId: remover.ruleId });
    }
  }

  const live = new Set<string>();
  for (const c of candidates) {
    live.add(c.dedupeHash);
    if (rejections.has(c.dedupeHash)) { result.suppressed.push(c.dedupeHash); continue; }
    if (user.onpremSynced) result.blocked.push({ ...c, status: "blocked" });
    else result.create.push(c);
  }
  result.stale = openProposals.filter(p => p.status !== "applying" && !live.has(p.dedupeHash)).map(p => p.proposalId);
  return result;
}
