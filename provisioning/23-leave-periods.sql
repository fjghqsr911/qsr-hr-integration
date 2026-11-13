-- 23-leave-periods.sql: leave of absence periods from UKG status history, kept apart from job history.
-- Why: UKG writes job history (EmpHJob) only for hires, terminations and rehires. A leave start or return changes
-- status history (EmpHStat) only, so leave status reached job history only when another job change happened to be
-- entered during the leave (the yearly minimum wage update, for example). Leave events built from job history were
-- late, missed or merged. Leave events now come from stage.leave_periods instead (see 11-usp-rebuild-events.sql).
--
-- Where periods come from:
--   status      the syncs. Every employment row hrint-api reads carries the current status and its start date.
--               stage.usp_capture_status runs before stage.employment_current is overwritten: status L opens a period
--               starting on the status start date; status A or T closes the open period the day before. A later
--               L start while on leave (a change of leave type) closes the old period the day before and opens a
--               new one; back to back periods count as one leave for events.
--   loa_report  the UKG People Analytics report QSR Detail LOA History, converted with
--               provisioning/tools/loa-report-to-sql.py (keeps employee number, start and stop only) and loaded with
--               stage.usp_import_leave_periods. Used for the backfill and, later, for reconciliation.
-- A leave that started and ended before a sync saw it (both entered after the fact) cannot be seen by the syncs. The
-- capture raises a data quality issue (status_change_not_seen) when a status restarts with no period to explain it;
-- the LOA report fills the gap.
--
-- Nothing about the leave reason is stored. Periods hold dates only.
--
-- Run in the Azure portal Query editor on sqldb-hrint (open from the database, not master) as the Entra admin,
-- BEFORE the updated 11-usp-rebuild-events.sql. Safe to re-run.
-- Comments contain no apostrophes and no dashes other than the comment marker.

IF OBJECT_ID('stage.leave_periods', 'U') IS NULL
    CREATE TABLE stage.leave_periods (
        employee_id    varchar(20)  NOT NULL,
        company_id     varchar(10)  NOT NULL,
        leave_start    date         NOT NULL,     -- first day on leave
        leave_end      date         NULL,         -- last day on leave (return = next day); NULL while on leave
        source         varchar(20)  NOT NULL CONSTRAINT ck_leave_periods_source CHECK (source IN ('status', 'loa_report')),
        start_seen_utc datetime2(0) NULL,         -- when a sync first saw the leave (NULL when only the report had it)
        end_seen_utc   datetime2(0) NULL,         -- when a sync first saw the return
        updated_utc    datetime2(0) NOT NULL CONSTRAINT df_leave_periods_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT pk_leave_periods PRIMARY KEY (employee_id, company_id, leave_start));
GO

/* Called by hrint-api (hubStore.replaceEmployees and upsertEmployment) with the employment rows it is about to write,
   before stage.employment_current is overwritten. @emp = JSON array of
   {employee_id, company_id, employee_status, status_start_date, org_level2}. */
