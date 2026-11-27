/* Intraday sync: the second read of UKG's employee-changes feed (a call releases a batch but does not receive it). */
const path = require("path");
const { DIST, test, report, eq, assert } = require("./helpers");
const { runIntradaySync } = require(path.join(DIST, "shared", "hubSync.js"));

const emp = (id) => ({ employeeID: id, companyID: "SWN6T", employeeNumber: id.slice(-3), employeeStatusCode: "A",
  orgLevel1Code: "T2", orgLevel2Code: "T01647", primaryJobCode: "CM" });

function store() {
  const w = { replaced: null, runs: [] };
  return {
    w,
    async lastSyncedUntil() { return new Date("2026-11-25T19:10:00Z"); },
    async isRunning() { return false; },
    async termCodes() { return new Map(); },
    async startRun(type, start, end) { w.runs.push({ type, start, end }); return "run-1"; },
    async finishRun() {},
    async replaceEmployees(ids) { w.replaced = ids; },
    async rebuildEvents() { return 0; }
  };
}

/** UKG where each call of the feed gets the next answer in `feeds` (an array of rows, or an Error to throw). */
function ukg(feeds) {
  const calls = [];
  return {
    calls,
    async getAll(p) {
      if (p.startsWith("/personnel/v1/employee-changes")) {
        calls.push(p);
        const a = feeds[Math.min(calls.length - 1, feeds.length - 1)];
        if (a instanceof Error) throw a;
        return a;
      }
      const m = /employee-employment-details\?employeeId=(\w+)/.exec(p);
      return m ? [emp(m[1])] : [];
    }
  };
}
const end = (p) => decodeURIComponent(/endDate=([^&]+)/.exec(p)[1]);
const now = new Date("2026-11-25T22:10:00Z");

module.exports = async function run() {
  await test("feed: the second read returns the batch the first call released; same start, end 90 s later; the window end recorded is the first call's", async () => {
    const s = store(), slept = [], logs = [];
    const u = ukg([[{ employeeId: "E1", firstName: "Old" }], [{ employeeId: "E1", firstName: "New" }, { employeeId: "E2", firstName: "Bo" }]]);
    const r = await runIntradaySync(s, u, { lookbackMonths: 24, now, secondReadMs: 90_000, sleep: async (ms) => { slept.push(ms); }, log: (m) => logs.push(m) });
    eq(r.status, "succeeded"); eq(slept, [90_000]); eq(u.calls.length, 2);
    eq([end(u.calls[0]), end(u.calls[1])], ["2026-11-25T22:10:00Z", "2026-11-25T22:11:30Z"]);
    eq(u.calls[0].split("&endDate")[0], u.calls[1].split("&endDate")[0], "same start");
    eq([...s.w.replaced].sort(), ["E1", "E2"]); eq([r.employeesChanged, r.secondReadEmployees, r.changeRecords], [2, 1, 2]);
    eq(r.windowEnd, "2026-11-25T22:10:00Z"); eq(s.w.runs[0].end.toISOString(), now.toISOString());
    assert(logs.some(m => m.includes("1 of them only in the second read")), "log says what the second read added");
  });

  await test("feed: an employee only the first read had is kept", async () => {
    const s = store();
    const u = ukg([[{ employeeId: "E1" }, { employeeId: "E3" }], [{ employeeId: "E2" }]]);
    const r = await runIntradaySync(s, u, { lookbackMonths: 24, now, secondReadMs: 1000, sleep: async () => {} });
    eq([...s.w.replaced].sort(), ["E1", "E2", "E3"]); eq(r.secondReadEmployees, 1);
  });

  await test("feed: a failing second read keeps the first answer; a 401 on it fails the run", async () => {
    const s = store(), logs = [];
    const r = await runIntradaySync(s, ukg([[{ employeeId: "E1" }], new Error("UKG 500 https://x/y?startDate=1")]),
      { lookbackMonths: 24, now, secondReadMs: 1000, sleep: async () => {}, log: (m) => logs.push(m) });
    eq(r.status, "succeeded"); eq(s.w.replaced, ["E1"]); eq(r.secondReadEmployees, 0);
    assert(logs.some(m => m.includes("second read of employee-changes failed (UKG 500 https://x/y)")), "logged without the query string");
    const denied = Object.assign(new Error("UKG 401"), { status: 401 });
    eq((await runIntradaySync(store(), ukg([[{ employeeId: "E1" }], denied]), { lookbackMonths: 24, now, secondReadMs: 1000, sleep: async () => {} })).status, "failed");
  });

  await test("feed: no second read unless asked (0 or missing)", async () => {
    for (const opt of [{}, { secondReadMs: 0 }]) {
      const u = ukg([[{ employeeId: "E1" }]]); let slept = 0;
      const r = await runIntradaySync(store(), u, { lookbackMonths: 24, now, sleep: async () => { slept++; }, ...opt });
      eq([u.calls.length, slept, r.secondReadEmployees], [1, 0, undefined]);
    }
  });

  await test("feed: the pause setting defaults to 90 s, accepts 0 and is capped at 300", () => {
    const { config } = require(path.join(DIST, "shared", "config.js"));
    const saved = process.env.HUB_FEED_SECOND_READ_SECONDS;
    const at = (v) => { if (v === undefined) delete process.env.HUB_FEED_SECOND_READ_SECONDS; else process.env.HUB_FEED_SECOND_READ_SECONDS = v; return config.hubFeedSecondReadSeconds; };
    eq([at(undefined), at("0"), at("45"), at("9999"), at("abc"), at("-5")], [90, 0, 45, 300, 90, 90]);
    at(saved);
  });

  await test("feed: a scheduled run waits by its position in the day (0, 3, 6, 9, 12 minutes at 180 s)", () => {
    const { feedStaggerMs } = require(path.join(DIST, "shared", "schedules.js"));
    const at = (h, step = 180, cron) => feedStaggerMs(new Date(Date.UTC(2026, 10, 27, h, 10, 0)), step, cron);
    eq([10, 13, 16, 19, 22].map(h => at(h)), [0, 180_000, 360_000, 540_000, 720_000]);
    eq([at(6), at(14), at(23)], [0, 0, 0], "not a sync hour: no wait");
    eq([at(22, 0), at(22, -5)], [0, 0], "step 0 switches it off");
    eq(at(13, 180, "0 */5 * * * *"), 0, "a cron of another shape: no wait");
    const other = "0 50 21,9,15 * * *";                // position is by time of day, not by the order written
    eq([at(9, 60, other), at(15, 60, other), at(21, 60, other)], [0, 60_000, 120_000]);
  });

  await test("feed: the stagger setting defaults to 180 s, accepts 0 and is capped at 300", () => {
    const { config } = require(path.join(DIST, "shared", "config.js"));
    const saved = process.env.HUB_FEED_STAGGER_SECONDS;
    const at = (v) => { if (v === undefined) delete process.env.HUB_FEED_STAGGER_SECONDS; else process.env.HUB_FEED_STAGGER_SECONDS = v; return config.hubFeedStaggerSeconds; };
    eq([at(undefined), at("0"), at("60"), at("9999"), at("abc"), at("-5")], [180, 0, 60, 300, 180, 180]);
    at(saved);
  });

  report("hubsync-feed");
};
