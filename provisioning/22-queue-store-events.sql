-- 22-queue-store-events.sql: rpt.usp_queue_store_events, called when a store is switched to shadow or live.
-- usp_rebuild_events queues deliveries only for events that are new or materially changed at build time; events built
-- while a store was off are never queued when the store is switched on later (seen Nov 4: a promotion built Oct 30
-- for a store that went shadow Oct 31 got no delivery). This procedure queues a pending delivery for every current
-- event of the store (new store, or the old store of a termination or move) that has no delivery for the destination
-- yet and was entered in UKG on or after @since. Same store choice as the rebuild: the new store first, then the old.
-- Returns the number of rows queued. The last block runs it once for every store already in shadow or live.
-- Run in the Azure portal Query editor on sqldb-hrint (open from the database, not master) as the Entra admin.
-- Safe to re-run: a second run queues nothing (every event already has a delivery). Comments contain no apostrophes.

CREATE OR ALTER PROCEDURE rpt.usp_queue_store_events @destination varchar(20), @store varchar(20), @since datetime2(0)
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO [out].deliveries (destination, event_key, version, kind, employee_id, event_type, action, effective_date, store, status)
    SELECT de.destination, e.event_key, 1, 'event', e.employee_id, e.event_type, de.action, e.effective_date, m.store, 'pending'
    FROM rpt.workforce_events e
    JOIN ref.destination_events de ON de.destination = @destination AND de.event_type = e.event_type
    CROSS APPLY (SELECT TOP 1 sm.store FROM ref.store_modes sm
                 WHERE sm.destination = de.destination AND sm.mode IN ('shadow', 'live') AND sm.store IN (e.to_store, e.from_store)
                 ORDER BY CASE WHEN sm.store = e.to_store THEN 0 ELSE 1 END) m
    WHERE @store IN (e.to_store, e.from_store)
      AND e.entered_utc >= @since
      AND NOT EXISTS (SELECT 1 FROM [out].deliveries d WHERE d.destination = de.destination AND d.event_key = e.event_key);
    RETURN @@ROWCOUNT;
END;
GO

DECLARE @app sysname = N'mi-func-hrint';
DECLARE @sql nvarchar(max);
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @app)
BEGIN
    SET @sql = N'GRANT EXECUTE ON OBJECT::rpt.usp_queue_store_events TO ' + QUOTENAME(@app) + N';';
    EXEC sp_executesql @sql;
END;

-- One-off backfill for the stores already switched on: events entered in UKG in the last @backfill_days days.
-- Set @backfill_days to 0 to skip. Every row created here is pending for a shadow store: a masked payload, nothing sent.
DECLARE @backfill_days int = 14;
DECLARE @since datetime2(0) = DATEADD(day, -@backfill_days, SYSUTCDATETIME());
DECLARE @results TABLE (destination varchar(20), store varchar(20), queued int);
IF @backfill_days > 0
BEGIN
    DECLARE @d varchar(20), @s varchar(20), @n int;
    DECLARE c CURSOR LOCAL FAST_FORWARD FOR SELECT destination, store FROM ref.store_modes WHERE mode IN ('shadow', 'live') ORDER BY destination, store;
    OPEN c;
    FETCH NEXT FROM c INTO @d, @s;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        EXEC @n = rpt.usp_queue_store_events @destination = @d, @store = @s, @since = @since;
        INSERT INTO @results VALUES (@d, @s, @n);
        FETCH NEXT FROM c INTO @d, @s;
    END;
    CLOSE c; DEALLOCATE c;
END;

-- Verification: what the backfill queued per store, then the queue by status
SELECT destination, store, queued FROM @results WHERE queued > 0 ORDER BY destination, store;
SELECT destination, status, COUNT(*) AS n FROM [out].deliveries GROUP BY destination, status ORDER BY destination, status;
