-- 25-destination-codes-rosnet.sql: Rosnet (Employee Data Transfer API -> Aloha) code pairs for company SWN1U.
-- Each row: code_type, company, UKG code, Rosnet code, Rosnet id (unused: NULL), note. company is empty: one Rosnet client.
--   store:        UKG store W0#### to the Rosnet location number = its digits (W06000 -> 6000). The 36 rows are the
--                 sandbox GET /Location answer of 2026-11-16, the 36 W stores in the hub and the 36 rows of the Flexspring
--                 location lookup: an exact three-way match. W06178 is 6178 (the design spec said 6187, a typo).
--                 POST /api/hub/rosnet/discover?what=codes rewrites these rows from production once credentials exist.
--   job:          UKG job code to the Aloha job code. The first eight rows are the live Flexspring lookup
--                 (QSR_rosnetJobs export of 2026-10-30); all six codes exist in Rosnet. GMIT is not in the Flexspring
--                 lookup (its new hire fails there): HR decision 2026-11-18, GMIT goes to 650 General Mg like GM.
--   termination:  UKG termination category to the Rosnet termination code. Rosnet requires a code on every termination
--                 and on every transfer. DECISION 2026-11-18 (HR): code 1 Termination for EVERYTHING, transfers
--                 included. Rosnet is not used for tracking or reporting, so one code is simpler. It is also what
--                 Flexspring sends today (seen on a leave of absence, 2026-11-16).
--                 Without a row the connector uses the Default row, and without that the setting ROSNET_TERM_CODE.
-- Rosnet termination codes (2026-11-16): 1 Termination, 2 No Show, 3 Deactivate, 4 Shift Manager, 20 Voluntary Quit,
-- 21 Quit No Notice, 22 Job Performance, 23 Excessive Tardiness, 24 Excessive Absenteeism, 25 No Show/ No Call, 26 Moving,
-- 27 Other Job, 28 Back to School, 29 Rude or Discourteous Behaviour, 30 Insubordination, 100 Transfer.
-- Run in the Azure portal Query editor on sqldb-hrint after 24. Safe to rerun: a MERGE on (destination, code_type, company, ukg_code).
-- Comments contain no apostrophes.

DECLARE @codes TABLE (code_type varchar(20), company varchar(10), ukg_code varchar(20), destination_code nvarchar(50), destination_id nvarchar(50), notes nvarchar(200));

