// The hub's two sync timers, in one place: hubSync.ts registers them and Diagnostics reports them, so what the monitor
// compares its own settings against is exactly what is deployed. Times are UTC (Flex Consumption has no time zone setting).

/** Intraday sync: 10:10, 13:10, 16:10, 19:10, 22:10 UTC, 10 minutes after Flexspring's calls release UKG's change feed
 *  (see functions/hubSync.ts for why these times). */
export const HUB_SYNC_CRON = "0 10 10,13,16,19,22 * * *";
/** Nightly check: 06:15 UTC. */
export const HUB_NIGHTLY_CRON = "0 15 6 * * *";

export interface HubSchedule { syncHoursUtc: number[]; syncMinuteUtc: number; nightlyUtc: string; }

/** Minute and hours of a "0 <minute> <hour[,hour...]> * * *" cron; null for any other shape. */
export function parseDailyCron(cron: string): { minute: number; hours: number[] } | null {
  const m = /^0 (\d{1,2}) (\d{1,2}(?:,\d{1,2})*) \* \* \*$/.exec(cron.trim());
  if (!m) return null;
  const minute = Number(m[1]), hours = m[2].split(",").map(Number);
  return minute < 60 && hours.every(h => h < 24) ? { minute, hours } : null;
}

/** The deployed schedule in the shape the monitor's own settings use (SYNC_HOURS_UTC, SYNC_MINUTE_UTC, NIGHTLY_UTC). */
export function hubSchedule(syncCron = HUB_SYNC_CRON, nightlyCron = HUB_NIGHTLY_CRON): HubSchedule | null {
  const sync = parseDailyCron(syncCron), nightly = parseDailyCron(nightlyCron);
  if (!sync || !nightly || nightly.hours.length !== 1) return null;
  const two = (n: number) => String(n).padStart(2, "0");
  return { syncHoursUtc: sync.hours, syncMinuteUtc: sync.minute, nightlyUtc: `${two(nightly.hours[0])}:${two(nightly.minute)}` };
}
