/*
  09-birthday.sql - birth month + day (NO YEAR) on stage.employee_contact.
  Run in the Azure portal Query editor on sqldb-hrint. Safe to re-run.
  The constraint is created through EXEC so the whole script runs in one go (the Query editor does not support GO).
*/
IF COL_LENGTH('stage.employee_contact','birth_month') IS NULL
    ALTER TABLE stage.employee_contact ADD birth_month tinyint NULL;
IF COL_LENGTH('stage.employee_contact','birth_day') IS NULL
    ALTER TABLE stage.employee_contact ADD birth_day tinyint NULL;

IF OBJECT_ID('stage.ck_contact_birthday') IS NULL
    EXEC('ALTER TABLE stage.employee_contact ADD CONSTRAINT ck_contact_birthday CHECK (
        (birth_month IS NULL AND birth_day IS NULL)
        OR (birth_month BETWEEN 1 AND 12 AND birth_day BETWEEN 1 AND
            CASE WHEN birth_month = 2 THEN 29 WHEN birth_month IN (4,6,9,11) THEN 30 ELSE 31 END))');

/* check */
SELECT COL_LENGTH('stage.employee_contact','birth_month') AS birth_month_col,
       COL_LENGTH('stage.employee_contact','birth_day')   AS birth_day_col,
       OBJECT_ID('stage.ck_contact_birthday')             AS constraint_id;
