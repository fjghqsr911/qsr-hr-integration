import { sql } from "./sql";
import { HubStore, EmploymentRow, JobHistoryRow, TermCode, SnapshotRow } from "./hubSync";
import { ContactRow } from "./contacts";

/** HubStore backed by sqldb-hrint (stage / ref / rpt schemas). */
export class SqlHubStore implements HubStore {
  constructor(private pool: sql.ConnectionPool) {}

  async lastSyncedUntil(): Promise<Date | null> {
    const r = await this.pool.request().query(`
      SELECT COALESCE(
        (SELECT TOP 1 window_end_utc FROM stage.sync_runs
          WHERE run_type = 'intraday' AND status = 'succeeded' ORDER BY window_end_utc DESC),
        (SELECT MIN(started_utc) FROM stage.sync_runs WHERE run_type = 'backfill')) AS until_utc`);
    const v = r.recordset[0]?.until_utc;
    return v ? new Date(v) : null;
  }

  async isRunning(runType: "intraday" | "nightly"): Promise<boolean> {
    const r = await this.pool.request().input("t", sql.VarChar(20), runType).query(`
      SELECT COUNT(*) AS n FROM stage.sync_runs
      WHERE run_type = @t AND status = 'running' AND started_utc > DATEADD(minute, -30, SYSUTCDATETIME())`);
    return r.recordset[0].n > 0;
  }

  async termCodes(): Promise<Map<string, TermCode>> {
    const r = await this.pool.request().query(`
      SELECT code, category, ISNULL(termination_type, '') AS termination_type
      FROM ref.reason_codes WHERE code_type = 'Termination'`);
    const m = new Map<string, TermCode>();
    for (const row of r.recordset) m.set(String(row.code).trim().toUpperCase(), { category: row.category, type: row.termination_type });
    if (m.size === 0) throw new Error("ref.reason_codes has no termination codes");
    return m;
  }

  async startRun(runType: "intraday" | "nightly", windowStart: Date | null, windowEnd: Date | null): Promise<string> {
    const r = await this.pool.request()
      .input("t", sql.VarChar(20), runType)
      .input("ws", sql.DateTime2(0), windowStart).input("we", sql.DateTime2(0), windowEnd)
      .query(`DECLARE @id uniqueidentifier = NEWID();
              INSERT INTO stage.sync_runs (run_id, run_type, started_utc, window_start_utc, window_end_utc, status)
              VALUES (@id, @t, SYSUTCDATETIME(), @ws, @we, 'running');
              SELECT @id AS run_id;`);
    return r.recordset[0].run_id;
  }

  async finishRun(runId: string, status: string, counts: { employees: number; ukgCalls: number; events?: number }, error?: string) {
    await this.pool.request()
      .input("id", sql.UniqueIdentifier, runId).input("s", sql.VarChar(20), status)
      .input("p", sql.Int, counts.employees).input("c", sql.Int, counts.ukgCalls)
      .input("e", sql.Int, counts.events ?? null).input("err", sql.NVarChar(1000), error ?? null)
      .query(`UPDATE stage.sync_runs SET finished_utc = SYSUTCDATETIME(), status = @s, employees_processed = @p,
                     ukg_calls = @c, events_built = @e, error_summary = @err WHERE run_id = @id`);
  }

