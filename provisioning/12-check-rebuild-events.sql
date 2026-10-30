/*
  12-check-rebuild-events.sql - dry run of rpt.usp_rebuild_events for everyone, then ROLLBACK (nothing is kept).
  Run in the Azure portal Query editor on sqldb-hrint after 10 and 11. Avoid :05 past 10/14/18/22 UTC (the
  intraday sync would wait on this transaction). Returns one result: events by rule and type, then two checks:
    changes on first run    = events the full build would write
    changes on second run   = must be 0 (rebuilding the same data changes nothing)
  Counts only; no names or personal data.
*/
SET XACT_ABORT ON;
DECLARE @summary TABLE (rule_applied varchar(60), event_type varchar(40), events int, employees int,
                        first_effective date, last_effective date);
DECLARE @first int, @second int;

BEGIN TRAN;
    EXEC @first = rpt.usp_rebuild_events @employee_ids = NULL;

    INSERT INTO @summary
    SELECT rule_applied, event_type, COUNT(*), COUNT(DISTINCT employee_id), MIN(effective_date), MAX(effective_date)
    FROM rpt.workforce_events
    GROUP BY rule_applied, event_type;

    EXEC @second = rpt.usp_rebuild_events @employee_ids = NULL;
ROLLBACK;   -- table variables keep their rows after a rollback

SELECT rule_applied, event_type, events, employees, first_effective, last_effective FROM @summary
UNION ALL SELECT '(check)', 'changes on first run', @first, NULL, NULL, NULL
UNION ALL SELECT '(check)', 'changes on second run (expect 0)', @second, NULL, NULL, NULL
ORDER BY 1, 3 DESC;
