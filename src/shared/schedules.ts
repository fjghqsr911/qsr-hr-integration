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

/** How long a scheduled intraday sync waits before it calls UKG's change feed: its position among the day's sync hours
 *  times the step. UKG releases a batch at most once every 3 hours, almost to the second, so runs exactly 3 hours apart
 *  land on that limit once the hub has released a batch itself: the first call misses and the second read releases a
 *  batch nothing reads. With the step, each first call is 3 hours plus the step after the one before. 0 for an hour
 *  that is not a sync hour or a cron of another shape. Keep the step at least 75 s above HUB_FEED_SECOND_READ_SECONDS,
 *  so a run also recovers after a second read that did release. */
export function feedStaggerMs(now: Date, stepSeconds: number, cron = HUB_SYNC_CRON): number {
  const sync = parseDailyCron(cron);
  const slot = sync ? [...sync.hours].sort((a, b) => a - b).indexOf(now.getUTCHours()) : -1;
  return slot > 0 && stepSeconds > 0 ? slot * stepSeconds * 1000 : 0;
}
