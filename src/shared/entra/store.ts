import { sql } from "../sql";
import { DirectoryRow, EntraUserSnapshot, GroupSnapshot, OpenProposal, OPEN_STATUSES, ProposalCandidate, ProposalStatus, Rule } from "./compare";
import { AutoLink, LinkIssue, LinkRow } from "./link";
import { GraphGroup, GraphUser } from "../graph";

/*
  EntraStore backed by sqldb-hrint (schema entra, provisioning/20): the Entra snapshot, employee links, proposals,
  rejections, rules and the sync run lock. Reads the hub through rpt.v_directory (work email is the only contact
  column it carries) and rpt.workforce_events for the event context. Runs are locked like deliveryStore.ts (30 min).
  Nothing here logs values; errors bubble up to the caller.
*/

/** The open statuses (compare.ts OPEN_STATUSES) as a SQL list, and the ones a sync or an admin action may turn stale (never a live applying row). */
export const OPEN_STATUS_LIST = OPEN_STATUSES.map(s => `'${s}'`).join(", ");
export const STALEABLE_STATUS_LIST = OPEN_STATUSES.filter(s => s !== "applying").map(s => `'${s}'`).join(", ");
/** An applying row older than this is stuck (crash between claim and finish): it may be claimed again or rejected. */
export const STUCK_APPLYING_MINUTES = 15;
const STUCK_SQL = `(status = 'applying' AND last_seen_utc < DATEADD(minute, -${STUCK_APPLYING_MINUTES}, SYSUTCDATETIME()))`;

export const PROPOSAL_COLUMNS = `proposal_id, employee_id, user_object_id, kind, field, group_id, current_value, proposed_value, due_date, source,
       event_id, rule_id, status, dedupe_hash, proposed_utc, last_seen_utc, decided_by, decided_utc, applied_utc, error`;
const INSERTED = PROPOSAL_COLUMNS.replace(/(\w+)/g, "inserted.$1");

export const PROPOSAL_SELECT_SQL = `SELECT ${PROPOSAL_COLUMNS} FROM entra.proposals WHERE proposal_id = @id;`;

/** proposed -> accepted. */
export const PROPOSAL_ACCEPT_SQL = `
UPDATE entra.proposals SET status = 'accepted', decided_by = @by, decided_utc = SYSUTCDATETIME(), error = NULL
OUTPUT ${INSERTED}
WHERE proposal_id = @id AND status = 'proposed';`;

/** proposed | accepted (or stuck applying) -> rejected; the rejection row follows. */
export const PROPOSAL_REJECT_SQL = `
UPDATE entra.proposals SET status = 'rejected', decided_by = @by, decided_utc = SYSUTCDATETIME()
OUTPUT ${INSERTED}
WHERE proposal_id = @id AND (status IN ('proposed', 'accepted') OR ${STUCK_SQL});`;

/** accepted (or stuck applying) -> applying, only when due; the claim is stamped so a stuck row can be told from a live one. */
export const PROPOSAL_CLAIM_SQL = `
UPDATE entra.proposals SET status = 'applying', error = NULL, last_seen_utc = SYSUTCDATETIME()
OUTPUT ${INSERTED}
WHERE proposal_id = @id AND (status = 'accepted' OR ${STUCK_SQL}) AND (due_date IS NULL OR due_date <= @today);`;

export const PROPOSAL_FINISH_SQL = `
UPDATE entra.proposals SET status = @status, applied_utc = CASE WHEN @status = 'applied' THEN SYSUTCDATETIME() ELSE applied_utc END,
       current_value = COALESCE(@currentValue, current_value), error = @error
OUTPUT ${INSERTED}
WHERE proposal_id = @id AND status = 'applying';`;

export const PROPOSALS_UPSERT_SQL = `
MERGE entra.proposals WITH (HOLDLOCK) AS t
USING (SELECT employeeId AS employee_id, userObjectId AS user_object_id, kind, field, groupId AS group_id, currentValue AS current_value,
              proposedValue AS proposed_value, dueDate AS due_date, source, eventId AS event_id, ruleId AS rule_id, status,
              CONVERT(binary(32), dedupeHash, 2) AS dedupe_hash
       FROM OPENJSON(@rows) WITH (employeeId varchar(20), userObjectId varchar(36), kind varchar(20), field varchar(20), groupId varchar(36),
                                  currentValue nvarchar(256), proposedValue nvarchar(256), dueDate date, source varchar(20), eventId bigint,
                                  ruleId int, status varchar(20), dedupeHash char(64))) AS s
   ON t.dedupe_hash = s.dedupe_hash AND t.status IN (${OPEN_STATUS_LIST})
WHEN MATCHED THEN UPDATE SET last_seen_utc = SYSUTCDATETIME(), current_value = s.current_value, due_date = s.due_date, event_id = s.event_id,
                             rule_id = s.rule_id, user_object_id = s.user_object_id,
                             status = CASE WHEN t.status IN ('proposed', 'blocked') THEN s.status ELSE t.status END
WHEN NOT MATCHED THEN INSERT (employee_id, user_object_id, kind, field, group_id, current_value, proposed_value, due_date, source, event_id, rule_id, status, dedupe_hash)
                      VALUES (s.employee_id, s.user_object_id, s.kind, s.field, s.group_id, s.current_value, s.proposed_value, s.due_date, s.source, s.event_id, s.rule_id, s.status, s.dedupe_hash)
OUTPUT $action AS merge_action;`;