CREATE OR ALTER PROCEDURE stage.usp_capture_status @emp nvarchar(max)
AS
BEGIN
    SET NOCOUNT ON;

    SELECT employee_id, company_id, employee_status AS status, status_start_date AS start_date, org_level2 AS store,
           ROW_NUMBER() OVER (PARTITION BY employee_id, company_id ORDER BY status_start_date DESC) AS rn
    INTO #n
    FROM OPENJSON(@emp) WITH (employee_id varchar(20), company_id varchar(10), employee_status char(1),
                              status_start_date date, org_level2 varchar(20))
    WHERE employee_id IS NOT NULL AND company_id IS NOT NULL AND status_start_date IS NOT NULL
      AND employee_status IN ('A', 'L', 'T');
    DELETE FROM #n WHERE rn > 1;

    /* 1. An active status that restarted with nothing to explain it: the employee was A since one date and is now A
          since a later date, and no period starts or ends there. Something happened in between that was entered after
          the fact (typically a leave and its return entered together). Compared with the row about to be replaced, so
          it fires once. An L restart is a change of leave type and is handled in step 2. Skipped when
          rpt.data_quality_issues has no identity key. */
    IF COLUMNPROPERTY(OBJECT_ID('rpt.data_quality_issues'), 'issue_id', 'IsIdentity') = 1
        INSERT INTO rpt.data_quality_issues (issue_type, employee_id, company_id, store, detail, detected_utc)
        SELECT 'status_change_not_seen', n.employee_id, n.company_id, n.store,
               CONCAT('Status ', n.status, ' restarted on ', CONVERT(char(10), n.start_date, 23), ' (was ', c.employee_status,
                      ' since ', CONVERT(char(10), c.status_start_date, 23),
                      '). A status change in between was entered after the fact. Reconcile with the LOA report.'),
               SYSUTCDATETIME()
        FROM #n n
        JOIN stage.employment_current c ON c.employee_id = n.employee_id AND c.company_id = n.company_id
        WHERE n.status = 'A' AND c.employee_status = n.status
          AND c.status_start_date IS NOT NULL AND n.start_date > c.status_start_date
          AND NOT EXISTS (SELECT 1 FROM stage.leave_periods p
                          WHERE p.employee_id = n.employee_id AND p.company_id = n.company_id
                            AND (p.leave_start = n.start_date OR p.leave_end = DATEADD(day, -1, n.start_date)));

    /* 2. On leave: open a period on the status start date (or reopen it when a return was reversed) */
    UPDATE p SET leave_end = NULL, end_seen_utc = NULL, updated_utc = SYSUTCDATETIME()
    FROM stage.leave_periods p
    JOIN #n n ON n.employee_id = p.employee_id AND n.company_id = p.company_id AND n.start_date = p.leave_start
    WHERE n.status = 'L' AND p.leave_end IS NOT NULL;

    /* A later L start while a period is open is a change of leave type: UKG ended the old period the day before.
       Closing it makes the two periods back to back, which the event rebuild treats as one leave. */
    UPDATE p SET leave_end = DATEADD(day, -1, n.start_date), end_seen_utc = SYSUTCDATETIME(), updated_utc = SYSUTCDATETIME()
    FROM stage.leave_periods p
    JOIN #n n ON n.employee_id = p.employee_id AND n.company_id = p.company_id
    WHERE n.status = 'L' AND p.leave_end IS NULL AND p.leave_start < n.start_date;

    INSERT INTO stage.leave_periods (employee_id, company_id, leave_start, leave_end, source, start_seen_utc)
    SELECT n.employee_id, n.company_id, n.start_date, NULL, 'status', SYSUTCDATETIME()
    FROM #n n
    WHERE n.status = 'L'
      AND NOT EXISTS (SELECT 1 FROM stage.leave_periods p
                      WHERE p.employee_id = n.employee_id AND p.company_id = n.company_id AND p.leave_start = n.start_date);

    /* 3. Active or terminated: close the open period the day before the new status started */
    UPDATE p SET leave_end = DATEADD(day, -1, n.start_date), end_seen_utc = SYSUTCDATETIME(), updated_utc = SYSUTCDATETIME()
    FROM stage.leave_periods p
    JOIN #n n ON n.employee_id = p.employee_id AND n.company_id = p.company_id
    WHERE n.status IN ('A', 'T') AND p.leave_end IS NULL AND p.leave_start < n.start_date;

    /* 4. Active or terminated since on or before the start of a period the syncs opened: that leave was cancelled */
    DELETE p
    FROM stage.leave_periods p
    JOIN #n n ON n.employee_id = p.employee_id AND n.company_id = p.company_id
    WHERE n.status IN ('A', 'T') AND p.leave_end IS NULL AND p.leave_start >= n.start_date AND p.source = 'status';
END
GO

/* Loads leave periods from the LOA report (via provisioning/tools/loa-report-to-sql.py).
   @rows = JSON array of {"n": employee number, "s": first day on leave, "e": last day on leave or null}.
   Employee numbers never change; each is matched to its hub employee (home company first).
   @dry_run = 1 is the reconciliation: it compares the report with the hub and writes nothing.
   @rebuild = 1 rebuilds events for the employees whose periods changed.
   Returns: a summary row, then one row per difference (dry run) or per change (load). */
