SET XACT_ABORT ON;
DECLARE @destination varchar(20) = 'clearview';
DECLARE @store       varchar(20) = 'T00037';

DECLARE @ids nvarchar(max) = (
    SELECT '[' + STRING_AGG(CAST('"' + employee_id + '"' AS nvarchar(max)), ',') + ']'
    FROM (SELECT DISTINCT employee_id FROM rpt.workforce_events WHERE @store IN (from_store, to_store)) x);
IF @ids IS NULL THROW 50000, 'No events for that store - pick another store code.', 1;

DECLARE @summary TABLE (event_type varchar(40), action varchar(30), status varchar(20), deliveries int, employees int,
                        first_effective date, last_effective date);
DECLARE @events int, @queued int, @queued_again int, @employees int = (SELECT COUNT(*) FROM OPENJSON(@ids)),
        @before bigint = (SELECT ISNULL(MAX(delivery_id), 0) FROM [out].deliveries);

BEGIN TRAN;
    MERGE ref.store_modes AS t
    USING (SELECT @destination AS destination, @store AS store) AS s ON t.destination = s.destination AND t.store = s.store
    WHEN MATCHED THEN UPDATE SET mode = 'shadow', changed_utc = SYSUTCDATETIME(), changed_by = 'dry run'
    WHEN NOT MATCHED THEN INSERT (destination, store, mode, changed_by) VALUES (s.destination, s.store, 'shadow', 'dry run');

    DELETE FROM rpt.workforce_events WHERE employee_id IN (SELECT value FROM OPENJSON(@ids));
    EXEC @events = rpt.usp_rebuild_events @employee_ids = @ids;
    SET @queued = (SELECT COUNT(*) FROM [out].deliveries WHERE delivery_id > @before);

    INSERT INTO @summary
    SELECT event_type, action, status, COUNT(*), COUNT(DISTINCT employee_id), MIN(effective_date), MAX(effective_date)
    FROM [out].deliveries WHERE delivery_id > @before
    GROUP BY event_type, action, status;

    EXEC rpt.usp_rebuild_events @employee_ids = @ids;
    SET @queued_again = (SELECT COUNT(*) FROM [out].deliveries WHERE delivery_id > @before) - @queued;
ROLLBACK;

SELECT event_type, action, status, deliveries, employees, first_effective, last_effective FROM @summary
UNION ALL SELECT '(check)', 'employees at the store', NULL, @employees, NULL, NULL, NULL
UNION ALL SELECT '(check)', 'events rebuilt', NULL, @events, NULL, NULL, NULL
UNION ALL SELECT '(check)', 'queued on second run (expect 0)', NULL, @queued_again, NULL, NULL, NULL
ORDER BY 1, 4 DESC;
