-- 19-directory-view.sql: rpt.v_directory, one row per employee for the monitor directory and the Entra compare.
-- Requires 18-ref-stores.sql. The view takes exactly one column from stage.employee_contact: work_email.
-- The monitor database user is denied SELECT on stage.employee_contact; because the view and the table are both
-- dbo-owned, the ownership chain lets the view be read while the table itself stays denied (personal email,
-- phones and birthdays never reach the monitor). A store is any org_level2 shaped like a store code (a letter and
-- four or more digits: T00037, W06302), whether or not ref.stores has a row for it yet; department is the store
-- name (NULL until the row exists: nothing is proposed to Entra then), or Head Office for everyone else (HR, FIN, OPS ...).
-- Run in the Azure portal Query editor on sqldb-hrint (open from the database, not master) as the Entra admin.
-- Safe to re-run. Comments contain no apostrophes and no dashes other than the comment marker.

CREATE OR ALTER VIEW rpt.v_directory AS
WITH home AS (
    SELECT ec.*,
           ROW_NUMBER() OVER (PARTITION BY ec.employee_id ORDER BY ec.is_home_company DESC, ec.updated_utc DESC) AS rn,
           COUNT(*) OVER (PARTITION BY ec.employee_id) AS company_count
    FROM stage.employment_current ec
)
SELECT h.employee_id, h.employee_number, h.company_id, h.company_count, h.employee_status,
       CASE WHEN UPPER(LTRIM(RTRIM(h.first_name))) = UPPER(LTRIM(RTRIM(h.last_name)))
            THEN COALESCE(NULLIF(LTRIM(RTRIM(h.preferred_name)), ''), h.first_name)
            ELSE CONCAT(COALESCE(NULLIF(LTRIM(RTRIM(h.preferred_name)), ''), h.first_name), ' ', h.last_name)
       END AS display_name,
       h.first_name, h.preferred_name, h.last_name,
       h.org_level1 AS district, h.org_level2 AS store,
       s.name AS store_name, s.city AS store_city, s.brand,
       CASE WHEN h.org_level2 LIKE '[A-Z][0-9][0-9][0-9][0-9]%' THEN s.name ELSE N'Head Office' END AS department,
       CASE WHEN h.org_level2 LIKE '[A-Z][0-9][0-9][0-9][0-9]%' THEN 1 ELSE 0 END AS is_store,
       h.job_code, jc.job_description AS job_title, h.full_or_part_time, h.date_in_job,
       h.status_start_date, h.original_hire_date, h.last_hire_date, h.termination_date, h.date_last_worked, h.termination_category,
       c.work_email,
       h.updated_utc
FROM home h
LEFT JOIN ref.job_codes jc ON jc.job_code = h.job_code
LEFT JOIN ref.stores s ON s.store_code = h.org_level2
LEFT JOIN stage.employee_contact c ON c.employee_id = h.employee_id
WHERE h.rn = 1;
GO

DECLARE @app sysname = N'mi-func-hrint';
DECLARE @sql nvarchar(max);
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @app)
BEGIN
    SET @sql = N'GRANT SELECT ON OBJECT::rpt.v_directory TO ' + QUOTENAME(@app) + N';';
    EXEC sp_executesql @sql;
END;

-- Verification: counts by status and how many active people have a work email
SELECT employee_status, COUNT(*) AS employees,
       SUM(CASE WHEN work_email IS NOT NULL THEN 1 ELSE 0 END) AS with_work_email,
       SUM(CASE WHEN is_store = 1 THEN 1 ELSE 0 END) AS at_a_store
FROM rpt.v_directory GROUP BY employee_status ORDER BY employee_status;
