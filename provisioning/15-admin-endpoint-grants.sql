-- Grants for the admin endpoints (hubAdmin.ts): store mode writes ref.store_modes, delivery retry and resolve
-- update out.deliveries. The Function App user already reaches stage and rpt through the sync and the events
-- procedure; these two tables are written directly, so they need explicit permissions.
-- Run in the Azure portal Query editor on sqldb-hrint (open from the database, not master) as the Entra admin.
-- Safe to re-run. If the user name differs, pick it from the first result set and change @app.

SELECT name AS external_users FROM sys.database_principals WHERE type = 'E' ORDER BY name;

DECLARE @app sysname = N'func-hrint-prod-cc';
DECLARE @sql nvarchar(max);

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @app)
    THROW 50000, 'Function App database user not found: set @app to the name listed above', 1;

SET @sql = N'GRANT SELECT, INSERT, UPDATE ON OBJECT::ref.store_modes TO ' + QUOTENAME(@app) + N';'
         + N'GRANT SELECT, UPDATE ON OBJECT::[out].deliveries TO ' + QUOTENAME(@app) + N';';
EXEC sp_executesql @sql;

-- Verification: expect SELECT, INSERT, UPDATE on ref.store_modes and SELECT, UPDATE on out.deliveries
SELECT p.state_desc, p.permission_name, OBJECT_SCHEMA_NAME(p.major_id) + '.' + OBJECT_NAME(p.major_id) AS object_name
FROM sys.database_permissions p
JOIN sys.database_principals dp ON dp.principal_id = p.grantee_principal_id
WHERE dp.name = @app AND p.major_id IN (OBJECT_ID('ref.store_modes'), OBJECT_ID('[out].deliveries'))
ORDER BY object_name, p.permission_name;
