import { sql } from "./sql";
import {
  ClaimedDelivery, CodeMaps, CodeType, DeliveryContext, DeliveryStore, EmploymentContext, EventContext, PendingCreate,
  QueueStats, codeKey, pickEmployment
} from "./delivery";

/*
  DeliveryStore backed by sqldb-hrint: out.deliveries / out.last_sent / out.shadow_payloads / xref.employees,
  read from rpt.workforce_events, stage.employment_current, ref.destination_codes, ref.store_modes.
  Runs are locked through stage.sync_runs with run_type 'delivery' (same pattern as the sync).
  Nothing here logs or stores names, SIN, dates of birth or pay: the runner hands over already-masked payloads.
*/

const ACTION_RANK_SQL = `CASE d.action WHEN 'create' THEN 0 WHEN 'job' THEN 1 WHEN 'store' THEN 2 WHEN 'pay' THEN 3
                                       WHEN 'update' THEN 4 WHEN 'terminate' THEN 5 ELSE 9 END`;

/** Due pending / failed / waiting rows for one destination, skipping employees that have a blocking row
 *  (dead, or failed / waiting not yet due), ordered per employee by effective date, action rank, id.
 *  First, any claimable row that a newer version of the same event has replaced is marked superseded: the event rebuild
 *  supersedes pending / failed rows itself, but never a waiting one (it did not exist when that rule was written). */
export const CLAIM_SQL = `
SET NOCOUNT ON;
UPDATE d SET status = 'superseded', finished_utc = SYSUTCDATETIME()
FROM [out].deliveries d
WHERE d.destination = @destination AND d.status IN ('pending', 'failed', 'waiting')
  AND EXISTS (SELECT 1 FROM [out].deliveries n WHERE n.destination = d.destination AND n.event_key = d.event_key AND n.version > d.version);
WITH blocked AS (
    SELECT DISTINCT employee_id FROM [out].deliveries
    WHERE destination = @destination
      AND (status = 'dead' OR (status IN ('failed', 'waiting') AND next_attempt_utc > SYSUTCDATETIME())))
SELECT TOP (@limit) d.delivery_id, d.destination, d.event_key, d.kind, d.employee_id, d.event_type, d.action,
       d.effective_date, d.store, d.status, d.attempts
FROM [out].deliveries d
WHERE d.destination = @destination
  AND d.status IN ('pending', 'failed', 'waiting')
  AND (d.next_attempt_utc IS NULL OR d.next_attempt_utc <= SYSUTCDATETIME())
  AND NOT EXISTS (SELECT 1 FROM blocked b WHERE b.employee_id = d.employee_id)
  AND NOT EXISTS (SELECT 1 FROM [out].deliveries n WHERE n.destination = d.destination AND n.event_key = d.event_key AND n.version > d.version)
ORDER BY d.employee_id, d.effective_date, ${ACTION_RANK_SQL}, d.delivery_id;`;

export const CONTEXT_SQL = `
SELECT e.event_type, e.effective_date, e.from_company, e.to_company, e.from_store, e.to_store, e.from_job, e.to_job, e.termination_category
FROM rpt.workforce_events e WHERE e.event_key = @eventKey;
SELECT employee_id, company_id, employee_number, is_home_company, employee_status, original_hire_date, last_hire_date, termination_date,
       org_level2, job_code, full_or_part_time, first_name, preferred_name, last_name
FROM stage.employment_current WHERE employee_id = @employeeId;
SELECT external_id, source FROM xref.employees WHERE destination = @destination AND employee_id = @employeeId;
SELECT mode FROM ref.store_modes WHERE destination = @destination AND store = @store;
SELECT operation, payload_hash FROM [out].last_sent WHERE destination = @destination AND employee_id = @employeeId;`;

export const CODES_SQL = `SELECT code_type, company, ukg_code, destination_code, destination_id FROM ref.destination_codes WHERE destination = @destination;`;

export const STATS_SQL = `
SELECT
  SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
  SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting,
  SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN status = 'dead'    THEN 1 ELSE 0 END) AS dead,
  DATEDIFF(minute, MIN(CASE WHEN status = 'pending' THEN queued_utc END), SYSUTCDATETIME()) AS oldest_pending_minutes
FROM [out].deliveries WHERE destination = @destination;`;

