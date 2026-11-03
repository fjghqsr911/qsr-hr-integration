/* node test/run-all.js  (after npm run build). Mocks only: no network, no real data. */
process.env.ALLOW_LOCAL_NO_AUTH = "false";
delete process.env.WEBSITE_INSTANCE_ID;
delete process.env.ALLOWED_CLIENT_IDS;
delete process.env.HUB_STORE_BIRTHDAY;
for (const k of Object.keys(process.env)) if (k.startsWith("CLEARVIEW_")) delete process.env[k];

const { summary } = require("./helpers");

(async () => {
  await require("./birthday.test.js")();
  await require("./existing.test.js")();
  await require("./nightly.test.js")();
  await require("./admin.test.js")();
  await require("./clearview-mapper.test.js")();
  await require("./delivery.test.js")();
  await require("./clearview-connector.test.js")();
  await require("./clearview-function.test.js")();
  await require("./diagnostics.test.js")();
  const { passed, failed } = summary();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
