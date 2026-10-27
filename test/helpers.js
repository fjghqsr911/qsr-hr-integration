/* Tiny test harness + mocks. No network, no real data. Run after `npm run build`. */
const path = require("path");

const DIST = path.join(__dirname, "..", "dist", "src");
const FAKE_YEAR = "1987";            // fake DOB year: must never appear in any output

let passed = 0, failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok   ${name}`); }
  catch (e) { failed++; results.push(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n       ") : e}`); }
}
function report(suite) {
  console.log(`\n${suite}`); results.splice(0).forEach(r => console.log(r));
}
const summary = () => ({ passed, failed });

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg || "not equal"}: got ${A}, expected ${B}`);
}
function noYear(value, where) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  assert(!s.includes(FAKE_YEAR), `birth year leaked into ${where}`);
}

/** Replace a compiled module with a stub (must run before anything requires it). */
function stubModule(rel, exports) {
  const file = require.resolve(path.join(DIST, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

/** Fake mssql pool: records every query text + inputs; returns canned recordsets. */
function fakePool(answer = () => ({ recordset: [], recordsets: [[]] })) {
  const calls = [];
  const pool = {
    calls, connected: true,
    request() {
      const inputs = {};
      const req = {
        input(name, _type, value) { inputs[name] = value; return req; },
        async query(text) { calls.push({ text, inputs }); return answer(text, inputs); },
        async execute(proc) { calls.push({ text: `EXEC ${proc}`, inputs }); return { returnValue: 0, recordset: [] }; }
      };
      return req;
    },
    async close() {}
  };
  return pool;
}

module.exports = { DIST, FAKE_YEAR, test, report, summary, assert, eq, noYear, stubModule, fakePool };
