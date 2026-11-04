-- 22-queue-events.sql: rpt.usp_queue_events, the manual queue behind POST /api/hub/events/queue.
-- usp_rebuild_events queues deliveries only for events that are new or materially changed at build time; events built
-- while a store was off are never queued when the store is switched on later, and that is deliberate: the outgoing
-- integration carries current changes until cutover, so nothing is backfilled automatically. When a person decides a
-- particular change must go through the hub anyway, hrint-api calls this with the chosen event ids.
-- For each id: the event must exist, the destination must take its type (ref.destination_events), its new store (or old
-- store for a termination, either store of a move) must be shadow or live, and no delivery may exist yet for the
-- destination and event key. Then one pending row is inserted, store chosen as the rebuild does (new store first).
-- Returns one row per id: event_id, outcome (queued, exists, store_off, not_taken, not_found), delivery_id.
-- Run in the Azure portal Query editor on sqldb-hrint (open from the database, not master) as the Entra admin.
-- Safe to re-run (CREATE OR ALTER). Comments contain no apostrophes and no dashes other than the comment marker.

CREATE OR ALTER PROCEDURE rpt.usp_queue_events @destination varchar(20), @event_ids nvarchar(max)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @ids TABLE (event_id bigint NOT NULL PRIMARY KEY);
    INSERT INTO @ids (event_id)
    SELECT DISTINCT TRY_CAST(value AS bigint) FROM OPENJSON(@event_ids) WHERE TRY_CAST(value AS bigint) IS NOT NULL;

    DECLARE @out TABLE (event_id bigint NOT NULL PRIMARY KEY, outcome varchar(20) NOT NULL, delivery_id bigint NULL, event_key binary(32) NULL);

    INSERT INTO @out (event_id, outcome, event_key)
    SELECT i.event_id,
           CASE WHEN e.event_id IS NULL THEN 'not_found'
                WHEN de.event_type IS NULL THEN 'not_taken'
                WHEN EXISTS (SELECT 1 FROM [out].deliveries d WHERE d.destination = @destination AND d.event_key = e.event_key) THEN 'exists'
                WHEN m.store IS NULL THEN 'store_off'
                ELSE 'queue' END,
           e.event_key
    FROM @ids i
    LEFT JOIN rpt.workforce_events e ON e.event_id = i.event_id
    LEFT JOIN ref.destination_events de ON de.destination = @destination AND de.event_type = e.event_type
    OUTER APPLY (SELECT TOP 1 sm.store FROM ref.store_modes sm
                 WHERE sm.destination = @destination AND sm.mode IN ('shadow', 'live') AND sm.store IN (e.to_store, e.from_store)
                 ORDER BY CASE WHEN sm.store = e.to_store THEN 0 ELSE 1 END) m;

    BEGIN TRAN;
    DECLARE @ins TABLE (delivery_id bigint NOT NULL, event_key binary(32) NOT NULL);
    INSERT INTO [out].deliveries (destination, event_key, version, kind, employee_id, event_type, action, effective_date, store, status)
    OUTPUT inserted.delivery_id, inserted.event_key INTO @ins (delivery_id, event_key)
    SELECT @destination, e.event_key, 1, 'event', e.employee_id, e.event_type, de.action, e.effective_date, m.store, 'pending'
    FROM @out o
    JOIN rpt.workforce_events e ON e.event_id = o.event_id
    JOIN ref.destination_events de ON de.destination = @destination AND de.event_type = e.event_type
    CROSS APPLY (SELECT TOP 1 sm.store FROM ref.store_modes sm
                 WHERE sm.destination = @destination AND sm.mode IN ('shadow', 'live') AND sm.store IN (e.to_store, e.from_store)
                 ORDER BY CASE WHEN sm.store = e.to_store THEN 0 ELSE 1 END) m
    WHERE o.outcome = 'queue';

    UPDATE o SET outcome = 'queued', delivery_id = x.delivery_id
    FROM @out o JOIN @ins x ON x.event_key = o.event_key
    WHERE o.outcome = 'queue';
    COMMIT;

    SELECT event_id, outcome, delivery_id FROM @out ORDER BY event_id;
END;
GO

DECLARE @app sysname = N'mi-func-hrint';
DECLARE @sql nvarchar(max);
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @app)
BEGIN
    SET @sql = N'GRANT EXECUTE ON OBJECT::rpt.usp_queue_events TO ' + QUOTENAME(@app) + N';';
    EXEC sp_executesql @sql;
END;

-- Verification: the procedure exists and the Function App user may execute it
SELECT OBJECT_ID('rpt.usp_queue_events', 'P') AS procedure_object_id,
       (SELECT COUNT(*) FROM sys.database_permissions p JOIN sys.database_principals dp ON dp.principal_id = p.grantee_principal_id
        WHERE dp.name = @app AND p.major_id = OBJECT_ID('rpt.usp_queue_events') AND p.permission_name = 'EXECUTE') AS execute_grants;