export const PENDING_CREATES_SQL = `
SELECT d.delivery_id, d.employee_id, d.finished_utc, ec.company_id, ec.employee_number, ec.last_name
FROM [out].deliveries d
OUTER APPLY (SELECT TOP 1 company_id, employee_number, last_name FROM stage.employment_current e
             WHERE e.employee_id = d.employee_id ORDER BY CASE WHEN e.is_home_company = 1 THEN 0 ELSE 1 END) ec
WHERE d.destination = @destination AND d.action = 'create' AND d.status = 'sent' AND d.response_ref LIKE 'import:%'
  AND NOT EXISTS (SELECT 1 FROM xref.employees x WHERE x.destination = d.destination AND x.employee_id = d.employee_id)
ORDER BY d.finished_utc;`;

export const XREF_UPSERT_SQL = `
MERGE xref.employees WITH (HOLDLOCK) AS t
USING (SELECT @destination AS destination, @employeeId AS employee_id) AS s ON t.destination = s.destination AND t.employee_id = s.employee_id
WHEN MATCHED THEN UPDATE SET external_id = @externalId, source = @source, updated_utc = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT (destination, employee_id, external_id, source) VALUES (@destination, @employeeId, @externalId, @source);`;

export const LAST_SENT_UPSERT_SQL = `
MERGE [out].last_sent WITH (HOLDLOCK) AS t
USING (SELECT @destination AS destination, @employeeId AS employee_id, @operation AS operation) AS s
   ON t.destination = s.destination AND t.employee_id = s.employee_id AND t.operation = s.operation
WHEN MATCHED THEN UPDATE SET payload_hash = @hash, sent_utc = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT (destination, employee_id, operation, payload_hash, sent_utc) VALUES (@destination, @employeeId, @operation, @hash, SYSUTCDATETIME());`;

export const PURGE_SHADOW_SQL = `
DELETE TOP (5000) p FROM [out].shadow_payloads p
JOIN [out].deliveries d ON d.delivery_id = p.delivery_id
WHERE d.destination = @destination AND p.built_utc < DATEADD(day, -@days, SYSUTCDATETIME());
SELECT @@ROWCOUNT AS purged;`;

const dateOnly = (v: any): string | null => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);
const nz = (v: any): string | null => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());

export function mapClaimedRow(r: any): ClaimedDelivery {
  return {
    deliveryId: Number(r.delivery_id), destination: r.destination, eventKey: r.event_key ?? null, kind: r.kind, employeeId: r.employee_id,
    eventType: r.event_type, action: r.action ?? null, effectiveDate: dateOnly(r.effective_date)!, store: r.store ?? null,
    status: r.status, attempts: Number(r.attempts ?? 0)
  };
}

export function mapEventRow(r: any): EventContext {
  return {
    eventType: r.event_type, effectiveDate: dateOnly(r.effective_date)!, fromCompany: nz(r.from_company), toCompany: nz(r.to_company),
    fromStore: nz(r.from_store), toStore: nz(r.to_store), fromJob: nz(r.from_job), toJob: nz(r.to_job), terminationCategory: nz(r.termination_category)
  };
}

export function mapEmploymentRow(r: any): EmploymentContext {
  return {
    employeeId: r.employee_id, companyId: r.company_id, employeeNumber: nz(r.employee_number),
    isHomeCompany: r.is_home_company === null || r.is_home_company === undefined ? null : !!r.is_home_company,
    employeeStatus: nz(r.employee_status), originalHireDate: dateOnly(r.original_hire_date), lastHireDate: dateOnly(r.last_hire_date),
    terminationDate: dateOnly(r.termination_date), orgLevel2: nz(r.org_level2), jobCode: nz(r.job_code), fullOrPartTime: nz(r.full_or_part_time),
    firstName: nz(r.first_name), preferredName: nz(r.preferred_name), lastName: nz(r.last_name)
  };
}

export function emptyCodes(): CodeMaps {
  return { store: new Map(), job: new Map(), termination: new Map(), category: new Map(), company: new Map() };
}

export function mapCodeRows(rows: any[]): CodeMaps {
  const codes = emptyCodes();
  for (const r of rows) {
    const type = String(r.code_type) as CodeType;
    if (!(type in codes)) continue;
    const ukgCode = String(r.ukg_code).trim().toUpperCase(), company = String(r.company ?? "").trim().toUpperCase();
    codes[type].set(codeKey(company, ukgCode), { ukgCode, company, destinationCode: String(r.destination_code), destinationId: nz(r.destination_id) });
  }
  return codes;
}

export class SqlDeliveryStore implements DeliveryStore {
  private codes: CodeMaps | null = null;              // ref.destination_codes, read once per run
  constructor(private pool: sql.ConnectionPool, private destination: string) {}