INSERT INTO @codes (code_type, company, ukg_code, destination_code, destination_id, notes) VALUES
    -- stores: location number = the digits of the UKG store code
    ('store', '', 'W06000', '6000', NULL, 'Rosnet location 6000'), ('store', '', 'W06010', '6010', NULL, 'Rosnet location 6010'),
    ('store', '', 'W06018', '6018', NULL, 'Rosnet location 6018'), ('store', '', 'W06106', '6106', NULL, 'Rosnet location 6106'),
    ('store', '', 'W06117', '6117', NULL, 'Rosnet location 6117'), ('store', '', 'W06118', '6118', NULL, 'Rosnet location 6118'),
    ('store', '', 'W06129', '6129', NULL, 'Rosnet location 6129'), ('store', '', 'W06139', '6139', NULL, 'Rosnet location 6139'),
    ('store', '', 'W06178', '6178', NULL, 'Rosnet location 6178'), ('store', '', 'W06186', '6186', NULL, 'Rosnet location 6186'),
    ('store', '', 'W06302', '6302', NULL, 'Rosnet location 6302'), ('store', '', 'W06316', '6316', NULL, 'Rosnet location 6316'),
    ('store', '', 'W06353', '6353', NULL, 'Rosnet location 6353'), ('store', '', 'W06367', '6367', NULL, 'Rosnet location 6367'),
    ('store', '', 'W06375', '6375', NULL, 'Rosnet location 6375'), ('store', '', 'W06376', '6376', NULL, 'Rosnet location 6376'),
    ('store', '', 'W06377', '6377', NULL, 'Rosnet location 6377'), ('store', '', 'W06378', '6378', NULL, 'Rosnet location 6378'),
    ('store', '', 'W06407', '6407', NULL, 'Rosnet location 6407'), ('store', '', 'W06419', '6419', NULL, 'Rosnet location 6419'),
    ('store', '', 'W06431', '6431', NULL, 'Rosnet location 6431'), ('store', '', 'W06442', '6442', NULL, 'Rosnet location 6442'),
    ('store', '', 'W06448', '6448', NULL, 'Rosnet location 6448'), ('store', '', 'W06449', '6449', NULL, 'Rosnet location 6449'),
    ('store', '', 'W06452', '6452', NULL, 'Rosnet location 6452'), ('store', '', 'W06453', '6453', NULL, 'Rosnet location 6453'),
    ('store', '', 'W06467', '6467', NULL, 'Rosnet location 6467'), ('store', '', 'W06477', '6477', NULL, 'Rosnet location 6477'),
    ('store', '', 'W06487', '6487', NULL, 'Rosnet location 6487'), ('store', '', 'W06619', '6619', NULL, 'Rosnet location 6619'),
    ('store', '', 'W06665', '6665', NULL, 'Rosnet location 6665'), ('store', '', 'W06674', '6674', NULL, 'Rosnet location 6674'),
    ('store', '', 'W06678', '6678', NULL, 'Rosnet location 6678'), ('store', '', 'W06689', '6689', NULL, 'Rosnet location 6689'),
    ('store', '', 'W06690', '6690', NULL, 'Rosnet location 6690'), ('store', '', 'W06694', '6694', NULL, 'Rosnet location 6694'),
    -- jobs: the live Flexspring lookup
    ('job', '', 'CM',   '1',   NULL, 'Crew (Flexspring lookup)'),
    ('job', '', 'CL',   '5',   NULL, 'Team Train / Crew Trainer (Flexspring lookup)'),
    ('job', '', 'CT',   '5',   NULL, 'Team Train / Crew Trainer (Flexspring lookup)'),
    ('job', '', 'SS',   '200', NULL, 'Shift Sup (Flexspring lookup)'),
    ('job', '', 'RM',   '609', NULL, 'Rest. Mgr (Flexspring lookup)'),
    ('job', '', 'RMH',  '610', NULL, 'Asst Mgr (Flexspring lookup)'),
    ('job', '', 'RMIT', '610', NULL, 'Asst Mgr (Flexspring lookup)'),
    ('job', '', 'GM',   '650', NULL, 'General Mg (Flexspring lookup)'),
    ('job', '', 'GMIT', '650', NULL, 'General Mg, same as GM. HR decision 2026-11-18 (not in the Flexspring lookup)'),
    -- terminations: code 1 for every termination (decision 2026-11-18, as Flexspring sends today)
    ('termination', '', 'Voluntary',      '1',   NULL, 'Termination. Decision 2026-11-18: code 1 for every termination'),
    ('termination', '', 'Involuntary',    '1',   NULL, 'Termination. Decision 2026-11-18: code 1 for every termination'),
    ('termination', '', 'Unknown',        '1',   NULL, 'Termination. Decision 2026-11-18: code 1 for every termination'),
    ('termination', '', 'No-show',        '1',   NULL, 'Termination (hired but never worked). Decision 2026-11-18: code 1 for every termination'),
    ('termination', '', 'Administrative', '1',   NULL, 'Termination. Decision 2026-11-18: code 1 for every termination'),
    ('termination', '', 'Leave',          '1',   NULL, 'Termination (leave of absence: profile made inactive, rehired on return). As Flexspring today'),
    ('termination', '', 'Transfer',       '1',   NULL, 'Termination (closes the store left on a transfer). HR decision 2026-11-18: one code for everything'),
    ('termination', '', 'Default',        '1',   NULL, 'Termination: used when a category has no row');

MERGE ref.destination_codes WITH (HOLDLOCK) AS t
USING (SELECT 'rosnet' AS destination, code_type, UPPER(company) AS company, ukg_code, destination_code, destination_id, notes FROM @codes) AS s
   ON t.destination = s.destination AND t.code_type = s.code_type AND t.company = s.company AND t.ukg_code = s.ukg_code
WHEN MATCHED AND (ISNULL(t.destination_code, '') <> ISNULL(s.destination_code, '')
               OR ISNULL(t.destination_id, '') <> ISNULL(s.destination_id, '')
               OR ISNULL(t.notes, '') <> ISNULL(s.notes, ''))
    THEN UPDATE SET destination_code = s.destination_code, destination_id = s.destination_id, notes = s.notes, updated_utc = SYSUTCDATETIME()
WHEN NOT MATCHED BY TARGET
    THEN INSERT (destination, code_type, company, ukg_code, destination_code, destination_id, notes)
         VALUES (s.destination, s.code_type, s.company, s.ukg_code, s.destination_code, s.destination_id, s.notes);

SELECT code_type, company, ukg_code, destination_code, destination_id, notes, updated_utc
FROM ref.destination_codes WHERE destination = 'rosnet' ORDER BY code_type, company, ukg_code;