CREATE OR ALTER PROCEDURE stage.usp_import_leave_periods @rows nvarchar(max), @dry_run bit = 0, @rebuild bit = 1
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    SELECT DISTINCT LTRIM(RTRIM(n)) AS employee_number, s AS leave_start, e AS leave_end
    INTO #raw
    FROM OPENJSON(@rows) WITH (n varchar(20), s date, e date)
    WHERE NULLIF(LTRIM(RTRIM(n)), '') IS NOT NULL AND s IS NOT NULL;

    SELECT r.employee_number, r.leave_start, r.leave_end, m.employee_id, m.company_id,
           CASE WHEN m.employee_id IS NULL                       THEN 'unknown_employee'
                WHEN r.leave_end = DATEADD(day, -1, r.leave_start) THEN 'cancelled'
                WHEN r.leave_end < r.leave_start                 THEN 'stop_before_start'
                ELSE 'ok' END AS outcome
    INTO #in
    FROM #raw r
    OUTER APPLY (SELECT TOP 1 ec.employee_id, ec.company_id
                 FROM stage.employment_current ec
                 WHERE ec.employee_number = r.employee_number
                 ORDER BY ec.is_home_company DESC, CASE WHEN ec.employee_status IN ('A', 'L') THEN 0 ELSE 1 END,
                          ec.updated_utc DESC) m;

    /* One period per employee, company and start: a still running row wins, else the latest stop */
    SELECT employee_id, company_id, leave_start,
           CASE WHEN SUM(CASE WHEN leave_end IS NULL THEN 1 ELSE 0 END) > 0 THEN NULL ELSE MAX(leave_end) END AS leave_end,
           MIN(employee_number) AS employee_number
    INTO #ok
    FROM #in WHERE outcome = 'ok'
    GROUP BY employee_id, company_id, leave_start;

    DECLARE @from date = (SELECT MIN(leave_start) FROM #ok);

    /* Differences between the report and the hub */
    SELECT d.kind, d.employee_number, d.employee_id, d.company_id, d.leave_start, d.report_end, d.hub_end, d.hub_source
    INTO #diff
    FROM (
        SELECT CASE WHEN p.employee_id IS NULL THEN 'missing_in_hub' ELSE 'end_differs' END AS kind,
               o.employee_number, o.employee_id, o.company_id, o.leave_start,
               o.leave_end AS report_end, p.leave_end AS hub_end, p.source AS hub_source
        FROM #ok o
        LEFT JOIN stage.leave_periods p
               ON p.employee_id = o.employee_id AND p.company_id = o.company_id AND p.leave_start = o.leave_start
        WHERE p.employee_id IS NULL
           OR ISNULL(p.leave_end, '9999-12-31') <> ISNULL(o.leave_end, '9999-12-31')
        UNION ALL
        SELECT 'not_in_report', ec.employee_number, p.employee_id, p.company_id, p.leave_start,
               NULL, p.leave_end, p.source
        FROM stage.leave_periods p
        OUTER APPLY (SELECT TOP 1 employee_number FROM stage.employment_current x
                     WHERE x.employee_id = p.employee_id AND x.company_id = p.company_id) ec
        WHERE p.leave_start >= @from
          AND NOT EXISTS (SELECT 1 FROM #ok o
                          WHERE o.employee_id = p.employee_id AND o.company_id = p.company_id AND o.leave_start = p.leave_start)
    ) d;

    DECLARE @removed int = 0, @affected nvarchar(max);

    IF @dry_run = 0
    BEGIN
        BEGIN TRAN;
        /* The report is the source of truth for every period it covers */
        MERGE stage.leave_periods AS t
        USING #ok AS s ON t.employee_id = s.employee_id AND t.company_id = s.company_id AND t.leave_start = s.leave_start
        WHEN MATCHED AND ISNULL(t.leave_end, '9999-12-31') <> ISNULL(s.leave_end, '9999-12-31')
            THEN UPDATE SET leave_end = s.leave_end, source = 'loa_report', updated_utc = SYSUTCDATETIME()
        WHEN NOT MATCHED BY TARGET
            THEN INSERT (employee_id, company_id, leave_start, leave_end, source) VALUES (s.employee_id, s.company_id, s.leave_start, s.leave_end, 'loa_report');

        /* Periods an earlier report load created that this report no longer has were removed in UKG. Periods the syncs
           saw are kept and listed as not_in_report for a person to check. */
        DELETE p FROM stage.leave_periods p
        JOIN #diff d ON d.kind = 'not_in_report' AND d.employee_id = p.employee_id AND d.company_id = p.company_id
                    AND d.leave_start = p.leave_start
        WHERE p.source = 'loa_report';
        SET @removed = @@ROWCOUNT;
        COMMIT;

        /* Employees whose periods changed: everything in the report diff, plus removed report periods */
        SET @affected = (SELECT '[' + STRING_AGG(CAST(CONCAT('"', employee_id, '"') AS nvarchar(max)), ',') + ']'
                         FROM (SELECT DISTINCT employee_id FROM #diff
                               WHERE kind <> 'not_in_report' OR hub_source = 'loa_report') x);
        IF @rebuild = 1 AND @affected IS NOT NULL AND OBJECT_ID('rpt.usp_rebuild_events', 'P') IS NOT NULL
            EXEC rpt.usp_rebuild_events @employee_ids = @affected;
    END

    SELECT CASE WHEN @dry_run = 1 THEN 'dry run (nothing written)' ELSE 'loaded' END AS mode,
           (SELECT COUNT(*) FROM #raw)                                         AS report_rows,
           (SELECT COUNT(*) FROM #ok)                                          AS periods,
           (SELECT COUNT(*) FROM #in WHERE outcome = 'unknown_employee')       AS unknown_employee,
           (SELECT COUNT(*) FROM #in WHERE outcome = 'cancelled')              AS cancelled_skipped,
           (SELECT COUNT(*) FROM #in WHERE outcome = 'stop_before_start')      AS stop_before_start_skipped,
           (SELECT COUNT(*) FROM #diff WHERE kind = 'missing_in_hub')          AS missing_in_hub,
           (SELECT COUNT(*) FROM #diff WHERE kind = 'end_differs')             AS end_differs,
           (SELECT COUNT(*) FROM #diff WHERE kind = 'not_in_report')           AS not_in_report,
           @removed                                                            AS removed_report_periods;

    SELECT kind, employee_number, company_id, leave_start, report_end, hub_end, hub_source FROM #diff
    UNION ALL
    SELECT outcome, employee_number, company_id, leave_start, leave_end, NULL, NULL FROM #in WHERE outcome = 'stop_before_start'
    ORDER BY 1, 2, 4;
END
GO

/* The purge of employees out of scope also removes their leave periods (same as the original, plus one line) */
CREATE OR ALTER PROCEDURE stage.usp_purge_out_of_scope @LookbackMonths int = 24
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @cutoff date = DATEADD(month, -@LookbackMonths, CAST(SYSDATETIME() AS date));

    /* Employees whose every company record is terminated before the cutoff */
    SELECT employee_id INTO #out
    FROM stage.employment_current
    GROUP BY employee_id
    HAVING SUM(CASE WHEN employee_status IN ('A','L') OR termination_date >= @cutoff OR termination_date IS NULL THEN 1 ELSE 0 END) = 0;

    DELETE e FROM rpt.workforce_events e      JOIN #out o ON o.employee_id = e.employee_id;
    DELETE d FROM rpt.data_quality_issues d   JOIN #out o ON o.employee_id = d.employee_id;
    DELETE j FROM stage.job_history j         JOIN #out o ON o.employee_id = j.employee_id;
    DELETE l FROM stage.leave_periods l       JOIN #out o ON o.employee_id = l.employee_id;
    DELETE c FROM stage.employment_current c  JOIN #out o ON o.employee_id = c.employee_id;
    DELETE b FROM stage.backfill_progress b   JOIN #out o ON o.employee_id = b.employee_id;

    /* Daily snapshots are kept for the same lookback period */
    DELETE FROM stage.employment_snapshot WHERE snapshot_date < @cutoff;

    SELECT COUNT(*) AS employees_purged FROM #out;
END
GO

/* The syncs call stage.usp_capture_status as the Function App user. Without this grant every sync would fail. */
DECLARE @app sysname = N'mi-func-hrint';
DECLARE @sql nvarchar(max);
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @app)
BEGIN
    SET @sql = N'GRANT EXECUTE ON OBJECT::stage.usp_capture_status TO ' + QUOTENAME(@app) + N';';
    EXEC sp_executesql @sql;
END;

/* Verification: capture_execute_grants must be 1 (0 means the syncs cannot record leave and will fail) */
SELECT (SELECT COUNT(*) FROM sys.database_permissions p JOIN sys.database_principals dp ON dp.principal_id = p.grantee_principal_id
        WHERE dp.name = @app AND p.major_id = OBJECT_ID('stage.usp_capture_status') AND p.permission_name = 'EXECUTE') AS capture_execute_grants,
       (SELECT COUNT(*) FROM stage.leave_periods)                               AS leave_periods,
       (SELECT COUNT(*) FROM stage.leave_periods WHERE leave_end IS NULL)       AS on_leave_now,
       OBJECT_ID('stage.usp_capture_status', 'P')                               AS capture_proc,
       OBJECT_ID('stage.usp_import_leave_periods', 'P')                         AS import_proc,
       COLUMNPROPERTY(OBJECT_ID('rpt.data_quality_issues'), 'issue_id', 'IsIdentity') AS dq_issue_id_is_identity;