export const PROPOSALS_STALE_SQL = `
UPDATE entra.proposals SET status = 'stale'
WHERE proposal_id IN (SELECT value FROM OPENJSON(@ids)) AND status IN (${STALEABLE_STATUS_LIST});
SELECT @@ROWCOUNT AS staled;`;

export const STALE_EMPLOYEE_PROPOSALS_SQL = `
UPDATE entra.proposals SET status = 'stale' WHERE employee_id = @employeeId AND status IN (${STALEABLE_STATUS_LIST});
SELECT @@ROWCOUNT AS staled;`;

/** A change done by hand (manual group member): any open proposal for the same change is now stale. */
export const STALE_BY_HASH_SQL = `
UPDATE entra.proposals SET status = 'stale'
WHERE dedupe_hash = CONVERT(binary(32), @hash, 2) AND proposal_id <> @exceptId AND status IN (${STALEABLE_STATUS_LIST});
SELECT @@ROWCOUNT AS staled;`;

export const USERS_UPSERT_SQL = `
MERGE entra.users WITH (HOLDLOCK) AS t
USING (SELECT * FROM OPENJSON(@rows) WITH (id varchar(36), userPrincipalName nvarchar(254), mail nvarchar(254), displayName nvarchar(256),
                                           jobTitle nvarchar(128), department nvarchar(128), officeLocation nvarchar(128), accountEnabled bit,
                                           employeeId nvarchar(64), userType varchar(20), onPremisesSyncEnabled bit)) AS s
   ON t.object_id = s.id
WHEN MATCHED THEN UPDATE SET upn = s.userPrincipalName, mail = s.mail, display_name = s.displayName, job_title = s.jobTitle, department = s.department,
                             office_location = s.officeLocation, account_enabled = s.accountEnabled, employee_id_attr = s.employeeId, user_type = s.userType,
                             onprem_synced = s.onPremisesSyncEnabled, fetched_utc = @fetchedUtc, missing_since_utc = NULL
WHEN NOT MATCHED THEN INSERT (object_id, upn, mail, display_name, job_title, department, office_location, account_enabled, employee_id_attr, user_type, onprem_synced, fetched_utc)
                      VALUES (s.id, s.userPrincipalName, s.mail, s.displayName, s.jobTitle, s.department, s.officeLocation, s.accountEnabled, s.employeeId, s.userType, s.onPremisesSyncEnabled, @fetchedUtc);`;

export const USERS_MARK_MISSING_SQL = `
UPDATE entra.users SET missing_since_utc = SYSUTCDATETIME() WHERE fetched_utc < @fetchedUtc AND missing_since_utc IS NULL;
SELECT @@ROWCOUNT AS marked;`;

export const GROUPS_UPSERT_SQL = `
MERGE entra.groups WITH (HOLDLOCK) AS t
USING (SELECT * FROM OPENJSON(@rows) WITH (id varchar(36), displayName nvarchar(256), description nvarchar(1024), groupTypes nvarchar(200),
                                           securityEnabled bit, mailEnabled bit, isAssignableToRole bit)) AS s
   ON t.object_id = s.id
WHEN MATCHED THEN UPDATE SET display_name = s.displayName, description = s.description, group_types = s.groupTypes, security_enabled = s.securityEnabled,
                             mail_enabled = s.mailEnabled, role_assignable = s.isAssignableToRole, fetched_utc = @fetchedUtc
WHEN NOT MATCHED THEN INSERT (object_id, display_name, description, group_types, security_enabled, mail_enabled, role_assignable, fetched_utc)
                      VALUES (s.id, s.displayName, s.description, s.groupTypes, s.securityEnabled, s.mailEnabled, s.isAssignableToRole, @fetchedUtc);
/* groups Entra no longer lists: dropped unless managed or targeted by a rule */
DELETE FROM entra.group_members WHERE group_id IN (SELECT object_id FROM entra.groups WHERE fetched_utc < @fetchedUtc AND managed = 0 AND NOT EXISTS (SELECT 1 FROM entra.rules r WHERE r.group_id = entra.groups.object_id));
DELETE FROM entra.groups WHERE fetched_utc < @fetchedUtc AND managed = 0 AND NOT EXISTS (SELECT 1 FROM entra.rules r WHERE r.group_id = entra.groups.object_id);`;

export const GROUP_MEMBERS_REPLACE_SQL = `
SET XACT_ABORT ON;
BEGIN TRANSACTION;
DELETE FROM entra.group_members WHERE group_id = @groupId;
INSERT INTO entra.group_members (group_id, user_id, fetched_utc) SELECT @groupId, value, @fetchedUtc FROM OPENJSON(@ids);
UPDATE entra.groups SET member_count = (SELECT COUNT(*) FROM entra.group_members WHERE group_id = @groupId), members_fetched_utc = @fetchedUtc WHERE object_id = @groupId;
COMMIT TRANSACTION;`;

