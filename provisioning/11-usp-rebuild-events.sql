/*
  11-usp-rebuild-events.sql - rpt.usp_rebuild_events: workforce events from stage.job_history.
  Run in the Azure portal Query editor on sqldb-hrint AFTER 10-workforce-event-key.sql. Safe to re-run (CREATE OR ALTER).

  Once this procedure exists, every intraday sync and nightly refresh calls it for the employees it touched
  (hubStore.rebuildEvents: @employee_ids = JSON array of employee IDs). Build the full history once with:
      EXEC rpt.usp_rebuild_events @employee_ids = NULL;
  RETURN value = events inserted, changed or removed (stored as stage.sync_runs.events_built).

  Each job-history row is compared with the previous row for the same employee and company. Rules (rule_applied):
    termination      status becomes T. Type from termination_category. Company record ended when the employee is still
                     active or on leave in another company that day. counts_in_turnover only for real exits
                     (Voluntary / Involuntary / Unknown with no other active company), not transfers, no-shows,
                     administrative clean-ups or the end of one of several company records.
    hire             first record for the company. Labelled, in order: Cross-company transfer in when the reason code is
                     a Transfer code (e.g. TRI) or the employee has a transfer-out termination in another company within
                     31 days (from_company / from_store / from_job then show where they came from); Additional company
                     when another company's record started first and is active that day (UKG copies the original hire
                     date to every company record); Rehire when they worked in another company before (or reason
                     code 101); System conversion (Admin codes, e.g. CONV / ACQ); otherwise New hire. So each employee
                     has at most one New hire.
    rehire           status T -> A or L (Cross-company transfer in or Additional company by the same tests).
    leave_start      A -> L.                      leave_return      L -> A.
    store_change     org_level2 changed.          district_change   org_level1 changed, same store.
    job_change       job_code changed.            ftpt_change       full_or_part_time changed.
    pay_change       UKG rate-change flag or a Pay reason code (no amounts are stored).
    reason_only      none of the above, but the reason code creates an event (e.g. 700 Status change). Transfer codes
                     never do: a transfer with no store change (e.g. WLC work-location changes) is not a move.
  A hire, rehire or termination row produces only that event (its store, job and pay are the starting point).
  Blank values on either row never count as a change.

  event_key = SHA-256(employee | company | system_id | rule_applied): the same UKG record always gives the same key, so
  rebuilding is idempotent. Unchanged events are left alone (event_id and built_utc kept); connectors key on event_key.

  Deliveries (after 13-delivery-tables.sql): new and meaningfully changed events are queued in out.deliveries for each
  destination that takes them, only for stores switched to shadow or live in ref.store_modes (step 5). With every store
  off, nothing is queued.
*/
CREATE OR ALTER PROCEDURE rpt.usp_rebuild_events @employee_ids nvarchar(max) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @all bit = CASE WHEN @employee_ids IS NULL THEN 1 ELSE 0 END;
    CREATE TABLE #ids (employee_id varchar(20) NOT NULL PRIMARY KEY);
    IF @all = 0
        INSERT INTO #ids (employee_id)
        SELECT DISTINCT CAST(value AS varchar(20)) FROM OPENJSON(@employee_ids) WHERE NULLIF(value, '') IS NOT NULL;

    /* 1. Job history in order, with the previous row's values */
    SELECT j.employee_id, j.company_id, j.system_id, j.job_effective_date, j.date_time_created,
           j.employee_status AS status, j.org_level1 AS district, j.org_level2 AS store, j.job_code, j.full_or_part_time AS ftpt,
           j.reason_code, j.termination_category, j.is_rate_change,
           ROW_NUMBER()             OVER (PARTITION BY j.employee_id, j.company_id ORDER BY j.job_effective_date, j.date_time_created, j.system_id) AS rn,
           LAG(j.employee_status)   OVER (PARTITION BY j.employee_id, j.company_id ORDER BY j.job_effective_date, j.date_time_created, j.system_id) AS prev_status,
           LAG(j.org_level1)        OVER (PARTITION BY j.employee_id, j.company_id ORDER BY j.job_effective_date, j.date_time_created, j.system_id) AS prev_district,
           LAG(j.org_level2)        OVER (PARTITION BY j.employee_id, j.company_id ORDER BY j.job_effective_date, j.date_time_created, j.system_id) AS prev_store,
           LAG(j.job_code)          OVER (PARTITION BY j.employee_id, j.company_id ORDER BY j.job_effective_date, j.date_time_created, j.system_id) AS prev_job,
           LAG(j.full_or_part_time) OVER (PARTITION BY j.employee_id, j.company_id ORDER BY j.job_effective_date, j.date_time_created, j.system_id) AS prev_ftpt
    INTO #jh
    FROM stage.job_history j
    WHERE @all = 1 OR j.employee_id IN (SELECT employee_id FROM #ids);

    /* Transfer-out terminations (for spotting cross-company moves) */
    SELECT employee_id, company_id, system_id, job_effective_date, store, job_code
    INTO #xfer_out
    FROM #jh
    WHERE status = 'T' AND termination_category = 'Transfer';
    CREATE INDEX ix ON #xfer_out (employee_id, job_effective_date);

    /* Periods each employee is active or on leave in each company: [span_start, span_end) */
    SELECT employee_id, company_id, span_start, span_end
    INTO #spans
    FROM (SELECT employee_id, company_id, status, job_effective_date AS span_start,
                 LEAD(job_effective_date) OVER (PARTITION BY employee_id, company_id
                                                ORDER BY job_effective_date, date_time_created, system_id) AS span_end
          FROM #jh) s
    WHERE status IN ('A', 'L');
    CREATE INDEX ix ON #spans (employee_id, span_start);

    /* Order of each employee's first record per company (the earliest is their real start) */
    SELECT employee_id, company_id,
           ROW_NUMBER() OVER (PARTITION BY employee_id ORDER BY job_effective_date, date_time_created, company_id) AS start_order
    INTO #starts
    FROM #jh
    WHERE rn = 1;

    /* 2. What each row is, and which changes it carries */
    SELECT h.*, rc.category AS rc_category, rc.event_type AS rc_event_type, k.row_kind, f.*,
           x.company_id AS xfer_from_company, x.store AS xfer_from_store, x.job_code AS xfer_from_job,
           ISNULL(st.start_order, 1) AS start_order, a.active_elsewhere,
           CASE WHEN k.row_kind = 'continuing' AND rc.creates_event = 1 AND rc.category NOT IN ('Hire', 'Termination', 'Transfer')
                     AND f.leave_start + f.leave_return + f.store_changed + f.district_changed + f.job_changed
                         + f.ftpt_changed + f.pay_changed = 0
                THEN 1 ELSE 0 END AS reason_only
    INTO #rows
    FROM #jh h
    LEFT JOIN ref.reason_codes rc ON rc.code_type = 'JobChange' AND rc.code = h.reason_code
    CROSS APPLY (SELECT CASE WHEN h.status = 'T' AND ISNULL(h.prev_status, '') <> 'T' THEN 'termination'
                             WHEN h.status = 'T'                                     THEN 'still_terminated'
                             WHEN h.rn = 1                                           THEN 'hire'
                             WHEN h.prev_status = 'T'                                THEN 'rehire'
                             ELSE 'continuing' END AS row_kind) k
    CROSS APPLY (SELECT
        CASE WHEN k.row_kind = 'continuing' AND h.prev_status = 'A' AND h.status = 'L' THEN 1 ELSE 0 END AS leave_start,
        CASE WHEN k.row_kind = 'continuing' AND h.prev_status = 'L' AND h.status = 'A' THEN 1 ELSE 0 END AS leave_return,
        CASE WHEN k.row_kind = 'continuing' AND h.prev_store <> h.store THEN 1 ELSE 0 END AS store_changed,
        CASE WHEN k.row_kind = 'continuing' AND h.prev_district <> h.district
                  AND NOT (h.prev_store <> h.store) THEN 1 ELSE 0 END AS district_changed,
        CASE WHEN k.row_kind = 'continuing' AND h.prev_job <> h.job_code THEN 1 ELSE 0 END AS job_changed,
        CASE WHEN k.row_kind = 'continuing' AND h.prev_ftpt <> h.ftpt THEN 1 ELSE 0 END AS ftpt_changed,
        CASE WHEN k.row_kind = 'continuing' AND (h.is_rate_change = 1 OR rc.category = 'Pay') THEN 1 ELSE 0 END AS pay_changed
    ) f
    /* A start in this company within 31 days of a transfer-out termination in another company = a cross-company move */
    OUTER APPLY (SELECT TOP 1 o.company_id, o.store, o.job_code
                 FROM #xfer_out o
                 WHERE k.row_kind IN ('hire', 'rehire')
                   AND o.employee_id = h.employee_id AND o.company_id <> h.company_id
                   AND o.job_effective_date BETWEEN DATEADD(day, -31, h.job_effective_date) AND DATEADD(day, 31, h.job_effective_date)
                 ORDER BY ABS(DATEDIFF(day, o.job_effective_date, h.job_effective_date)), o.system_id) x
    LEFT JOIN #starts st ON st.employee_id = h.employee_id AND st.company_id = h.company_id AND h.rn = 1
    /* Still active or on leave in another company on this date? Then a start or end here is not a hire or an exit */
    CROSS APPLY (SELECT CASE WHEN k.row_kind IN ('hire', 'rehire', 'termination') AND EXISTS (
                        SELECT 1 FROM #spans s
                        WHERE s.employee_id = h.employee_id AND s.company_id <> h.company_id
                          AND s.span_start <= h.job_effective_date
                          AND (s.span_end IS NULL OR s.span_end > h.job_effective_date))
                      THEN 1 ELSE 0 END AS active_elsewhere) a;
    /* (<> is never true when either side is NULL, so blank values never count as a change) */

    /* 3. One event per rule that fires */
    SELECT r.employee_id, r.company_id, v.rule_applied, LEFT(v.event_type, 40) AS event_type,
           r.job_effective_date AS effective_date, r.date_time_created AS entered_utc,
           CASE WHEN v.rule_applied IN ('hire', 'rehire') THEN r.xfer_from_company ELSE r.company_id END AS from_company,
           CASE WHEN v.rule_applied = 'termination'       THEN NULL ELSE r.company_id END       AS to_company,
           CASE WHEN v.rule_applied IN ('hire', 'rehire') THEN r.xfer_from_store
                WHEN v.rule_applied = 'termination'       THEN r.store ELSE r.prev_store END    AS from_store,
           CASE WHEN v.rule_applied = 'termination'       THEN NULL ELSE r.store END            AS to_store,
           CASE WHEN v.rule_applied IN ('hire', 'rehire') THEN r.xfer_from_job
                WHEN v.rule_applied = 'termination'       THEN r.job_code ELSE r.prev_job END   AS from_job,
           CASE WHEN v.rule_applied = 'termination'       THEN NULL ELSE r.job_code END         AS to_job,
           CASE WHEN v.rule_applied = 'termination' THEN r.termination_category END             AS termination_category,
           CASE WHEN v.rule_applied = 'termination'
                THEN CASE WHEN r.termination_category IN ('Voluntary', 'Involuntary', 'Unknown') AND r.active_elsewhere = 0
                          THEN 1 ELSE 0 END
           END                                                                                  AS counts_in_turnover,
           r.reason_code,
           CAST(r.system_id AS varchar(400))                                                    AS source_system_ids,
           CAST(HASHBYTES('SHA2_256', CONCAT(r.employee_id, '|', r.company_id, '|', r.system_id, '|', v.rule_applied)) AS binary(32)) AS event_key
    INTO #ev
    FROM #rows r
    CROSS APPLY (VALUES
        ('termination',
            CASE r.termination_category WHEN 'No-show'        THEN 'Hired but never worked'
                                        WHEN 'Transfer'       THEN 'Cross-company transfer out'
                                        WHEN 'Administrative' THEN 'Administrative termination'
                                        ELSE CASE WHEN r.active_elsewhere = 1 THEN 'Company record ended' ELSE 'Termination' END END,
            CASE WHEN r.row_kind = 'termination' THEN 1 ELSE 0 END),
        ('hire',
            CASE WHEN r.rc_category = 'Transfer' OR r.xfer_from_company IS NOT NULL THEN 'Cross-company transfer in'
                 WHEN r.start_order > 1 AND r.active_elsewhere = 1 THEN 'Additional company'
                 WHEN r.start_order > 1 OR r.rc_event_type = 'Rehire' THEN 'Rehire'
                 WHEN r.rc_category = 'Admin'    THEN 'System conversion'
                 ELSE 'New hire' END,
            CASE WHEN r.row_kind = 'hire' THEN 1 ELSE 0 END),
        ('rehire',
            CASE WHEN r.rc_category = 'Transfer' OR r.xfer_from_company IS NOT NULL THEN 'Cross-company transfer in'
                 WHEN r.active_elsewhere = 1 THEN 'Additional company'
                 ELSE 'Rehire' END,
            CASE WHEN r.row_kind = 'rehire' THEN 1 ELSE 0 END),
        ('leave_start',     'Leave of absence',  r.leave_start),
        ('leave_return',    'Return from leave', r.leave_return),
        ('store_change',    CASE WHEN r.rc_event_type = 'Temporary transfer' THEN 'Temporary transfer' ELSE 'Store transfer' END, r.store_changed),
        ('district_change', 'District realignment', r.district_changed),
        ('job_change',      CASE WHEN r.rc_event_type IN ('Promotion', 'Demotion') THEN r.rc_event_type ELSE 'Job change' END, r.job_changed),
        ('ftpt_change',     CASE WHEN r.ftpt = 'F' THEN 'Part-time to full-time' ELSE 'Full-time to part-time' END, r.ftpt_changed),
        ('pay_change',      'Pay change', r.pay_changed),
        ('reason_only',     r.rc_event_type, r.reason_only)
    ) v (rule_applied, event_type, fires)
    WHERE v.fires = 1;

    /* 4. Apply: insert new, update changed, remove events these employees no longer have. Then (5) queue deliveries,
          in the same transaction, so an event change and its deliveries are written together or not at all. */
    DECLARE @changes TABLE (
        action nvarchar(10), event_key binary(32), employee_id varchar(20),
        event_type varchar(40), effective_date date, from_company varchar(10), to_company varchar(10),
        from_store varchar(20), to_store varchar(20), from_job varchar(20), to_job varchar(20), termination_category varchar(20),
        old_event_type varchar(40), old_effective_date date, old_from_company varchar(10), old_to_company varchar(10),
        old_from_store varchar(20), old_to_store varchar(20), old_from_job varchar(20), old_to_job varchar(20),
        old_termination_category varchar(20));

    BEGIN TRAN;
    WITH scoped AS (
        SELECT * FROM rpt.workforce_events
        WHERE @all = 1 OR employee_id IN (SELECT employee_id FROM #ids))
    MERGE scoped AS t
    USING #ev AS s ON t.event_key = s.event_key
    WHEN MATCHED AND EXISTS (
            SELECT s.employee_id, s.event_type, s.effective_date, s.entered_utc, s.from_company, s.to_company, s.from_store, s.to_store,
                   s.from_job, s.to_job, s.termination_category, s.counts_in_turnover, s.reason_code, s.rule_applied, s.source_system_ids
            EXCEPT
            SELECT t.employee_id, t.event_type, t.effective_date, t.entered_utc, t.from_company, t.to_company, t.from_store, t.to_store,
                   t.from_job, t.to_job, t.termination_category, t.counts_in_turnover, t.reason_code, t.rule_applied, t.source_system_ids)
        THEN UPDATE SET
            employee_id = s.employee_id, event_type = s.event_type, effective_date = s.effective_date, entered_utc = s.entered_utc,
            from_company = s.from_company, to_company = s.to_company, from_store = s.from_store, to_store = s.to_store,
            from_job = s.from_job, to_job = s.to_job, termination_category = s.termination_category,
            counts_in_turnover = s.counts_in_turnover, reason_code = s.reason_code, rule_applied = s.rule_applied,
            source_system_ids = s.source_system_ids, built_utc = SYSUTCDATETIME()
    WHEN NOT MATCHED BY TARGET THEN
        INSERT (employee_id, event_type, effective_date, entered_utc, from_company, to_company, from_store, to_store,
                from_job, to_job, termination_category, counts_in_turnover, reason_code, rule_applied, source_system_ids,
                built_utc, event_key)
        VALUES (s.employee_id, s.event_type, s.effective_date, s.entered_utc, s.from_company, s.to_company, s.from_store, s.to_store,
                s.from_job, s.to_job, s.termination_category, s.counts_in_turnover, s.reason_code, s.rule_applied, s.source_system_ids,
                SYSUTCDATETIME(), s.event_key)
    WHEN NOT MATCHED BY SOURCE THEN DELETE
    OUTPUT $action, COALESCE(inserted.event_key, deleted.event_key), COALESCE(inserted.employee_id, deleted.employee_id),
           inserted.event_type, inserted.effective_date, inserted.from_company, inserted.to_company,
           inserted.from_store, inserted.to_store, inserted.from_job, inserted.to_job, inserted.termination_category,
           deleted.event_type, deleted.effective_date, deleted.from_company, deleted.to_company,
           deleted.from_store, deleted.to_store, deleted.from_job, deleted.to_job, deleted.termination_category
    INTO @changes;

    /* 5. Queue deliveries (skipped until 13-delivery-tables.sql has been run).
          For each destination that takes the event type (ref.destination_events), when its new store, its old store
          (terminations) or either store of a move is shadow or live (ref.store_modes; no row = off):
            new event                                   -> pending
            changed date / store / job / company / termination category -> pending, next version (a label alone: nothing)
            removed by UKG (a correction)               -> review (nothing is sent automatically)
          Older pending or failed versions of the same event are marked superseded. */
    IF OBJECT_ID('out.deliveries', 'U') IS NOT NULL
    BEGIN
        ;WITH q AS (
            SELECT c.event_key, c.employee_id,
                   CASE WHEN c.action = 'DELETE' THEN 'removed' ELSE 'event' END AS kind,
                   COALESCE(c.event_type, c.old_event_type)         AS event_type,
                   COALESCE(c.effective_date, c.old_effective_date) AS effective_date,
                   CASE WHEN c.action = 'DELETE' THEN c.old_from_store ELSE c.from_store END AS from_store,
                   CASE WHEN c.action = 'DELETE' THEN c.old_to_store   ELSE c.to_store   END AS to_store
            FROM @changes c
            WHERE c.action IN ('INSERT', 'DELETE')
               OR (c.action = 'UPDATE' AND EXISTS (
                     SELECT c.effective_date, c.from_company, c.to_company, c.from_store, c.to_store, c.from_job, c.to_job, c.termination_category
                     EXCEPT
                     SELECT c.old_effective_date, c.old_from_company, c.old_to_company, c.old_from_store, c.old_to_store,
                            c.old_from_job, c.old_to_job, c.old_termination_category)))
        INSERT INTO [out].deliveries (destination, event_key, version, kind, employee_id, event_type, action, effective_date, store, status)
        SELECT de.destination, q.event_key, ISNULL(v.max_version, 0) + 1, q.kind, q.employee_id, q.event_type, de.action,
               q.effective_date, m.store, CASE WHEN q.kind = 'removed' THEN 'review' ELSE 'pending' END
        FROM q
        JOIN ref.destination_events de ON de.event_type = q.event_type
        CROSS APPLY (SELECT TOP 1 sm.store FROM ref.store_modes sm
                     WHERE sm.destination = de.destination AND sm.mode IN ('shadow', 'live') AND sm.store IN (q.to_store, q.from_store)
                     ORDER BY CASE WHEN sm.store = q.to_store THEN 0 ELSE 1 END) m
        OUTER APPLY (SELECT MAX(d.version) AS max_version FROM [out].deliveries d
                     WHERE d.destination = de.destination AND d.event_key = q.event_key) v;

        UPDATE d SET status = 'superseded', finished_utc = SYSUTCDATETIME()
        FROM [out].deliveries d
        WHERE d.status IN ('pending', 'failed')
          AND d.event_key IN (SELECT event_key FROM @changes)
          AND EXISTS (SELECT 1 FROM [out].deliveries n
                      WHERE n.destination = d.destination AND n.event_key = d.event_key AND n.version > d.version);
    END
    COMMIT;

    DECLARE @n int = (SELECT COUNT(*) FROM @changes);
    RETURN @n;
END
