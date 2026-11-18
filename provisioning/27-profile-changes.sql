-- 27-profile-changes.sql: name and email changes of existing employees, so they reach Rosnet and Clearview.
-- Why: the hub builds events from UKG job history and leave periods. A changed name or email is in neither, so no
-- destination ever heard about it (Flexspring reacts to every employee change in UKG).
-- How:
--   stage.profile_changes      one row per employee, kind (name or email) and UTC day a sync first saw the new value.
--                              No names and no addresses are stored here: dates only.
--   stage.usp_capture_profile  called by hrint-api with the rows it is about to write, BEFORE stage.employment_current
--                              and stage.employee_contact are overwritten (it compares with the stored rows):
--                                name   first, last or preferred name differs from the stored one. Only when the sync
--                                       carries names and the stored first and last name are known.
--                                email  an address arrives that is not one of the two stored for the employee. An
--                                       address that merely disappears is ignored: the two syncs read different UKG
--                                       feeds and one of them may not carry the second address.
--   rpt.usp_rebuild_events     (the updated 11-usp-rebuild-events.sql, step 3c) turns each row into a Name change or
--                              Email change event per company record that is not terminated that day, unless a hire or
--                              rehire of the employee was entered in the two days before: the hire carries both.
--   ref.destination_events     both events go to clearview and to rosnet as action update. As for every event, a
--                              delivery is queued only for a store that is shadow or live.
-- Date of birth and SIN corrections are NOT captured: they are rare and should be handled by Payroll by hand.
--
-- Run in the Azure portal Query editor on sqldb-hrint (open from the database, not master) as the Entra admin, after 26.
-- Then run the updated 11-usp-rebuild-events.sql. Safe to re-run. Until this script has run, the syncs skip the capture
-- (hrint-api checks that the procedure exists), so the order of deploying code and running this script does not matter.
-- Comments contain no apostrophes.

IF OBJECT_ID('stage.profile_changes', 'U') IS NULL
    CREATE TABLE stage.profile_changes (
        employee_id  varchar(20)  NOT NULL,
        change_type  varchar(10)  NOT NULL CONSTRAINT ck_profile_changes_type CHECK (change_type IN ('name', 'email')),
        change_date  date         NOT NULL,     -- UTC day a sync first saw the new value
        seen_utc     datetime2(0) NOT NULL CONSTRAINT df_profile_changes_seen DEFAULT SYSUTCDATETIME(),
        built_utc    datetime2(0) NULL,         -- when rpt.usp_rebuild_events looked at the row (NULL = not yet)
        CONSTRAINT pk_profile_changes PRIMARY KEY (employee_id, change_type, change_date));
GO

/* @emp      JSON array of employment rows about to be written (employee_id, first_name, preferred_name, last_name), or NULL
   @contacts JSON array of contact rows about to be written (employee_id, personal_email, work_email), or NULL */
CREATE OR ALTER PROCEDURE stage.usp_capture_profile @emp nvarchar(max) = NULL, @contacts nvarchar(max) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @today date = CAST(SYSUTCDATETIME() AS date);

    IF @emp IS NOT NULL
        INSERT INTO stage.profile_changes (employee_id, change_type, change_date)
        SELECT DISTINCT n.employee_id, 'name', @today
        FROM OPENJSON(@emp) WITH (employee_id varchar(20), first_name nvarchar(100), preferred_name nvarchar(100), last_name nvarchar(100)) n
        WHERE n.first_name IS NOT NULL AND n.last_name IS NOT NULL
          AND EXISTS (SELECT 1 FROM stage.employment_current c
                      WHERE c.employee_id = n.employee_id AND c.first_name IS NOT NULL AND c.last_name IS NOT NULL
                        AND (LTRIM(RTRIM(c.first_name)) <> LTRIM(RTRIM(n.first_name))
                          OR LTRIM(RTRIM(c.last_name))  <> LTRIM(RTRIM(n.last_name))
                          OR ISNULL(LTRIM(RTRIM(c.preferred_name)), '') <> ISNULL(LTRIM(RTRIM(n.preferred_name)), '')))
          AND NOT EXISTS (SELECT 1 FROM stage.profile_changes p
                          WHERE p.employee_id = n.employee_id AND p.change_type = 'name' AND p.change_date = @today);

    IF @contacts IS NOT NULL
        INSERT INTO stage.profile_changes (employee_id, change_type, change_date)
        SELECT DISTINCT n.employee_id, 'email', @today
        FROM OPENJSON(@contacts) WITH (employee_id varchar(20), personal_email nvarchar(254), work_email nvarchar(254)) n
        LEFT JOIN stage.employee_contact c ON c.employee_id = n.employee_id
        WHERE (   (NULLIF(n.personal_email, '') IS NOT NULL AND n.personal_email NOT IN (ISNULL(c.personal_email, ''), ISNULL(c.work_email, '')))
               OR (NULLIF(n.work_email, '')     IS NOT NULL AND n.work_email     NOT IN (ISNULL(c.personal_email, ''), ISNULL(c.work_email, ''))))
          AND EXISTS (SELECT 1 FROM stage.employment_current e WHERE e.employee_id = n.employee_id)
          AND NOT EXISTS (SELECT 1 FROM stage.profile_changes p
                          WHERE p.employee_id = n.employee_id AND p.change_type = 'email' AND p.change_date = @today);
END
GO

/* Both destinations take both events as an update */
INSERT INTO ref.destination_events (destination, event_type, action)
SELECT s.destination, s.event_type, s.action
FROM (VALUES ('clearview', 'Name change', 'update'), ('clearview', 'Email change', 'update'),
             ('rosnet',    'Name change', 'update'), ('rosnet',    'Email change', 'update')) s (destination, event_type, action)
WHERE NOT EXISTS (SELECT 1 FROM ref.destination_events d WHERE d.destination = s.destination AND d.event_type = s.event_type);

/* The syncs call the procedure and read the table as the Function App user */
DECLARE @app sysname = N'mi-func-hrint';
DECLARE @sql nvarchar(max);
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @app)
BEGIN
    SET @sql = N'GRANT EXECUTE ON OBJECT::stage.usp_capture_profile TO ' + QUOTENAME(@app) + N';'
             + N'GRANT SELECT ON OBJECT::stage.profile_changes TO ' + QUOTENAME(@app) + N';';
    EXEC sp_executesql @sql;
END;

/* Verification: capture_execute_grants and table_select_grants must be 1; destination_events must be 4 */
SELECT (SELECT COUNT(*) FROM sys.database_permissions p JOIN sys.database_principals dp ON dp.principal_id = p.grantee_principal_id
        WHERE dp.name = @app AND p.major_id = OBJECT_ID('stage.usp_capture_profile') AND p.permission_name = 'EXECUTE') AS capture_execute_grants,
       (SELECT COUNT(*) FROM sys.database_permissions p JOIN sys.database_principals dp ON dp.principal_id = p.grantee_principal_id
        WHERE dp.name = @app AND p.major_id = OBJECT_ID('stage.profile_changes') AND p.permission_name = 'SELECT')       AS table_select_grants,
       (SELECT COUNT(*) FROM ref.destination_events WHERE event_type IN ('Name change', 'Email change'))                 AS destination_events,
       (SELECT COUNT(*) FROM stage.profile_changes)                                                                      AS profile_changes;
