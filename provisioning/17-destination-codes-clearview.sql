-- 17-destination-codes-clearview.sql: Clearview code pairs that a person decides (jobs, termination reasons, categories,
-- companies). Stores are paired automatically by POST /api/hub/clearview/discover on tdlNumber and are not listed here;
-- run discover first, then copy the job and termination reason lists from its report into the VALUES block below.
-- Each row: code_type, company, UKG code, Clearview code, Clearview id, note. company = the UKG company whose Clearview
-- organization the pair belongs to (SWN6T or SWNGK); empty = shared by both organizations (stores and company rows are).
--   job:          UKG job code (SF, SS, TL, NS, PR, CA, TR, GM, RM, RMH, RMIT, GMIT) to Clearview jobCode (destination_code) and
--                 organization jobId (destination_id), per company: the jobCode is the same in both organizations, the jobId differs
--   termination:  UKG termination category (Voluntary, Involuntary, Unknown, No show, Administrative) to Clearview terminationReasonId
--                 (destination_code = destination_id = the id). Without a row the connector uses CLEARVIEW_TERMINATION_REASON_ID.
--   category:     UKG full_or_part_time F or P to the Clearview employeeCategoryCode (reserved; not sent until UAT confirms it)
--   company:      UKG company (SWN6T, SWNGK) to the Clearview organizationId (destination_code) and employerCode (notes)
-- Run in the Azure portal Query editor on sqldb-hrint after 16. Safe to rerun: a MERGE on (destination, code_type, ukg_code).
-- Comments contain no apostrophes.
--
-- Values below: discover report of 2026-11-16 (organizations 18 PFSL and 1690 STIS) plus what the live Flexspring integration
-- put in Clearview, read back per UKG job code and matched to the hub roster by employee number (see
-- clearview-mapping-findings-2026-11-16.md in the parent folder). Every store job in the roster is covered: the four manager
-- codes all land in the single Clearview job Managers; Truck is Truck in PFSL and Delivery in STIS; STIS has no Common Area
-- job and no CA staff. Head office codes (DM, MM, BM, ACL ...) are not sent: DM employees are absent or inactive in Clearview.
-- Termination: Flexspring sends 13078 for every termination in BOTH organizations (21 of 25 and 20 of 25 recent ones); the id
-- is not in the STIS terminationReason list yet Clearview accepts it there, so one shared row and the same default suffice.

DECLARE @codes TABLE (code_type varchar(20), company varchar(10), ukg_code varchar(20), destination_code nvarchar(50), destination_id nvarchar(50), notes nvarchar(200));

INSERT INTO @codes (code_type, company, ukg_code, destination_code, destination_id, notes) VALUES
    ('company',     '',      'SWN6T',        '18',    NULL,    'employerCode O01189 Pioneer Foods'),
    ('company',     '',      'SWNGK',        '1690',  NULL,    'employerCode O01189 Stis Investments Limited'),
    -- PFSL, organization 18
    ('job',         'SWN6T', 'SF',           '1',     '88',    'org 18 Counter Staff - Storefront'),
    ('job',         'SWN6T', 'SS',           '10',    '9444',  'org 18 Supervisor'),
    ('job',         'SWN6T', 'TL',           '12',    '21998', 'org 18 Team Leader'),
    ('job',         'SWN6T', 'NS',           '119',   '28956', 'org 18 Night Shift'),
    ('job',         'SWN6T', 'PR',           '90',    '27900', 'org 18 Production'),
    ('job',         'SWN6T', 'CA',           '5',     '92',    'org 18 Common Area'),
    ('job',         'SWN6T', 'TR',           '6',     '93',    'org 18 Truck'),
    ('job',         'SWN6T', 'GM',           '4',     '91',    'org 18 Managers - General Manager'),
    ('job',         'SWN6T', 'RM',           '4',     '91',    'org 18 Managers - Restaurant Manager'),
    ('job',         'SWN6T', 'RMH',          '4',     '91',    'org 18 Managers - Restaurant Manager H'),
    ('job',         'SWN6T', 'RMIT',         '4',     '91',    'org 18 Managers - Restaurant Mgr in Train'),
    ('job',         'SWN6T', 'GMIT',         '4',     '91',    'org 18 Managers - General Mgr in Train'),
    -- STIS, organization 1690
    ('job',         'SWNGK', 'SF',           '1',     '9039',  'org 1690 Counter Staff - Storefront'),
    ('job',         'SWNGK', 'SS',           '10',    '42436', 'org 1690 Supervisor'),
    ('job',         'SWNGK', 'TL',           '12',    '42437', 'org 1690 Team Leader'),
    ('job',         'SWNGK', 'NS',           '119',   '46477', 'org 1690 Night Shift'),
    ('job',         'SWNGK', 'PR',           '90',    '42439', 'org 1690 Production'),
    ('job',         'SWNGK', 'TR',           '57',    '39186', 'org 1690 Delivery - Truck'),
    ('job',         'SWNGK', 'GM',           '4',     '9042',  'org 1690 Managers - General Manager'),
    ('job',         'SWNGK', 'RM',           '4',     '9042',  'org 1690 Managers - Restaurant Manager'),
    ('job',         'SWNGK', 'RMH',          '4',     '9042',  'org 1690 Managers - Restaurant Manager H'),
    ('job',         'SWNGK', 'RMIT',         '4',     '9042',  'org 1690 Managers - Restaurant Mgr in Train (by rule; none in roster)'),
    ('job',         'SWNGK', 'GMIT',         '4',     '9042',  'org 1690 Managers - General Mgr in Train (by rule; none in roster)'),
    -- shared: every termination category -> the reason Flexspring uses in both organizations (also the configured default)
    ('termination', '',      'Voluntary',    '13078', '13078', 'X-2026+ See UKG for Reason - what Flexspring sends for every termination');

MERGE ref.destination_codes WITH (HOLDLOCK) AS t
USING (SELECT 'clearview' AS destination, code_type, UPPER(company) AS company, ukg_code, destination_code, destination_id, notes FROM @codes) AS s
   ON t.destination = s.destination AND t.code_type = s.code_type AND t.company = s.company AND t.ukg_code = s.ukg_code
WHEN MATCHED AND (ISNULL(t.destination_code, '') <> ISNULL(s.destination_code, '')
               OR ISNULL(t.destination_id, '') <> ISNULL(s.destination_id, '')
               OR ISNULL(t.notes, '') <> ISNULL(s.notes, ''))
    THEN UPDATE SET destination_code = s.destination_code, destination_id = s.destination_id, notes = s.notes, updated_utc = SYSUTCDATETIME()
WHEN NOT MATCHED BY TARGET
    THEN INSERT (destination, code_type, company, ukg_code, destination_code, destination_id, notes)
         VALUES (s.destination, s.code_type, s.company, s.ukg_code, s.destination_code, s.destination_id, s.notes);

SELECT code_type, company, ukg_code, destination_code, destination_id, notes, updated_utc
FROM ref.destination_codes WHERE destination = 'clearview' ORDER BY code_type, company, ukg_code;