export const LINKS_REPLACE_AUTO_SQL = `
/* auto links the sync no longer wants (never a manual one) */
DELETE FROM entra.links WHERE method = 'matched_email'
  AND NOT EXISTS (SELECT 1 FROM OPENJSON(@rows) WITH (employeeId varchar(20), userObjectId varchar(36)) s WHERE s.employeeId = entra.links.employee_id AND s.userObjectId = entra.links.user_object_id);
/* new auto links: only for employees without a link, to users nobody is linked to */
INSERT INTO entra.links (employee_id, user_object_id, method, matched_email, linked_by)
SELECT s.employeeId, s.userObjectId, 'matched_email', s.matchedEmail, 'sync'
FROM OPENJSON(@rows) WITH (employeeId varchar(20), userObjectId varchar(36), matchedEmail nvarchar(254)) s
WHERE NOT EXISTS (SELECT 1 FROM entra.links l WHERE l.employee_id = s.employeeId)
  AND NOT EXISTS (SELECT 1 FROM entra.links l WHERE l.user_object_id = s.userObjectId);
SELECT COUNT(*) AS linked FROM entra.links;`;

export const LINK_ISSUES_REPLACE_SQL = `
DELETE FROM entra.link_issues;
INSERT INTO entra.link_issues (employee_id, user_object_id, kind, detail)
SELECT employeeId, userObjectId, kind, detail FROM OPENJSON(@rows) WITH (employeeId varchar(20), userObjectId varchar(36), kind varchar(30), detail nvarchar(300));`;

export const LINK_MANUAL_SQL = `
SET XACT_ABORT ON;
BEGIN TRANSACTION;
UPDATE entra.proposals SET status = 'stale' WHERE employee_id = @employeeId AND status IN (${STALEABLE_STATUS_LIST});
DELETE FROM entra.links WHERE employee_id = @employeeId;
INSERT INTO entra.links (employee_id, user_object_id, method, matched_email, linked_by) VALUES (@employeeId, @userObjectId, 'manual', NULL, @by);
COMMIT TRANSACTION;
SELECT employee_id, user_object_id, method, matched_email, linked_utc, linked_by FROM entra.links WHERE employee_id = @employeeId;`;

export const LINK_DELETE_SQL = `
UPDATE entra.proposals SET status = 'stale' WHERE employee_id = @employeeId AND status IN (${STALEABLE_STATUS_LIST});
DELETE FROM entra.links WHERE employee_id = @employeeId;
SELECT @@ROWCOUNT AS deleted;`;

export const DIRECTORY_ROW_SQL = `SELECT employee_id, employee_status, work_email FROM rpt.v_directory WHERE employee_id = @employeeId;`;

export const DIRECTORY_SQL = `
SELECT employee_id, employee_number, company_id, company_count, employee_status, display_name, district, store, store_name, store_city, department,
       job_code, job_title, full_or_part_time, original_hire_date, last_hire_date, termination_date, date_last_worked, work_email, updated_utc
FROM rpt.v_directory;`;

export const LATEST_EVENTS_SQL = `
SELECT employee_id, event_id FROM (
  SELECT employee_id, event_id, ROW_NUMBER() OVER (PARTITION BY employee_id ORDER BY effective_date DESC, event_id DESC) AS rn
  FROM rpt.workforce_events WHERE effective_date <= @today) x WHERE rn = 1;`;

export const RULE_COLUMNS = "rule_id, group_id, name, job_codes, districts, stores, companies, statuses, mode, enabled, notes, updated_utc, updated_by";
export const RULE_INSERT_SQL = `
INSERT INTO entra.rules (group_id, name, job_codes, districts, stores, companies, statuses, mode, enabled, notes, updated_by)
OUTPUT ${RULE_COLUMNS.replace(/(\w+)/g, "inserted.$1")}
VALUES (@groupId, @name, @jobCodes, @districts, @stores, @companies, @statuses, @mode, @enabled, @notes, @by);`;
export const RULE_UPDATE_SQL = `
UPDATE entra.rules SET group_id = @groupId, name = @name, job_codes = @jobCodes, districts = @districts, stores = @stores, companies = @companies,
       statuses = @statuses, mode = @mode, enabled = @enabled, notes = @notes, updated_utc = SYSUTCDATETIME(), updated_by = @by
OUTPUT ${RULE_COLUMNS.replace(/(\w+)/g, "inserted.$1")}
WHERE rule_id = @id;`;
export const RULE_DELETE_SQL = `
UPDATE entra.proposals SET status = 'stale' WHERE rule_id = @id AND status IN (${STALEABLE_STATUS_LIST});
DELETE FROM entra.rules WHERE rule_id = @id;
SELECT @@ROWCOUNT AS deleted;`;

export const GROUP_COLUMNS = "object_id, display_name, description, group_types, security_enabled, mail_enabled, role_assignable, managed, member_count, fetched_utc, members_fetched_utc";
export const GROUP_SELECT_SQL = `SELECT ${GROUP_COLUMNS} FROM entra.groups WHERE object_id = @groupId;`;
export const GROUP_MANAGED_SQL = `
UPDATE entra.groups SET managed = @managed OUTPUT ${GROUP_COLUMNS.replace(/(\w+)/g, "inserted.$1")} WHERE object_id = @groupId;`;

