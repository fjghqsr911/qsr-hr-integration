-- 28-entered-time-utc.sql: store the real UTC time a change was entered in UKG.
-- Why: UKG gives dateTimeCreated on job history in Eastern local time with no zone. The hub stored it as it came and
-- called it entered_utc, so the monitor showed every "Entered in UKG" time 5 hours early (4 in summer). Proof
-- (2026-11-25): a row stamped 13:58 made the change-feed release of 19:01 UTC and one stamped 14:04 did not, and the
-- stored times of day run 07:30 to 17:00 in summer and in winter alike.
-- How:
--   rpt.usp_rebuild_events  (the updated 11-usp-rebuild-events.sql, step 3) now converts the time when it builds a
--                           job-history event. stage.job_history.date_time_created stays as UKG gave it.
--   this script             sets entered_utc on the events that already exist, from their source row and with the
--                           same expression. It recomputes from the source and does not shift, so running it twice
--                           changes nothing the second time. built_utc is left alone. Leave and name / email events
--                           are not touched: their entered_utc is the time a sync first saw the change, already UTC.
-- No delivery is queued by this: deliveries are queued only by the procedure, and only for a changed date, company,
-- store, job or termination category. entered_utc is not one of those.
--
-- Run in the Azure portal Query editor on sqldb-hrint (open from the database, not master) as the Entra admin:
-- first the updated 11-usp-rebuild-events.sql, then this script, one right after the other. Safe to re-run.
-- A sync that runs between the two only corrects the employees it touches a little earlier.
-- Comments contain no apostrophes.

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @deliveries_before int = (SELECT COUNT(*) FROM [out].deliveries);
DECLARE @corrected int;

BEGIN TRAN;

WITH src AS (
    SELECT e.entered_utc,
           CAST(j.date_time_created AT TIME ZONE 'Eastern Standard Time' AT TIME ZONE 'UTC' AS datetime2(0)) AS real_utc
    FROM rpt.workforce_events e
    JOIN stage.job_history j ON j.system_id = e.source_system_ids AND j.employee_id = e.employee_id
    WHERE e.rule_applied NOT IN ('leave_start', 'leave_return', 'profile_change')
      AND j.date_time_created IS NOT NULL)
UPDATE src SET entered_utc = real_utc
WHERE entered_utc IS NULL OR entered_utc <> real_utc;

SET @corrected = @@ROWCOUNT;

COMMIT;

/* Verification. First run: events_corrected is every job-history event (about 26,600) and still_different is 0.
   A second run: events_corrected is 0. deliveries_added must be 0. events_without_source_row should be 0
   (such an event keeps the time it had). event_56770_entered_utc must be 2026-11-24 14:22:17 (9:22am Toronto). */
SELECT @corrected AS events_corrected,
       (SELECT COUNT(*) FROM rpt.workforce_events e
        JOIN stage.job_history j ON j.system_id = e.source_system_ids AND j.employee_id = e.employee_id
        WHERE e.rule_applied NOT IN ('leave_start', 'leave_return', 'profile_change') AND j.date_time_created IS NOT NULL
          AND e.entered_utc <> CAST(j.date_time_created AT TIME ZONE 'Eastern Standard Time' AT TIME ZONE 'UTC' AS datetime2(0))) AS still_different,
       (SELECT COUNT(*) FROM rpt.workforce_events e
        WHERE e.rule_applied NOT IN ('leave_start', 'leave_return', 'profile_change')
          AND NOT EXISTS (SELECT 1 FROM stage.job_history j
                          WHERE j.system_id = e.source_system_ids AND j.employee_id = e.employee_id)) AS events_without_source_row,
       (SELECT COUNT(*) FROM [out].deliveries) - @deliveries_before AS deliveries_added,
       (SELECT CONVERT(varchar(19), entered_utc, 120) FROM rpt.workforce_events WHERE event_id = 56770) AS event_56770_entered_utc;