  async isRunning(): Promise<boolean> {
    const r = await this.pool.request().query(`
      SELECT COUNT(*) AS n FROM stage.sync_runs
      WHERE run_type = 'delivery' AND status = 'running' AND started_utc > DATEADD(minute, -30, SYSUTCDATETIME())`);
    return Number(r.recordset[0]?.n ?? 0) > 0;
  }

  async startRun(): Promise<string> {
    const r = await this.pool.request().query(`DECLARE @id uniqueidentifier = NEWID();
      INSERT INTO stage.sync_runs (run_id, run_type, started_utc, window_start_utc, window_end_utc, status)
      VALUES (@id, 'delivery', SYSUTCDATETIME(), NULL, SYSUTCDATETIME(), 'running');
      SELECT @id AS run_id;`);
    return r.recordset[0].run_id;
  }

  async finishRun(runId: string, status: string, counts: { processed: number; calls: number }, error?: string): Promise<void> {
    await this.pool.request()
      .input("id", sql.UniqueIdentifier, runId).input("s", sql.VarChar(20), status)
      .input("p", sql.Int, counts.processed).input("c", sql.Int, counts.calls).input("err", sql.NVarChar(1000), error ?? null)
      .query(`UPDATE stage.sync_runs SET finished_utc = SYSUTCDATETIME(), status = @s, employees_processed = @p, ukg_calls = @c, error_summary = @err
              WHERE run_id = @id`);
  }

  async claim(destination: string, limit: number): Promise<ClaimedDelivery[]> {
    const r = await this.pool.request().input("destination", sql.VarChar(20), destination).input("limit", sql.Int, limit).query(CLAIM_SQL);
    return (r.recordset ?? []).map(mapClaimedRow);
  }

  private async loadCodes(): Promise<CodeMaps> {
    if (this.codes) return this.codes;
    const r = await this.pool.request().input("destination", sql.VarChar(20), this.destination).query(CODES_SQL);
    this.codes = mapCodeRows(r.recordset ?? []);
    return this.codes;
  }

  async loadContext(d: ClaimedDelivery): Promise<DeliveryContext> {
    const codes = await this.loadCodes();
    const r: any = await this.pool.request()
      .input("eventKey", sql.Binary, d.eventKey).input("employeeId", sql.VarChar(20), d.employeeId)
      .input("destination", sql.VarChar(20), d.destination).input("store", sql.VarChar(20), d.store ?? "")
      .query(CONTEXT_SQL);
    const [events, employment, xrefs, modes, lastSent] = r.recordsets as any[][];
    const event = events?.[0] ? mapEventRow(events[0]) : null;
    const lastSentMap = new Map<string, Buffer>();
    for (const row of lastSent ?? []) if (row.payload_hash) lastSentMap.set(String(row.operation), Buffer.from(row.payload_hash));
    const mode = String(modes?.[0]?.mode ?? "off").toLowerCase();
    return {
      delivery: d, event, employment: pickEmployment((employment ?? []).map(mapEmploymentRow), event),
      xref: xrefs?.[0] ? { externalId: String(xrefs[0].external_id), source: String(xrefs[0].source) } : null,
      codes, storeMode: mode === "live" || mode === "shadow" ? mode : "off", lastSent: lastSentMap
    };
  }

  private update(id: number) { return this.pool.request().input("id", sql.BigInt, id); }