export const MANUAL_APPLIED_SQL = `
INSERT INTO entra.proposals (employee_id, user_object_id, kind, group_id, source, status, dedupe_hash, decided_by, decided_utc, applied_utc)
OUTPUT ${INSERTED}
VALUES (@employeeId, @userObjectId, @kind, @groupId, 'manual', 'applied', CONVERT(binary(32), @hash, 2), @by, SYSUTCDATETIME(), SYSUTCDATETIME());`;

export const REJECTION_UPSERT_SQL = `
MERGE entra.rejections WITH (HOLDLOCK) AS t USING (SELECT CONVERT(binary(32), @hash, 2) AS dedupe_hash) AS s ON t.dedupe_hash = s.dedupe_hash
WHEN MATCHED THEN UPDATE SET proposal_id = @proposalId, rejected_by = @by, rejected_utc = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT (dedupe_hash, proposal_id, rejected_by) VALUES (s.dedupe_hash, @proposalId, @by);`;

/** Rejections of the employees compared in this run whose difference is gone (the rejection row points at the rejected proposal);
 *  a rejection recorded after the run started is left for the next run to judge. */
export const REJECTIONS_PRUNE_SQL = `
DELETE r FROM entra.rejections r
JOIN entra.proposals p ON p.proposal_id = r.proposal_id
WHERE p.employee_id IN (SELECT value FROM OPENJSON(@employees))
  AND r.rejected_utc < (SELECT started_utc FROM entra.sync_runs WHERE run_id = @runId)
  AND r.dedupe_hash NOT IN (SELECT CONVERT(binary(32), value, 2) FROM OPENJSON(@keep));
SELECT @@ROWCOUNT AS pruned;`;

const dateOnly = (v: any): string | null => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);
const iso = (v: any): string | null => (v ? new Date(v).toISOString() : null);
const nz = (v: any): string | null => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());
const hex = (v: any): string => (Buffer.isBuffer(v) ? v.toString("hex") : String(v ?? "")).toLowerCase();

export interface ProposalRow {
  proposalId: number; employeeId: string; userObjectId: string; kind: string; field: string | null; groupId: string | null;
  currentValue: string | null; proposedValue: string | null; dueDate: string | null; source: string; eventId: number | null;
  ruleId: number | null; status: ProposalStatus; dedupeHash: string; proposedUtc: string | null; lastSeenUtc: string | null;
  decidedBy: string | null; decidedUtc: string | null; appliedUtc: string | null; error: string | null;
}

export function mapProposalRow(r: any): ProposalRow {
  return {
    proposalId: Number(r.proposal_id), employeeId: r.employee_id, userObjectId: r.user_object_id, kind: r.kind, field: r.field ?? null,
    groupId: r.group_id ?? null, currentValue: r.current_value ?? null, proposedValue: r.proposed_value ?? null, dueDate: dateOnly(r.due_date),
    source: r.source, eventId: r.event_id === null || r.event_id === undefined ? null : Number(r.event_id),
    ruleId: r.rule_id === null || r.rule_id === undefined ? null : Number(r.rule_id), status: r.status, dedupeHash: hex(r.dedupe_hash),
    proposedUtc: iso(r.proposed_utc), lastSeenUtc: iso(r.last_seen_utc), decidedBy: r.decided_by ?? null, decidedUtc: iso(r.decided_utc),
    appliedUtc: iso(r.applied_utc), error: r.error ?? null
  };
}

/** The proposal as the API returns it (no hash). */
export function publicProposal(p: ProposalRow) { const { dedupeHash: _h, ...rest } = p; return rest; }

export function mapDirectoryRow(r: any): DirectoryRow {
  return {
    employeeId: r.employee_id, employeeNumber: nz(r.employee_number), companyId: nz(r.company_id), companyCount: Number(r.company_count ?? 1),
    employeeStatus: nz(r.employee_status), displayName: nz(r.display_name), district: nz(r.district), store: nz(r.store), storeName: nz(r.store_name),
    storeCity: nz(r.store_city), department: nz(r.department), jobCode: nz(r.job_code), jobTitle: nz(r.job_title), fullOrPartTime: nz(r.full_or_part_time),
    originalHireDate: dateOnly(r.original_hire_date), lastHireDate: dateOnly(r.last_hire_date), terminationDate: dateOnly(r.termination_date),
    dateLastWorked: dateOnly(r.date_last_worked), workEmail: nz(r.work_email), updatedUtc: iso(r.updated_utc)
  };
}

export function mapUserRow(r: any): EntraUserSnapshot {
  return {
    objectId: String(r.object_id).toLowerCase(), upn: nz(r.upn), mail: nz(r.mail), displayName: nz(r.display_name), jobTitle: nz(r.job_title),
    department: nz(r.department), officeLocation: nz(r.office_location), accountEnabled: !!r.account_enabled, employeeIdAttr: nz(r.employee_id_attr),
    userType: nz(r.user_type), onpremSynced: !!r.onprem_synced, missingSinceUtc: iso(r.missing_since_utc)
  };
}

