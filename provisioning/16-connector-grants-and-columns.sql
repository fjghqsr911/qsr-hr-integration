-- 16-connector-grants-and-columns.sql: what the Clearview connector (clearviewConnector.ts, deliveryStore.ts) needs.
--   1. Grants to the Function App user mi-func-hrint on the delivery tables it reads and writes.
--   2. out.deliveries: response_ref column and the waiting / skipped statuses.
--   3. ref.destination_codes: destination_id column and the category / company code types.
-- Run in the Azure portal Query editor on sqldb-hrint (open from the database, not master) as the Entra admin.
-- Safe to rerun. Comments contain no apostrophes and no dashes other than the comment marker.

SELECT name AS external_users FROM sys.database_principals WHERE type = 'E' ORDER BY name;

DECLARE @app sysname = N'mi-func-hrint';
DECLARE @sql nvarchar(max);

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @app)
    THROW 50000, 'Function App database user not found: set @app to the name listed above', 1;

-- 1. grants
SET @sql = N'GRANT SELECT, INSERT, UPDATE ON OBJECT::[out].last_sent TO ' + QUOTENAME(@app) + N';'
         + N'GRANT SELECT, INSERT, DELETE ON OBJECT::[out].shadow_payloads TO ' + QUOTENAME(@app) + N';'
         + N'GRANT SELECT, INSERT, UPDATE ON OBJECT::xref.employees TO ' + QUOTENAME(@app) + N';'
         + N'GRANT SELECT, INSERT, UPDATE ON OBJECT::ref.destination_codes TO ' + QUOTENAME(@app) + N';'
         + N'GRANT SELECT, UPDATE ON OBJECT::[out].deliveries TO ' + QUOTENAME(@app) + N';'
         + N'GRANT SELECT ON OBJECT::rpt.workforce_events TO ' + QUOTENAME(@app) + N';'
         + N'GRANT SELECT ON OBJECT::stage.employment_current TO ' + QUOTENAME(@app) + N';'
         + N'GRANT SELECT ON OBJECT::ref.destination_events TO ' + QUOTENAME(@app) + N';'
         + N'GRANT SELECT ON OBJECT::ref.store_modes TO ' + QUOTENAME(@app) + N';'
         + N'GRANT SELECT, INSERT, UPDATE ON OBJECT::stage.sync_runs TO ' + QUOTENAME(@app) + N';';
EXEC sp_executesql @sql;

-- 2. out.deliveries: response_ref (Clearview reference of what was sent, e.g. import:<employeeNumber>) and two statuses:
--    waiting = the employee is not in Clearview yet (import not approved by Payroll), retried hourly;
--    skipped = out of scope at send time (store switched off, company or job not sent to Clearview).
IF COL_LENGTH('out.deliveries', 'response_ref') IS NULL
    ALTER TABLE [out].deliveries ADD response_ref nvarchar(64) NULL;

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'ck_deliveries_status' AND parent_object_id = OBJECT_ID('out.deliveries'))
    ALTER TABLE [out].deliveries DROP CONSTRAINT ck_deliveries_status;
ALTER TABLE [out].deliveries WITH CHECK ADD CONSTRAINT ck_deliveries_status CHECK (status IN
    ('pending', 'sent', 'unchanged', 'shadow', 'failed', 'dead', 'superseded', 'review', 'resolved', 'waiting', 'skipped'));

-- 3. ref.destination_codes: destination_id (Clearview storeId / organization jobId next to the code), a company column
--    (Clearview job codes, job ids and termination reason ids differ per organization: a row with the UKG company applies
--    to that organization only, a row with company empty is shared, as stores and company rows are), and two code types:
--    category = UKG full_or_part_time F / P to the Clearview employee category code;
--    company  = UKG company to the Clearview organizationId.
IF COL_LENGTH('ref.destination_codes', 'destination_id') IS NULL
    ALTER TABLE ref.destination_codes ADD destination_id nvarchar(50) NULL;

IF COL_LENGTH('ref.destination_codes', 'company') IS NULL
    ALTER TABLE ref.destination_codes ADD company varchar(10) NOT NULL CONSTRAINT df_destination_codes_company DEFAULT '';

IF NOT EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
               JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
               WHERE i.name = 'pk_destination_codes' AND c.name = 'company')
BEGIN
    ALTER TABLE ref.destination_codes DROP CONSTRAINT pk_destination_codes;
    ALTER TABLE ref.destination_codes ADD CONSTRAINT pk_destination_codes PRIMARY KEY (destination, code_type, company, ukg_code);
END;

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'ck_destination_codes_type' AND parent_object_id = OBJECT_ID('ref.destination_codes'))
    ALTER TABLE ref.destination_codes DROP CONSTRAINT ck_destination_codes_type;
ALTER TABLE ref.destination_codes WITH CHECK ADD CONSTRAINT ck_destination_codes_type
    CHECK (code_type IN ('job', 'store', 'termination', 'category', 'company'));

-- Verification: grants on the connector tables, then the two new columns
SELECT p.state_desc, p.permission_name, OBJECT_SCHEMA_NAME(p.major_id) + '.' + OBJECT_NAME(p.major_id) AS object_name
FROM sys.database_permissions p
JOIN sys.database_principals dp ON dp.principal_id = p.grantee_principal_id
WHERE dp.name = @app
  AND p.major_id IN (OBJECT_ID('[out].deliveries'), OBJECT_ID('[out].last_sent'), OBJECT_ID('[out].shadow_payloads'),
                     OBJECT_ID('xref.employees'), OBJECT_ID('ref.destination_codes'), OBJECT_ID('rpt.workforce_events'),
                     OBJECT_ID('stage.employment_current'), OBJECT_ID('ref.destination_events'), OBJECT_ID('ref.store_modes'),
                     OBJECT_ID('stage.sync_runs'))
ORDER BY object_name, p.permission_name;

SELECT COL_LENGTH('out.deliveries', 'response_ref') AS response_ref_bytes,
       COL_LENGTH('ref.destination_codes', 'destination_id') AS destination_id_bytes,
       COL_LENGTH('ref.destination_codes', 'company') AS company_bytes,
       (SELECT COUNT(*) FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        WHERE i.name = 'pk_destination_codes') AS pk_columns,
       (SELECT definition FROM sys.check_constraints WHERE name = 'ck_deliveries_status') AS deliveries_status_check,
       (SELECT definition FROM sys.check_constraints WHERE name = 'ck_destination_codes_type') AS destination_codes_type_check;
