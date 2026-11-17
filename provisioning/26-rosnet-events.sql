-- 26-rosnet-events.sql: the event types Rosnet takes in addition to the ones script 13 seeded
-- (new hire, rehire, cross-company transfer in, the three terminations, store and temporary transfer, promotion,
-- demotion, job change).
--   Pay change                  -> pay        modifyJob with the hourly rate (decision 2026-11-16: pay changes are sent)
--   Leave of absence            -> terminate  the Aloha profile is made inactive on the first day of leave (same decision
--   Return from leave           -> create     as Clearview, script 24), and rehired on the return day
--   Cross-company transfer out  -> terminate  leaving SWN1U for another company ends the Aloha profile at the W store
-- The connector decides at send time whether a create is an add or a rehire, from what Aloha holds at the location.
-- Events of these types that already exist are not queued by this script: they are picked up from the next sync on
-- (or queue chosen ones with provisioning/22-queue-events.sql).
-- Run in the Azure portal Query editor on sqldb-hrint after 25. Safe to rerun. Comments contain no apostrophes.

INSERT INTO ref.destination_events (destination, event_type, action)
SELECT s.destination, s.event_type, s.action
FROM (VALUES ('rosnet', 'Pay change', 'pay'),
             ('rosnet', 'Leave of absence', 'terminate'),
             ('rosnet', 'Return from leave', 'create'),
             ('rosnet', 'Cross-company transfer out', 'terminate')) s (destination, event_type, action)
WHERE NOT EXISTS (SELECT 1 FROM ref.destination_events d WHERE d.destination = s.destination AND d.event_type = s.event_type);

SELECT destination, event_type, action FROM ref.destination_events WHERE destination = 'rosnet' ORDER BY action, event_type;
