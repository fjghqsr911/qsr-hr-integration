-- 18-ref-stores.sql: store names, cities and districts for the directory and for Entra department / officeLocation.
-- The hub only knows store codes (org_level2, e.g. T00913 / W06302). Fill the VALUES block below from the store list
-- (one row per store code, codes upper case) and run; MERGE makes it safe to re-run. Head office departments
-- (HR, FIN, OPS ...) are NOT stores and must not be listed here: the directory view shows them as Head Office.
-- Rows written later by the Clearview discover run carry source = clearview and are kept on re-runs of this script
-- unless the CSV row changes the name.
-- Run in the Azure portal Query editor on sqldb-hrint (open from the database, not master) as the Entra admin.
-- Comments contain no apostrophes and no dashes other than the comment marker.

IF OBJECT_ID('ref.stores', 'U') IS NULL
BEGIN
    CREATE TABLE ref.stores (
        store_code   varchar(20)   NOT NULL CONSTRAINT pk_stores PRIMARY KEY,
        name         nvarchar(100) NOT NULL,
        brand        varchar(20)   NULL,
        district     varchar(20)   NULL,
        city         nvarchar(60)  NULL,
        province     varchar(2)    NULL,
        active       bit           NOT NULL CONSTRAINT df_stores_active DEFAULT 1,
        source       varchar(20)   NOT NULL CONSTRAINT df_stores_source DEFAULT 'csv',
        updated_utc  datetime2(0)  NOT NULL CONSTRAINT df_stores_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT ck_stores_source CHECK (source IN ('csv', 'clearview'))
    );
END;

-- ---- seed from the CSV: store_code, name, brand, district, city, province, active ----
-- Replace the two example rows with the real list (keep the column order).
DECLARE @csv TABLE (store_code varchar(20), name nvarchar(100), brand varchar(20), district varchar(20), city nvarchar(60), province varchar(2), active bit);
INSERT INTO @csv (store_code, name, brand, district, city, province, active) VALUES
    ('T00037', N'Example Store Name', 'TH', 'T1', N'Example City', 'ON', 1),
    ('T22446', N'Example Store Name 2', 'TH', 'T2', N'Example City', 'ON', 1);

MERGE ref.stores AS t
USING (SELECT UPPER(LTRIM(RTRIM(store_code))) AS store_code, name, brand, district, city, province, active FROM @csv) AS s
   ON t.store_code = s.store_code
WHEN MATCHED AND (t.name <> s.name OR ISNULL(t.brand, '') <> ISNULL(s.brand, '') OR ISNULL(t.district, '') <> ISNULL(s.district, '')
                  OR ISNULL(t.city, N'') <> ISNULL(s.city, N'') OR ISNULL(t.province, '') <> ISNULL(s.province, '') OR t.active <> s.active)
    THEN UPDATE SET name = s.name, brand = s.brand, district = s.district, city = s.city, province = s.province, active = s.active,
                    source = 'csv', updated_utc = SYSUTCDATETIME()
WHEN NOT MATCHED BY TARGET
    THEN INSERT (store_code, name, brand, district, city, province, active, source)
         VALUES (s.store_code, s.name, s.brand, s.district, s.city, s.province, s.active, 'csv');

-- grants: the Function App reads it (directory view, Entra compare) and the Clearview discover run may update names
DECLARE @app sysname = N'mi-func-hrint';
DECLARE @sql nvarchar(max);
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @app)
BEGIN
    SET @sql = N'GRANT SELECT, INSERT, UPDATE ON OBJECT::ref.stores TO ' + QUOTENAME(@app) + N';';
    EXEC sp_executesql @sql;
END;

-- Verification: every store code seen in the hub that has no ref.stores row (expected: head office departments only)
SELECT ec.org_level2 AS store_code_without_row, COUNT(*) AS employees
FROM stage.employment_current ec
LEFT JOIN ref.stores s ON s.store_code = ec.org_level2
WHERE ec.org_level2 IS NOT NULL AND s.store_code IS NULL AND ec.employee_status IN ('A', 'L')
GROUP BY ec.org_level2 ORDER BY employees DESC;

SELECT COUNT(*) AS stores_total, SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS stores_active FROM ref.stores;
