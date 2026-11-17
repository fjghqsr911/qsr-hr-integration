-- 24-leave-events-clearview.sql: send leave of absence to Clearview (HR decision, 2026-11-16).
--   Leave of absence  -> terminate: the Clearview profile goes inactive on the first day of leave
--   Return from leave -> create:    a rehire dated the day after the leave ends (an import only if Clearview never had the employee)
-- Run in the Azure portal Query editor on sqldb-hrint after 13 and 23. Safe to rerun.
-- Only events built or changed after this runs are queued (the rebuild queues new and changed events). Leaves already on file
-- are queued by hand if wanted: POST /api/hub/events/queue with their event ids (rpt.workforce_events, event_type in
-- ('Leave of absence', 'Return from leave')).
-- Reason on the leave termination: the connector looks for a termination row with ukg_code 'Leave' per company in
-- ref.destination_codes and otherwise sends the default 13078 'X-2026+ See UKG for Reason'. To show an LOA reason in
-- Clearview instead, add rows such as (the ids are Clearview's 'LOA - Personal' per organization, from the discover report):
--   ('termination', 'SWN6T', 'Leave', '6930',  '6930',  'LOA - Personal'),
--   ('termination', 'SWNGK', 'Leave', '12912', '12912', 'LOA - Personal')
-- to the VALUES block of 17-destination-codes-clearview.sql and rerun it.

INSERT INTO ref.destination_events (destination, event_type, action)
SELECT s.destination, s.event_type, s.action
FROM (VALUES ('clearview', 'Leave of absence', 'terminate'),
             ('clearview', 'Return from leave', 'create')) s (destination, event_type, action)
WHERE NOT EXISTS (SELECT 1 FROM ref.destination_events d WHERE d.destination = s.destination AND d.event_type = s.event_type);

SELECT destination, event_type, action FROM ref.destination_events WHERE destination = 'clearview' ORDER BY action, event_type;