  async replaceEmployees(ids: string[], employment: EmploymentRow[], jobHistory: JobHistoryRow[]): Promise<void> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      await new sql.Request(tx)
        .input("ids", sql.NVarChar(sql.MAX), JSON.stringify(ids))
        .input("emp", sql.NVarChar(sql.MAX), JSON.stringify(employment))
        .input("jh", sql.NVarChar(sql.MAX), JSON.stringify(jobHistory))
        .query(`
          DELETE FROM stage.employment_current WHERE employee_id IN (SELECT value FROM OPENJSON(@ids));
          INSERT INTO stage.employment_current
            (employee_id, company_id, employee_number, is_home_company, employee_status, status_start_date, original_hire_date,
             last_hire_date, termination_date, date_last_worked, termination_category, org_level1, org_level2, job_code,
             full_or_part_time, date_in_job, first_name, preferred_name, last_name)
          SELECT employee_id, company_id, employee_number, is_home_company, employee_status, status_start_date, original_hire_date,
                 last_hire_date, termination_date, date_last_worked, termination_category, org_level1, org_level2, job_code,
                 full_or_part_time, date_in_job, first_name, preferred_name, last_name
          FROM OPENJSON(@emp) WITH (
            employee_id varchar(20), company_id varchar(10), employee_number varchar(20), is_home_company bit,
            employee_status char(1), status_start_date date, original_hire_date date, last_hire_date date,
            termination_date date, date_last_worked date, termination_category varchar(20), org_level1 varchar(20),
            org_level2 varchar(20), job_code varchar(20), full_or_part_time char(1), date_in_job date,
            first_name nvarchar(100), preferred_name nvarchar(100), last_name nvarchar(100));

          DELETE FROM stage.job_history WHERE employee_id IN (SELECT value FROM OPENJSON(@ids));
          INSERT INTO stage.job_history
            (system_id, employee_id, company_id, job_effective_date, date_time_created, employee_status, employee_type, job_code,
             job_description, org_level1, org_level2, full_or_part_time, salary_or_hourly, supervisor_id, reason_code,
             termination_category, is_job_change, is_orgchange, is_transfer, is_rate_change, home_company_id)
          SELECT system_id, employee_id, company_id, job_effective_date, date_time_created, employee_status, employee_type, job_code,
                 job_description, org_level1, org_level2, full_or_part_time, salary_or_hourly, supervisor_id, reason_code,
                 termination_category, is_job_change, is_orgchange, is_transfer, is_rate_change, home_company_id
          FROM OPENJSON(@jh) WITH (
            system_id varchar(64), employee_id varchar(20), company_id varchar(10), job_effective_date date,
            date_time_created datetime2(0), employee_status char(1), employee_type varchar(10), job_code varchar(20),
            job_description nvarchar(100), org_level1 varchar(20), org_level2 varchar(20), full_or_part_time char(1),
            salary_or_hourly char(1), supervisor_id varchar(20), reason_code varchar(20), termination_category varchar(20),
            is_job_change bit, is_orgchange bit, is_transfer bit, is_rate_change bit, home_company_id varchar(10));

          /* new job codes seen for the first time (title from the latest job-history row) */
          INSERT INTO ref.job_codes (job_code, job_description)
          SELECT j.job_code, MAX(j.job_description)
          FROM OPENJSON(@jh) WITH (job_code varchar(20), job_description nvarchar(100)) j
          WHERE j.job_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ref.job_codes x WHERE x.job_code = j.job_code)
          GROUP BY j.job_code;`);
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }
  }

  async rebuildEvents(ids: string[]): Promise<number | null> {
    const exists = await this.pool.request().query(`SELECT OBJECT_ID('rpt.usp_rebuild_events', 'P') AS id`);
    if (!exists.recordset[0].id) return null;                       // event rules not installed yet
    const r = await this.pool.request()
      .input("employee_ids", sql.NVarChar(sql.MAX), JSON.stringify(ids))
      .execute("rpt.usp_rebuild_events");                            // signature: @employee_ids nvarchar(max) (JSON array; NULL = all)
    return Number(r.returnValue ?? 0);
  }

  // ---------------- contacts (sensitive tier) ----------------
  /* Intraday: the change feed has no date of birth, so birth_month / birth_day are never changed here
     (matched rows keep the nightly's values; new rows start NULL until the next nightly). */
  async upsertContacts(contacts: ContactRow[], deleteIds: string[]): Promise<void> {
    if (!contacts.length && !deleteIds.length) return;
    await this.pool.request()
      .input("c", sql.NVarChar(sql.MAX), JSON.stringify(contacts))
      .input("d", sql.NVarChar(sql.MAX), JSON.stringify(deleteIds))
      .query(`
        DELETE FROM stage.employee_contact WHERE employee_id IN (SELECT value FROM OPENJSON(@d));
        MERGE stage.employee_contact AS t
        USING (SELECT * FROM OPENJSON(@c) WITH (employee_id varchar(20), personal_email nvarchar(254), work_email nvarchar(254),
                                                work_phone varchar(40), company_phone varchar(40))) AS s
          ON t.employee_id = s.employee_id
        WHEN MATCHED THEN UPDATE SET personal_email = s.personal_email, work_email = s.work_email, work_phone = s.work_phone,
                                     company_phone = s.company_phone, source = 'intraday', updated_utc = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (employee_id, personal_email, work_email, work_phone, company_phone, birth_month, birth_day, source)
                              VALUES (s.employee_id, s.personal_email, s.work_email, s.work_phone, s.company_phone, NULL, NULL, 'intraday');

        /* no contact details and no birthday left -> no row */
        DELETE FROM stage.employee_contact
        WHERE employee_id IN (SELECT employee_id FROM OPENJSON(@c) WITH (employee_id varchar(20)))
          AND personal_email IS NULL AND work_email IS NULL AND work_phone IS NULL AND company_phone IS NULL
          AND birth_month IS NULL;`);
  }

  async replaceAllContacts(contacts: ContactRow[]): Promise<void> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      await new sql.Request(tx).input("c", sql.NVarChar(sql.MAX), JSON.stringify(contacts)).query(`
        DELETE FROM stage.employee_contact;
        INSERT INTO stage.employee_contact (employee_id, personal_email, work_email, work_phone, company_phone, birth_month, birth_day, source)
        SELECT employee_id, personal_email, work_email, work_phone, company_phone, birth_month, birth_day, 'nightly'
        FROM OPENJSON(@c) WITH (employee_id varchar(20), personal_email nvarchar(254), work_email nvarchar(254),
                                work_phone varchar(40), company_phone varchar(40), birth_month tinyint, birth_day tinyint);`);
      await tx.commit();
    } catch (e) { await tx.rollback().catch(() => {}); throw e; }
  }

  // ---------------- nightly ----------------
  async writeSnapshot(snapshotDate: string, rows: SnapshotRow[]): Promise<void> {
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      await new sql.Request(tx).input("d", sql.Date, snapshotDate).input("r", sql.NVarChar(sql.MAX), JSON.stringify(rows)).query(`
        DELETE FROM stage.employment_snapshot WHERE snapshot_date = @d;
        INSERT INTO stage.employment_snapshot (snapshot_date, employee_id, company_id, employee_status, org_level1, org_level2, job_code, full_or_part_time)
        SELECT DISTINCT @d, employee_id, company_id, employee_status, org_level1, org_level2, job_code, full_or_part_time
        FROM OPENJSON(@r) WITH (employee_id varchar(20), company_id varchar(10), employee_status char(1), org_level1 varchar(20),
                                org_level2 varchar(20), job_code varchar(20), full_or_part_time char(1));`);
      await tx.commit();
    } catch (e) { await tx.rollback().catch(() => {}); throw e; }
  }

  async upsertEmployment(rows: EmploymentRow[]): Promise<void> {
    await this.pool.request().input("r", sql.NVarChar(sql.MAX), JSON.stringify(rows)).query(`
      MERGE stage.employment_current AS t
      USING (SELECT * FROM OPENJSON(@r) WITH (
            employee_id varchar(20), company_id varchar(10), employee_number varchar(20), is_home_company bit,
            employee_status char(1), status_start_date date, original_hire_date date, last_hire_date date,
            termination_date date, date_last_worked date, termination_category varchar(20), org_level1 varchar(20),
            org_level2 varchar(20), job_code varchar(20), full_or_part_time char(1), date_in_job date,
            first_name nvarchar(100), preferred_name nvarchar(100), last_name nvarchar(100))) AS s
        ON t.employee_id = s.employee_id AND t.company_id = s.company_id
      WHEN MATCHED THEN UPDATE SET
        employee_number = s.employee_number, is_home_company = s.is_home_company, employee_status = s.employee_status,
        status_start_date = s.status_start_date, original_hire_date = s.original_hire_date, last_hire_date = s.last_hire_date,
        termination_date = s.termination_date, date_last_worked = s.date_last_worked, termination_category = s.termination_category,
        org_level1 = s.org_level1, org_level2 = s.org_level2, job_code = s.job_code, full_or_part_time = s.full_or_part_time,
        date_in_job = s.date_in_job,
        first_name = COALESCE(s.first_name, t.first_name), preferred_name = COALESCE(s.preferred_name, t.preferred_name),
        last_name = COALESCE(s.last_name, t.last_name), updated_utc = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (employee_id, company_id, employee_number, is_home_company, employee_status, status_start_date, original_hire_date,
         last_hire_date, termination_date, date_last_worked, termination_category, org_level1, org_level2, job_code,
         full_or_part_time, date_in_job, first_name, preferred_name, last_name)
        VALUES (s.employee_id, s.company_id, s.employee_number, s.is_home_company, s.employee_status, s.status_start_date,
         s.original_hire_date, s.last_hire_date, s.termination_date, s.date_last_worked, s.termination_category, s.org_level1,
         s.org_level2, s.job_code, s.full_or_part_time, s.date_in_job, s.first_name, s.preferred_name, s.last_name);`);
  }

  async activeEmployeeIds(): Promise<string[]> {
    const r = await this.pool.request().query(`SELECT DISTINCT employee_id FROM stage.employment_current WHERE employee_status IN ('A','L')`);
    return r.recordset.map((x: any) => x.employee_id);
  }

  async knownEmployeeIds(): Promise<string[]> {
    const r = await this.pool.request().query(`SELECT DISTINCT employee_id FROM stage.employment_current`);
    return r.recordset.map((x: any) => x.employee_id);
  }

  async purge(lookbackMonths: number): Promise<number> {
    const r = await this.pool.request().input("LookbackMonths", sql.Int, lookbackMonths).execute("stage.usp_purge_out_of_scope");
    const n = r.recordset?.[0]?.employees_purged;
    // contacts are only kept for current staff, but clear any for purged employees too
    await this.pool.request().query(`DELETE c FROM stage.employee_contact c
      WHERE NOT EXISTS (SELECT 1 FROM stage.employment_current e WHERE e.employee_id = c.employee_id AND e.employee_status IN ('A','L'))`);
    return Number(n ?? 0);
  }

  async hoursSinceIntradaySuccess(): Promise<number | null> {
    const r = await this.pool.request().query(`
      SELECT DATEDIFF(minute, MAX(finished_utc), SYSUTCDATETIME()) / 60.0 AS h
      FROM stage.sync_runs WHERE run_type = 'intraday' AND status = 'succeeded'`);
    const h = r.recordset[0]?.h;
    return h === null || h === undefined ? null : Number(h);
  }
}