export function mapGroupRow(r: any): GroupSnapshot & { description: string | null; memberCount: number | null; fetchedUtc: string | null; membersFetchedUtc: string | null } {
  return {
    objectId: String(r.object_id).toLowerCase(), displayName: nz(r.display_name), description: nz(r.description),
    groupTypes: nz(r.group_types)?.split(",").map((s: string) => s.trim()).filter(Boolean) ?? [], securityEnabled: !!r.security_enabled,
    mailEnabled: !!r.mail_enabled, roleAssignable: !!r.role_assignable, managed: !!r.managed,
    memberCount: r.member_count === null || r.member_count === undefined ? null : Number(r.member_count), fetchedUtc: iso(r.fetched_utc), membersFetchedUtc: iso(r.members_fetched_utc)
  };
}

export function mapRuleRow(r: any): Rule & { notes: string | null; updatedUtc: string | null; updatedBy: string | null } {
  return {
    ruleId: Number(r.rule_id), groupId: String(r.group_id).toLowerCase(), name: r.name, jobCodes: nz(r.job_codes), districts: nz(r.districts), stores: nz(r.stores),
    companies: nz(r.companies), statuses: nz(r.statuses) ?? "A,L", mode: r.mode === "add_and_remove" ? "add_and_remove" : "add_only", enabled: !!r.enabled,
    notes: nz(r.notes), updatedUtc: iso(r.updated_utc), updatedBy: nz(r.updated_by)
  };
}

export function mapLinkRow(r: any): LinkRow & { linkedUtc: string | null; linkedBy: string | null } {
  return { employeeId: r.employee_id, userObjectId: String(r.user_object_id).toLowerCase(), method: r.method, matchedEmail: nz(r.matched_email), linkedUtc: iso(r.linked_utc), linkedBy: nz(r.linked_by) };
}

export interface RunCounts { usersFetched: number; groupsFetched: number; linked: number; proposalsNew: number; proposalsStale: number; }

export interface EntraStore {
  isRunning(): Promise<boolean>;
  startRun(trigger: "timer" | "after-sync" | "manual"): Promise<string>;
  finishRun(runId: string, status: string, counts: Partial<RunCounts>, error?: string): Promise<void>;
  activeUserCount(): Promise<number>;
  upsertUsers(users: GraphUser[], fetchedUtc: Date): Promise<void>;
  markMissingUsers(fetchedUtc: Date): Promise<number>;
  upsertGroups(groups: GraphGroup[], fetchedUtc: Date): Promise<void>;
  replaceGroupMembers(groupId: string, userIds: string[], fetchedUtc: Date): Promise<void>;
  directory(): Promise<DirectoryRow[]>;
  users(): Promise<EntraUserSnapshot[]>;
  groups(): Promise<ReturnType<typeof mapGroupRow>[]>;
  memberships(): Promise<Map<string, Set<string>>>;          // user id -> group ids
  links(): Promise<LinkRow[]>;
  replaceAutoLinks(links: AutoLink[]): Promise<number>;
  replaceLinkIssues(issues: LinkIssue[]): Promise<void>;
  openProposals(): Promise<OpenProposal[]>;
  rejections(): Promise<Set<string>>;
  rules(): Promise<Rule[]>;
  latestEvents(today: string): Promise<Map<string, number>>;
  upsertProposals(rows: ProposalCandidate[]): Promise<number>;
  staleProposals(ids: number[]): Promise<number>;
  pruneRejections(runId: string, comparedEmployees: string[], keepHashes: string[]): Promise<number>;
}

export class SqlEntraStore implements EntraStore {
  constructor(private pool: sql.ConnectionPool) {}

  // ---------------- run lock ----------------
  async isRunning(): Promise<boolean> {
    const r = await this.pool.request().query(`SELECT COUNT(*) AS n FROM entra.sync_runs WHERE status = 'running' AND started_utc > DATEADD(minute, -30, SYSUTCDATETIME())`);
    return Number(r.recordset[0]?.n ?? 0) > 0;
  }

  async startRun(trigger: "timer" | "after-sync" | "manual"): Promise<string> {
    const r = await this.pool.request().input("trigger", sql.VarChar(20), trigger).query(`DECLARE @id uniqueidentifier = NEWID();
      INSERT INTO entra.sync_runs (run_id, started_utc, status, trigger_kind) VALUES (@id, SYSUTCDATETIME(), 'running', @trigger);
      SELECT @id AS run_id;`);
    return String(r.recordset[0].run_id);
  }

  async finishRun(runId: string, status: string, c: Partial<RunCounts>, error?: string): Promise<void> {
    await this.pool.request().input("id", sql.UniqueIdentifier, runId).input("s", sql.VarChar(20), status)
      .input("u", sql.Int, c.usersFetched ?? null).input("g", sql.Int, c.groupsFetched ?? null).input("l", sql.Int, c.linked ?? null)
      .input("n", sql.Int, c.proposalsNew ?? null).input("st", sql.Int, c.proposalsStale ?? null).input("err", sql.NVarChar(1000), error ? error.slice(0, 1000) : null)
      .query(`UPDATE entra.sync_runs SET finished_utc = SYSUTCDATETIME(), status = @s, users_fetched = @u, groups_fetched = @g, linked = @l,
              proposals_new = @n, proposals_stale = @st, error_summary = @err WHERE run_id = @id`);
  }

