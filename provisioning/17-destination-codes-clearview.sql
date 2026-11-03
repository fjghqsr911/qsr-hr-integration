-- 17-destination-codes-clearview.sql: Clearview code pairs that a person decides (jobs, termination reasons, categories,
-- companies). Stores are paired automatically by POST /api/hub/clearview/discover on tdlNumber and are not listed here;
-- run discover first, then copy the job and termination reason lists from its report into the VALUES block below.
-- Each row: code_type, UKG code, Clearview code, Clearview id, note.
--   job:          UKG job code (TM, SH, AM, GM ...) to Clearview jobCode (destination_code) and organization jobId (destination_id)
--   termination:  UKG termination category (Voluntary, Involuntary, Unknown, No show, Administrative) to Clearview terminationReasonId
--                 (destination_code = destination_id = the id). Without a row the connector uses CLEARVIEW_TERMINATION_REASON_ID.
--   category:     UKG full_or_part_time F or P to the Clearview employeeCategoryCode (reserved; not sent until UAT confirms it)
--   company:      UKG company (SWN6T, SWNGK) to the Clearview organizationId (destination_code) and employerCode (notes)
-- Run in the Azure portal Query editor on sqldb-hrint after 16. Safe to rerun: a MERGE on (destination, code_type, ukg_code).
-- Delete the sample rows and fill in the real pairs. Comments contain no apostrophes.

DECLARE @codes TABLE (code_type varchar(20), ukg_code varchar(20), destination_code nvarchar(50), destination_id nvarchar(50), notes nvarchar(200));

INSERT INTO @codes (code_type, ukg_code, destination_code, destination_id, notes) VALUES
    -- FILL FROM THE DISCOVER REPORT (sample rows; replace every one)
    ('company',     'SWN6T',        '18',    NULL,   'employerCode O01189'),
    ('company',     'SWNGK',        '1690',  NULL,   'employerCode STIS'),
    ('job',         'TM',           '1',     NULL,   'org 18 Counter Staff CS'),
    ('job',         'SH',           '10',    NULL,   'org 18 Supervisor SV'),
    ('job',         'AM',           '4',     NULL,   'org 18 Managers MGR'),
    ('job',         'GM',           '4',     NULL,   'org 18 Managers MGR'),
    ('termination', 'Voluntary',    '13078', '13078', 'default reason used by Flexspring');

-- jobs differ per organization but ref.destination_codes keys on the UKG code alone: when the two organizations use
-- different jobCode or jobId values for the same UKG job, keep the SWN6T pair here and raise it before live for SWNGK.

MERGE ref.destination_codes WITH (HOLDLOCK) AS t
USING (SELECT 'clearview' AS destination, code_type, ukg_code, destination_code, destination_id, notes FROM @codes) AS s
   ON t.destination = s.destination AND t.code_type = s.code_type AND t.ukg_code = s.ukg_code
WHEN MATCHED AND (ISNULL(t.destination_code, '') <> ISNULL(s.destination_code, '')
               OR ISNULL(t.destination_id, '') <> ISNULL(s.destination_id, '')
               OR ISNULL(t.notes, '') <> ISNULL(s.notes, ''))
    THEN UPDATE SET destination_code = s.destination_code, destination_id = s.destination_id, notes = s.notes, updated_utc = SYSUTCDATETIME()
WHEN NOT MATCHED BY TARGET
    THEN INSERT (destination, code_type, ukg_code, destination_code, destination_id, notes)
         VALUES (s.destination, s.code_type, s.ukg_code, s.destination_code, s.destination_id, s.notes);

SELECT code_type, ukg_code, destination_code, destination_id, notes, updated_utc
FROM ref.destination_codes WHERE destination = 'clearview' ORDER BY code_type, ukg_code;
