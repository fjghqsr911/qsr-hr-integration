-- 21-ref-companies.sql: names for the UKG company ids (SWN6T, SWNGK, SWN1U ...), so the monitor can show PFSL, STIS, QFI
-- instead of the UKG code everywhere a company appears. Fill the VALUES block (short_name is what the screens show,
-- name is the legal or long name) and run; MERGE makes it safe to rerun. Ids not listed still show as their UKG code.
-- Run in the Azure portal Query editor on sqldb-hrint (open from the database, not master) as the Entra admin.
-- Comments contain no apostrophes and no dashes other than the comment marker.

IF OBJECT_ID('ref.companies', 'U') IS NULL
BEGIN
    CREATE TABLE ref.companies (
        company_id   varchar(10)   NOT NULL CONSTRAINT pk_companies PRIMARY KEY,
        short_name   nvarchar(20)  NOT NULL,
        name         nvarchar(100) NULL,
        brand        varchar(20)   NULL,
        updated_utc  datetime2(0)  NOT NULL CONSTRAINT df_companies_updated DEFAULT SYSUTCDATETIME()
    );
END;

-- company_id (as in UKG), short_name (shown on screen), name, brand
DECLARE @csv TABLE (company_id varchar(10), short_name nvarchar(20), name nvarchar(100), brand varchar(20));
INSERT INTO @csv (company_id, short_name, name, brand) VALUES
    ('SWN6T', N'PFSL', N'PFSL', 'TH'),
    ('SWNGK', N'STIS', N'STIS', 'TH'),
    ('SWN1U', N'QFI',  N'QFI',  'WEN'),
    ('M9V69', N'M9V69', NULL, NULL),
    ('M9WOJ', N'M9WOJ', NULL, NULL);

MERGE ref.companies AS t
USING (SELECT UPPER(LTRIM(RTRIM(company_id))) AS company_id, short_name, name, brand FROM @csv) AS s
   ON t.company_id = s.company_id
WHEN MATCHED AND (t.short_name <> s.short_name OR ISNULL(t.name, N'') <> ISNULL(s.name, N'') OR ISNULL(t.brand, '') <> ISNULL(s.brand, ''))
    THEN UPDATE SET short_name = s.short_name, name = s.name, brand = s.brand, updated_utc = SYSUTCDATETIME()
WHEN NOT MATCHED BY TARGET
    THEN INSERT (company_id, short_name, name, brand) VALUES (s.company_id, s.short_name, s.name, s.brand);

DECLARE @app sysname = N'mi-func-hrint';
DECLARE @sql nvarchar(max);
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @app)
BEGIN
    SET @sql = N'GRANT SELECT ON OBJECT::ref.companies TO ' + QUOTENAME(@app) + N';';
    EXEC sp_executesql @sql;
END;

-- Verification: every company id in the hub with its name (NULL short_name = not listed above yet)
SELECT x.company_id, c.short_name, c.name, x.employees
FROM (SELECT company_id, COUNT(*) AS employees FROM stage.employment_current WHERE employee_status IN ('A', 'L') GROUP BY company_id) x
LEFT JOIN ref.companies c ON c.company_id = x.company_id ORDER BY x.employees DESC;
