import { DirectoryRow, EntraUserSnapshot } from "./compare";

/*
  Pure linking of employees to Entra users: lower(work_email) = lower(upn) or lower(mail). Manual links always win.
  Existing links persist (the hub purges the work email at termination, so the link is the only key afterwards);
  the sync only adds auto links for employees that have none, and reports what it could not resolve as link issues.
*/

export type LinkMethod = "matched_email" | "manual";
export type IssueKind = "duplicate_email" | "email_not_in_entra" | "user_without_employee" | "email_changed" | "user_missing";

export interface LinkRow { employeeId: string; userObjectId: string; method: LinkMethod; matchedEmail: string | null; }
export interface AutoLink { employeeId: string; userObjectId: string; matchedEmail: string; }
export interface LinkIssue { employeeId: string | null; userObjectId: string | null; kind: IssueKind; detail: string | null; }

export interface LinkResult {
  autoLinks: AutoLink[];          // the complete set of auto links after this sync (existing kept + new)
  issues: LinkIssue[];
}

const lower = (v: string | null | undefined) => (v === null || v === undefined ? "" : String(v).trim().toLowerCase());

export function computeLinks(employees: DirectoryRow[], users: EntraUserSnapshot[], existing: LinkRow[]): LinkResult {
  const issues: LinkIssue[] = [];
  const present = new Map<string, EntraUserSnapshot>();                      // users in the snapshot that are not missing
  const byEmail = new Map<string, Set<string>>();                             // lower(upn | mail) -> user ids
  for (const u of users) {
    if (u.missingSinceUtc) continue;
    present.set(u.objectId, u);
    for (const e of [lower(u.upn), lower(u.mail)]) {
      if (!e) continue;
      const set = byEmail.get(e) ?? new Set<string>(); set.add(u.objectId); byEmail.set(e, set);
    }
  }

  const linkByEmployee = new Map<string, LinkRow>(), linkByUser = new Map<string, LinkRow>();
  for (const l of existing) { linkByEmployee.set(l.employeeId, l); linkByUser.set(l.userObjectId, l); }

  const employeesByEmail = new Map<string, string[]>();
  for (const e of employees) { const em = lower(e.workEmail); if (em) employeesByEmail.set(em, [...(employeesByEmail.get(em) ?? []), e.employeeId]); }

  const autoLinks: AutoLink[] = [];
  const takenNow = new Set<string>(linkByUser.keys());                          // users already linked, plus those linked in this pass

  // existing links first: keep them all, report problems
  for (const l of existing) {
    const u = present.get(l.userObjectId);
    if (!u) { issues.push({ employeeId: l.employeeId, userObjectId: l.userObjectId, kind: "user_missing", detail: `linked Entra user is no longer in the snapshot (${l.method})` }); }
    if (l.method === "matched_email") autoLinks.push({ employeeId: l.employeeId, userObjectId: l.userObjectId, matchedEmail: l.matchedEmail ?? "" });
  }

  for (const emp of employees) {
    const email = lower(emp.workEmail);
    const link = linkByEmployee.get(emp.employeeId);
    if (link) {
      const u = present.get(link.userObjectId);
      if (u && email && link.method !== "manual" && lower(u.upn) !== email && lower(u.mail) !== email)   // a manual link exists because the emails differ
        issues.push({ employeeId: emp.employeeId, userObjectId: link.userObjectId, kind: "email_changed", detail: `work email no longer matches the linked account (${link.method})` });
      continue;                                                                 // linked: nothing else to do
    }
    if (!email) continue;                                                       // no work email and no link: not an Entra person
    const sharers = employeesByEmail.get(email) ?? [];
    if (sharers.length > 1) { issues.push({ employeeId: emp.employeeId, userObjectId: null, kind: "duplicate_email", detail: `${sharers.length} employees share this work email` }); continue; }
    const matches = [...(byEmail.get(email) ?? [])];
    if (matches.length === 0) { issues.push({ employeeId: emp.employeeId, userObjectId: null, kind: "email_not_in_entra", detail: null }); continue; }
    if (matches.length > 1) { issues.push({ employeeId: emp.employeeId, userObjectId: null, kind: "duplicate_email", detail: `${matches.length} Entra users carry this email` }); continue; }
    const userId = matches[0];
    if (takenNow.has(userId)) {
      const other = linkByUser.get(userId);
      issues.push({ employeeId: emp.employeeId, userObjectId: userId, kind: "duplicate_email", detail: `Entra user already linked to employee ${other?.employeeId ?? "(this sync)"}` });
      continue;
    }
    takenNow.add(userId);
    autoLinks.push({ employeeId: emp.employeeId, userObjectId: userId, matchedEmail: email });
  }

  for (const u of present.values()) {
    if (!takenNow.has(u.objectId)) issues.push({ employeeId: null, userObjectId: u.objectId, kind: "user_without_employee", detail: null });
  }
  return { autoLinks, issues };
}