  // ---------------- snapshot ----------------
  async activeUserCount(): Promise<number> {
    const r = await this.pool.request().query(`SELECT COUNT(*) AS n FROM entra.users WHERE missing_since_utc IS NULL`);
    return Number(r.recordset?.[0]?.n ?? 0);
  }
  async upsertUsers(users: GraphUser[], fetchedUtc: Date): Promise<void> {
    for (let i = 0; i < users.length; i += 1000) {
      await this.pool.request().input("rows", sql.NVarChar(sql.MAX), JSON.stringify(users.slice(i, i + 1000))).input("fetchedUtc", sql.DateTime2(0), fetchedUtc).query(USERS_UPSERT_SQL);
    }
  }

  async markMissingUsers(fetchedUtc: Date): Promise<number> {
    const r = await this.pool.request().input("fetchedUtc", sql.DateTime2(0), fetchedUtc).query(USERS_MARK_MISSING_SQL);
    return Number(r.recordset?.[0]?.marked ?? 0);
  }

  async upsertGroups(groups: GraphGroup[], fetchedUtc: Date): Promise<void> {
    const rows = groups.map(g => ({ ...g, groupTypes: g.groupTypes.join(",") }));
    await this.pool.request().input("rows", sql.NVarChar(sql.MAX), JSON.stringify(rows)).input("fetchedUtc", sql.DateTime2(0), fetchedUtc).query(GROUPS_UPSERT_SQL);
  }

  async replaceGroupMembers(groupId: string, userIds: string[], fetchedUtc: Date): Promise<void> {
    await this.pool.request().input("groupId", sql.VarChar(36), groupId).input("ids", sql.NVarChar(sql.MAX), JSON.stringify(userIds)).input("fetchedUtc", sql.DateTime2(0), fetchedUtc).query(GROUP_MEMBERS_REPLACE_SQL);
  }

  // ---------------- reads ----------------
  async directory(): Promise<DirectoryRow[]> { const r = await this.pool.request().query(DIRECTORY_SQL); return (r.recordset ?? []).map(mapDirectoryRow); }
  async users(): Promise<EntraUserSnapshot[]> {
    const r = await this.pool.request().query(`SELECT object_id, upn, mail, display_name, job_title, department, office_location, account_enabled, employee_id_attr, user_type, onprem_synced, missing_since_utc FROM entra.users`);
    return (r.recordset ?? []).map(mapUserRow);
  }
  async groups() { const r = await this.pool.request().query(`SELECT ${GROUP_COLUMNS} FROM entra.groups`); return (r.recordset ?? []).map(mapGroupRow); }
  async memberships(): Promise<Map<string, Set<string>>> {
    const r = await this.pool.request().query(`SELECT group_id, user_id FROM entra.group_members`);
    const out = new Map<string, Set<string>>();
    for (const row of r.recordset ?? []) { const u = String(row.user_id).toLowerCase(); const set = out.get(u) ?? new Set<string>(); set.add(String(row.group_id).toLowerCase()); out.set(u, set); }
    return out;
  }
  async links(): Promise<LinkRow[]> { const r = await this.pool.request().query(`SELECT employee_id, user_object_id, method, matched_email, linked_utc, linked_by FROM entra.links`); return (r.recordset ?? []).map(mapLinkRow); }
  async openProposals(): Promise<OpenProposal[]> {
    const r = await this.pool.request().query(`SELECT proposal_id, status, dedupe_hash, employee_id FROM entra.proposals WHERE status IN (${OPEN_STATUS_LIST})`);
    return (r.recordset ?? []).map((x: any) => ({ proposalId: Number(x.proposal_id), status: x.status, dedupeHash: hex(x.dedupe_hash), employeeId: x.employee_id }));
  }
  async rejections(): Promise<Set<string>> { const r = await this.pool.request().query(`SELECT dedupe_hash FROM entra.rejections`); return new Set((r.recordset ?? []).map((x: any) => hex(x.dedupe_hash))); }
  async rules(): Promise<Rule[]> { const r = await this.pool.request().query(`SELECT ${RULE_COLUMNS} FROM entra.rules`); return (r.recordset ?? []).map(mapRuleRow); }
  async latestEvents(today: string): Promise<Map<string, number>> {
    const r = await this.pool.request().input("today", sql.Date, today).query(LATEST_EVENTS_SQL);
    return new Map((r.recordset ?? []).map((x: any) => [String(x.employee_id), Number(x.event_id)]));
  }