  async markShadow(id: number, hash: Buffer, storedPayload: string, operation: string): Promise<void> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      await new sql.Request(tx).input("id", sql.BigInt, id).input("hash", sql.Binary, hash).input("payload", sql.NVarChar(sql.MAX), storedPayload)
        .input("ref", sql.NVarChar(64), `shadow:${operation}`).query(`
        UPDATE [out].deliveries SET status = 'shadow', mode_at_send = 'shadow', payload_hash = @hash, finished_utc = SYSUTCDATETIME(), last_error = NULL,
               response_ref = @ref WHERE delivery_id = @id;
        DELETE FROM [out].shadow_payloads WHERE delivery_id = @id;
        INSERT INTO [out].shadow_payloads (delivery_id, payload, built_utc) VALUES (@id, @payload, SYSUTCDATETIME());`);
      await tx.commit();
    } catch (e) { await tx.rollback().catch(() => {}); throw e; }
  }

  async markSent(id: number, hash: Buffer, operation: string, responseRef: string | null, warning: string | null): Promise<void> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      const req = new sql.Request(tx).input("id", sql.BigInt, id).input("hash", sql.Binary, hash)
        .input("ref", sql.NVarChar(64), responseRef ? responseRef.slice(0, 64) : null).input("warn", sql.NVarChar(300), warning ? warning.slice(0, 300) : null)
        .input("destination", sql.VarChar(20), this.destination).input("operation", sql.VarChar(30), operation);
      await req.query(`
        DECLARE @employeeId varchar(20) = (SELECT employee_id FROM [out].deliveries WHERE delivery_id = @id);
        UPDATE [out].deliveries SET status = 'sent', mode_at_send = 'live', payload_hash = @hash, finished_utc = SYSUTCDATETIME(),
               attempts = attempts + 1, response_ref = @ref, last_error = @warn WHERE delivery_id = @id;
        ${LAST_SENT_UPSERT_SQL}`);
      await tx.commit();
    } catch (e) { await tx.rollback().catch(() => {}); throw e; }
  }

  async markUnchanged(id: number, hash: Buffer): Promise<void> {
    await this.update(id).input("hash", sql.Binary, hash).query(`
      UPDATE [out].deliveries SET status = 'unchanged', mode_at_send = 'live', payload_hash = @hash, finished_utc = SYSUTCDATETIME(), last_error = NULL
      WHERE delivery_id = @id`);
  }

  async markFailed(id: number, attempts: number, nextAttemptUtc: Date, error: string): Promise<void> {
    await this.update(id).input("attempts", sql.Int, attempts).input("next", sql.DateTime2(0), nextAttemptUtc).input("err", sql.NVarChar(300), error.slice(0, 300))
      .query(`UPDATE [out].deliveries SET status = 'failed', attempts = @attempts, next_attempt_utc = @next, last_error = @err WHERE delivery_id = @id`);
  }

  async markDead(id: number, attempts: number, error: string): Promise<void> {
    await this.update(id).input("attempts", sql.Int, attempts).input("err", sql.NVarChar(300), error.slice(0, 300))
      .query(`UPDATE [out].deliveries SET status = 'dead', attempts = @attempts, next_attempt_utc = NULL, finished_utc = SYSUTCDATETIME(), last_error = @err WHERE delivery_id = @id`);
  }

  async markWaiting(id: number, nextAttemptUtc: Date, reason: string): Promise<void> {
    await this.update(id).input("next", sql.DateTime2(0), nextAttemptUtc).input("err", sql.NVarChar(300), reason.slice(0, 300))
      .query(`UPDATE [out].deliveries SET status = 'waiting', next_attempt_utc = @next, last_error = @err WHERE delivery_id = @id`);
  }

  async markSkipped(id: number, reason: string): Promise<void> {
    await this.update(id).input("err", sql.NVarChar(300), reason.slice(0, 300))
      .query(`UPDATE [out].deliveries SET status = 'skipped', finished_utc = SYSUTCDATETIME(), last_error = @err WHERE delivery_id = @id`);
  }

  async markReview(id: number, reason: string): Promise<void> {
    await this.update(id).input("err", sql.NVarChar(300), reason.slice(0, 300))
      .query(`UPDATE [out].deliveries SET status = 'review', last_error = @err WHERE delivery_id = @id`);
  }

  async upsertXref(destination: string, employeeId: string, externalId: string, source: "created" | "matched"): Promise<void> {
    await this.pool.request().input("destination", sql.VarChar(20), destination).input("employeeId", sql.VarChar(20), employeeId)
      .input("externalId", sql.NVarChar(64), externalId).input("source", sql.VarChar(20), source).query(XREF_UPSERT_SQL);
  }

  async pendingCreates(destination: string): Promise<PendingCreate[]> {
    const r = await this.pool.request().input("destination", sql.VarChar(20), destination).query(PENDING_CREATES_SQL);
    return (r.recordset ?? []).map((row: any) => ({
      deliveryId: Number(row.delivery_id), employeeId: row.employee_id, companyId: nz(row.company_id), employeeNumber: nz(row.employee_number),
      lastName: nz(row.last_name), finishedUtc: new Date(row.finished_utc)
    }));
  }

  async queueStats(destination: string): Promise<QueueStats> {
    const r = await this.pool.request().input("destination", sql.VarChar(20), destination).query(STATS_SQL);
    const row: any = r.recordset?.[0] ?? {};
    const n = (v: any) => Number(v ?? 0);
    return { pending: n(row.pending), waiting: n(row.waiting), failed: n(row.failed), dead: n(row.dead),
             oldestPendingMinutes: row.oldest_pending_minutes === null || row.oldest_pending_minutes === undefined ? null : Number(row.oldest_pending_minutes) };
  }

  async purgeShadowPayloads(destination: string, retentionDays: number): Promise<number> {
    const r = await this.pool.request().input("destination", sql.VarChar(20), destination).input("days", sql.Int, retentionDays).query(PURGE_SHADOW_SQL);
    return Number(r.recordset?.[0]?.purged ?? 0);
  }

  /** Discovery: upsert store / company rows found in Clearview (never deletes a mapping). */
  async upsertCodes(rows: { codeType: CodeType; company?: string; ukgCode: string; destinationCode: string; destinationId: string | null; notes: string | null }[]): Promise<void> {
    if (!rows.length) return;
    const withCompany = rows.map(r => ({ ...r, company: (r.company ?? "").trim().toUpperCase() }));
    await this.pool.request().input("destination", sql.VarChar(20), this.destination).input("rows", sql.NVarChar(sql.MAX), JSON.stringify(withCompany)).query(`
      MERGE ref.destination_codes WITH (HOLDLOCK) AS t
      USING (SELECT @destination AS destination, codeType AS code_type, company, ukgCode AS ukg_code, destinationCode AS destination_code, destinationId AS destination_id, notes
             FROM OPENJSON(@rows) WITH (codeType varchar(20), company varchar(10), ukgCode varchar(20), destinationCode nvarchar(50), destinationId nvarchar(50), notes nvarchar(200))) AS s
         ON t.destination = s.destination AND t.code_type = s.code_type AND t.company = s.company AND t.ukg_code = s.ukg_code
      WHEN MATCHED THEN UPDATE SET destination_code = s.destination_code, destination_id = s.destination_id, notes = s.notes, updated_utc = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (destination, code_type, company, ukg_code, destination_code, destination_id, notes)
                            VALUES (s.destination, s.code_type, s.company, s.ukg_code, s.destination_code, s.destination_id, s.notes);`);
    this.codes = null;
  }

  /** Discovery: every mapping currently stored for this destination. */
  async allCodes(): Promise<CodeMaps> { this.codes = null; return this.loadCodes(); }

  /** Discovery: distinct store codes the hub knows (org_level2 of current employment rows that look like stores). */
  async hubStores(): Promise<string[]> {
    const r = await this.pool.request().query(`
      SELECT DISTINCT org_level2 FROM stage.employment_current
      WHERE org_level2 IS NOT NULL AND org_level2 LIKE '[TW][0-9][0-9][0-9][0-9][0-9]' ORDER BY org_level2`);
    return (r.recordset ?? []).map((x: any) => String(x.org_level2).toUpperCase());
  }

  /** Discovery (employees extract): employee number + last name + company for everyone the hub knows without an xref. */
  async employeesWithoutXref(): Promise<{ employeeId: string; companyId: string; employeeNumber: string | null; lastName: string | null }[]> {
    const r = await this.pool.request().input("destination", sql.VarChar(20), this.destination).query(`
      SELECT e.employee_id, e.company_id, e.employee_number, e.last_name
      FROM stage.employment_current e
      WHERE NOT EXISTS (SELECT 1 FROM xref.employees x WHERE x.destination = @destination AND x.employee_id = e.employee_id)`);
    return (r.recordset ?? []).map((x: any) => ({ employeeId: x.employee_id, companyId: x.company_id, employeeNumber: nz(x.employee_number), lastName: nz(x.last_name) }));
  }

  async upsertXrefMany(rows: { employeeId: string; externalId: string; source: "extract" | "created" | "matched" }[]): Promise<void> {
    if (!rows.length) return;
    await this.pool.request().input("destination", sql.VarChar(20), this.destination).input("rows", sql.NVarChar(sql.MAX), JSON.stringify(rows)).query(`
      MERGE xref.employees WITH (HOLDLOCK) AS t
      USING (SELECT @destination AS destination, employeeId AS employee_id, externalId AS external_id, source
             FROM OPENJSON(@rows) WITH (employeeId varchar(20), externalId nvarchar(64), source varchar(20))) AS s
         ON t.destination = s.destination AND t.employee_id = s.employee_id
      WHEN MATCHED AND t.external_id <> s.external_id THEN UPDATE SET external_id = s.external_id, source = s.source, updated_utc = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (destination, employee_id, external_id, source) VALUES (s.destination, s.employee_id, s.external_id, s.source);`);
  }
}
