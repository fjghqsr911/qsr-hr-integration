/*
  10-workforce-event-key.sql - stable keys for rpt.workforce_events, and indexes for rpt.usp_rebuild_events.
  Run in the Azure portal Query editor on sqldb-hrint. Safe to re-run. Run before 11-usp-rebuild-events.sql.

  event_key = SHA-256 of employee | company | job-history system_id | rule. The same UKG record always produces the same
  key, however many times events are rebuilt, so connectors and the delivery queue use event_key (never event_id).
  Statements that must start a batch go through EXEC (the Query editor does not support GO).
*/
IF COL_LENGTH('rpt.workforce_events','event_key') IS NULL
    ALTER TABLE rpt.workforce_events ADD event_key binary(32) NULL;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('rpt.workforce_events') AND name = 'ux_workforce_events_key')
    EXEC('CREATE UNIQUE INDEX ux_workforce_events_key ON rpt.workforce_events (event_key) WHERE event_key IS NOT NULL');

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('rpt.workforce_events') AND name = 'ix_workforce_events_employee')
    CREATE INDEX ix_workforce_events_employee ON rpt.workforce_events (employee_id, effective_date);

/* job history read per employee, in order */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('stage.job_history') AND name = 'ix_job_history_employee')
    CREATE INDEX ix_job_history_employee ON stage.job_history (employee_id, company_id, job_effective_date, date_time_created)
        INCLUDE (employee_status, job_code, org_level1, org_level2, full_or_part_time, reason_code, termination_category, is_rate_change);

/* event_id: the procedure never supplies it. If it is not an identity column, number it from a sequence. */
IF COLUMNPROPERTY(OBJECT_ID('rpt.workforce_events'), 'event_id', 'IsIdentity') = 0
   AND NOT EXISTS (SELECT 1 FROM sys.default_constraints
                   WHERE parent_object_id = OBJECT_ID('rpt.workforce_events')
                     AND parent_column_id = COLUMNPROPERTY(OBJECT_ID('rpt.workforce_events'), 'event_id', 'ColumnId'))
BEGIN
    DECLARE @start nvarchar(20) = (SELECT CAST(ISNULL(MAX(event_id), 0) + 1 AS nvarchar(20)) FROM rpt.workforce_events);
    IF OBJECT_ID('rpt.seq_workforce_event_id', 'SO') IS NULL
        EXEC('CREATE SEQUENCE rpt.seq_workforce_event_id AS bigint START WITH ' + @start);
    EXEC('ALTER TABLE rpt.workforce_events ADD CONSTRAINT df_workforce_events_id DEFAULT (NEXT VALUE FOR rpt.seq_workforce_event_id) FOR event_id');
END

/* check */
SELECT COL_LENGTH('rpt.workforce_events','event_key')                                        AS event_key_col,
       COLUMNPROPERTY(OBJECT_ID('rpt.workforce_events'), 'event_id', 'IsIdentity')            AS event_id_is_identity,
       OBJECT_ID('rpt.seq_workforce_event_id', 'SO')                                         AS event_id_sequence,
       (SELECT COUNT(*) FROM sys.indexes WHERE name IN ('ux_workforce_events_key','ix_workforce_events_employee','ix_job_history_employee')) AS indexes_present;