  // ---------------- writes ----------------
  async replaceAutoLinks(links: AutoLink[]): Promise<number> {
    const r = await this.pool.request().input("rows", sql.NVarChar(sql.MAX), JSON.stringify(links)).query(LINKS_REPLACE_AUTO_SQL);
    return Number(r.recordset?.[0]?.linked ?? 0);
  }
  async replaceLinkIssues(issues: LinkIssue[]): Promise<void> {
    await this.pool.request().input("rows", sql.NVarChar(sql.MAX), JSON.stringify(issues)).query(LINK_ISSUES_REPLACE_SQL);
  }
  async upsertProposals(rows: ProposalCandidate[]): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const r = await this.pool.request().input("rows", sql.NVarChar(sql.MAX), JSON.stringify(rows.slice(i, i + 500))).query(PROPOSALS_UPSERT_SQL);
      inserted += (r.recordset ?? []).filter((x: any) => x.merge_action === "INSERT").length;
    }
    return inserted;
  }
  async staleProposals(ids: number[]): Promise<number> {
    if (!ids.length) return 0;
    const r = await this.pool.request().input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids)).query(PROPOSALS_STALE_SQL);
    return Number(r.recordset?.[0]?.staled ?? 0);
  }
  async pruneRejections(runId: string, comparedEmployees: string[], keepHashes: string[]): Promise<number> {
    if (!comparedEmployees.length) return 0;
    const r = await this.pool.request().input("runId", sql.UniqueIdentifier, runId).input("employees", sql.NVarChar(sql.MAX), JSON.stringify(comparedEmployees))
      .input("keep", sql.NVarChar(sql.MAX), JSON.stringify(keepHashes)).query(REJECTIONS_PRUNE_SQL);
    return Number(r.recordset?.[0]?.pruned ?? 0);
  }

  // ---------------- proposals (admin endpoints and apply) ----------------
  private byId(id: number) { return this.pool.request().input("id", sql.BigInt, id); }
  private first(r: any): ProposalRow | null { const row = r?.recordset?.[0]; return row ? mapProposalRow(row) : null; }

  async proposal(id: number): Promise<ProposalRow | null> { return this.first(await this.byId(id).query(PROPOSAL_SELECT_SQL)); }
  async accept(id: number, by: string): Promise<ProposalRow | null> { return this.first(await this.byId(id).input("by", sql.NVarChar(200), by).query(PROPOSAL_ACCEPT_SQL)); }
  async reject(id: number, by: string): Promise<ProposalRow | null> {
    const row = this.first(await this.byId(id).input("by", sql.NVarChar(200), by).query(PROPOSAL_REJECT_SQL));
    if (row) await this.pool.request().input("hash", sql.Char(64), row.dedupeHash).input("proposalId", sql.BigInt, row.proposalId).input("by", sql.NVarChar(200), by).query(REJECTION_UPSERT_SQL);
    return row;
  }
  /** accepted -> applying when due; null when the row is not accepted or not yet due. */
  async claim(id: number, today: string): Promise<ProposalRow | null> { return this.first(await this.byId(id).input("today", sql.Date, today).query(PROPOSAL_CLAIM_SQL)); }
  async finish(id: number, status: "applied" | "failed" | "stale", currentValue: string | null, error: string | null): Promise<ProposalRow | null> {
    return this.first(await this.byId(id).input("status", sql.VarChar(20), status).input("currentValue", sql.NVarChar(256), currentValue)
      .input("error", sql.NVarChar(300), error ? error.slice(0, 300) : null).query(PROPOSAL_FINISH_SQL));
  }
  async staleByHash(hash: string, exceptId: number): Promise<number> {
    const r = await this.pool.request().input("hash", sql.Char(64), hash).input("exceptId", sql.BigInt, exceptId).query(STALE_BY_HASH_SQL);
    return Number(r.recordset?.[0]?.staled ?? 0);
  }
  async insertManualApplied(row: { employeeId: string; userObjectId: string; kind: "group_add" | "group_remove"; groupId: string; hash: string; by: string }): Promise<ProposalRow | null> {
    return this.first(await this.pool.request().input("employeeId", sql.VarChar(20), row.employeeId).input("userObjectId", sql.VarChar(36), row.userObjectId)
      .input("kind", sql.VarChar(20), row.kind).input("groupId", sql.VarChar(36), row.groupId).input("hash", sql.Char(64), row.hash).input("by", sql.NVarChar(200), row.by).query(MANUAL_APPLIED_SQL));
  }

  // ---------------- snapshot refresh after a write ----------------
  async user(objectId: string): Promise<EntraUserSnapshot | null> {
    const r = await this.pool.request().input("id", sql.VarChar(36), objectId).query(`SELECT object_id, upn, mail, display_name, job_title, department, office_location, account_enabled, employee_id_attr, user_type, onprem_synced, missing_since_utc FROM entra.users WHERE object_id = @id`);
    return r.recordset?.[0] ? mapUserRow(r.recordset[0]) : null;
  }
  async refreshUser(objectId: string, values: { jobTitle?: string | null; department?: string | null; officeLocation?: string | null; accountEnabled?: boolean }): Promise<void> {
    const sets: string[] = [];
    const req = this.pool.request().input("id", sql.VarChar(36), objectId);
    if ("jobTitle" in values) { sets.push("job_title = @jobTitle"); req.input("jobTitle", sql.NVarChar(128), values.jobTitle ?? null); }
    if ("department" in values) { sets.push("department = @department"); req.input("department", sql.NVarChar(128), values.department ?? null); }
    if ("officeLocation" in values) { sets.push("office_location = @officeLocation"); req.input("officeLocation", sql.NVarChar(128), values.officeLocation ?? null); }
    if ("accountEnabled" in values) { sets.push("account_enabled = @accountEnabled"); req.input("accountEnabled", sql.Bit, values.accountEnabled ? 1 : 0); }
    if (!sets.length) return;
    await req.query(`UPDATE entra.users SET ${sets.join(", ")} WHERE object_id = @id`);
  }
  async setMember(groupId: string, userId: string, member: boolean): Promise<void> {
    await this.pool.request().input("groupId", sql.VarChar(36), groupId).input("userId", sql.VarChar(36), userId).query(member
      ? `IF NOT EXISTS (SELECT 1 FROM entra.group_members WHERE group_id = @groupId AND user_id = @userId)
           INSERT INTO entra.group_members (group_id, user_id, fetched_utc) VALUES (@groupId, @userId, SYSUTCDATETIME());
         UPDATE entra.groups SET member_count = (SELECT COUNT(*) FROM entra.group_members WHERE group_id = @groupId) WHERE object_id = @groupId;`
      : `DELETE FROM entra.group_members WHERE group_id = @groupId AND user_id = @userId;
         UPDATE entra.groups SET member_count = (SELECT COUNT(*) FROM entra.group_members WHERE group_id = @groupId) WHERE object_id = @groupId;`);
  }
  async isMember(groupId: string, userId: string): Promise<boolean> {
    const r = await this.pool.request().input("groupId", sql.VarChar(36), groupId).input("userId", sql.VarChar(36), userId).query(`SELECT COUNT(*) AS n FROM entra.group_members WHERE group_id = @groupId AND user_id = @userId`);
    return Number(r.recordset?.[0]?.n ?? 0) > 0;
  }

  // ---------------- groups, rules, links (admin endpoints) ----------------
  async group(groupId: string) { const r = await this.pool.request().input("groupId", sql.VarChar(36), groupId).query(GROUP_SELECT_SQL); return r.recordset?.[0] ? mapGroupRow(r.recordset[0]) : null; }
  async setManaged(groupId: string, managed: boolean) {
    const r = await this.pool.request().input("groupId", sql.VarChar(36), groupId).input("managed", sql.Bit, managed ? 1 : 0).query(GROUP_MANAGED_SQL);
    return r.recordset?.[0] ? mapGroupRow(r.recordset[0]) : null;
  }
  async rule(id: number) { const r = await this.pool.request().input("id", sql.Int, id).query(`SELECT ${RULE_COLUMNS} FROM entra.rules WHERE rule_id = @id`); return r.recordset?.[0] ? mapRuleRow(r.recordset[0]) : null; }
  async saveRule(id: number | null, v: { groupId: string; name: string; jobCodes: string | null; districts: string | null; stores: string | null; companies: string | null; statuses: string; mode: string; enabled: boolean; notes: string | null }, by: string) {
    const req = this.pool.request().input("groupId", sql.VarChar(36), v.groupId).input("name", sql.NVarChar(100), v.name).input("jobCodes", sql.NVarChar(400), v.jobCodes)
      .input("districts", sql.NVarChar(400), v.districts).input("stores", sql.NVarChar(1000), v.stores).input("companies", sql.NVarChar(200), v.companies)
      .input("statuses", sql.VarChar(20), v.statuses).input("mode", sql.VarChar(20), v.mode).input("enabled", sql.Bit, v.enabled ? 1 : 0).input("notes", sql.NVarChar(300), v.notes).input("by", sql.NVarChar(200), by);
    const r = id === null ? await req.query(RULE_INSERT_SQL) : await req.input("id", sql.Int, id).query(RULE_UPDATE_SQL);
    return r.recordset?.[0] ? mapRuleRow(r.recordset[0]) : null;
  }
  async deleteRule(id: number): Promise<number> { const r = await this.pool.request().input("id", sql.Int, id).query(RULE_DELETE_SQL); return Number(r.recordset?.[0]?.deleted ?? 0); }
  async linkManual(employeeId: string, userObjectId: string, by: string) {
    const r = await this.pool.request().input("employeeId", sql.VarChar(20), employeeId).input("userObjectId", sql.VarChar(36), userObjectId).input("by", sql.NVarChar(200), by).query(LINK_MANUAL_SQL);
    return r.recordset?.[0] ? mapLinkRow(r.recordset[0]) : null;
  }
  async unlink(employeeId: string): Promise<number> { const r = await this.pool.request().input("employeeId", sql.VarChar(20), employeeId).query(LINK_DELETE_SQL); return Number(r.recordset?.[0]?.deleted ?? 0); }
  /** The employee as rpt.v_directory knows it (null when the hub does not have the employee). */
  async directoryRow(employeeId: string): Promise<{ employeeId: string; employeeStatus: string | null; workEmail: string | null } | null> {
    const r = await this.pool.request().input("employeeId", sql.VarChar(20), employeeId).query(DIRECTORY_ROW_SQL);
    const row = r.recordset?.[0];
    return row ? { employeeId: row.employee_id, employeeStatus: nz(row.employee_status), workEmail: nz(row.work_email) } : null;
  }
  async linkFor(employeeId: string) {
    const r = await this.pool.request().input("employeeId", sql.VarChar(20), employeeId).query(`SELECT employee_id, user_object_id, method, matched_email, linked_utc, linked_by FROM entra.links WHERE employee_id = @employeeId`);
    return r.recordset?.[0] ? mapLinkRow(r.recordset[0]) : null;
  }
  async linkForUser(userObjectId: string) {
    const r = await this.pool.request().input("userObjectId", sql.VarChar(36), userObjectId).query(`SELECT employee_id, user_object_id, method, matched_email, linked_utc, linked_by FROM entra.links WHERE user_object_id = @userObjectId`);
    return r.recordset?.[0] ? mapLinkRow(r.recordset[0]) : null;
  }
}
