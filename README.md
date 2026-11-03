# hrint-api — QSR Group HR Integrations API

Azure Functions (Node 22, TypeScript, v4 model). Entra ID-protected API over UKG Pro with
**app scopes x user roles** access control and a fail-closed audit log for sensitive data.

## Endpoints

| Route | App scope required | User role required | Returns |
|---|---|---|---|
| `GET /api/health` | — (sign-in only) | — | UKG connectivity check |
| `GET /api/me` | — (sign-in only) | — | How the API sees you: caller type, app, roles, scopes |
| `GET /api/employees/{id}/summary` | `Employees.Summary.Read` | `Summary.Read` or `Summary.Admin` | Company, store, job, status, dates |
| `GET /api/employees/{id}/sensitive` | `Employees.Sensitive.Read` | `Sensitive.Read` or `Sensitive.Admin` | Masked SIN, DOB, address, personal contact, pay |
| `GET /api/hub/roster` | `Employees.Summary.Read` | `Summary.Read` or `Summary.Admin` (or app role `Integration.Run` / `Roster.Read.All`) | Active + on-leave roster from the hub: names, store, district, job, dates. Optional comma-separated filters: `jobCodes`, `store`, `district`, `company`, `status` (A/L) |
| `GET /api/hub/roster/contacts` | `Employees.Sensitive.Read` (or app role `RosterContacts.Read.All`) | `Sensitive.Read` / `Sensitive.Admin` | Roster + personal email, work email, work phone, company phone, `birthMonth` / `birthDay` (no year). Audited, fail-closed. Same filters as the roster |
| `GET/POST /api/hub/nightly` | `Employees.Summary.Write` (or app role `Integration.Run`) | `Summary.Admin` | Run the nightly job on demand |
| `PUT /api/hub/stores/{destination}/{store}/mode` body `{ "mode": "off" \| "shadow" \| "live" }` | `Employees.Summary.Write` | `Summary.Admin` | Switch a store's delivery mode for `clearview` or `rosnet` (upserts `ref.store_modes`, `changed_by` = caller). Returns the row. Audited (`write`, field `mode`), fail-closed. No app-only callers |
| `POST /api/hub/deliveries/{id}/retry` | `Employees.Summary.Write` | `Summary.Admin` | Re-queue a `failed` or `dead` delivery: `pending`, next attempt now, attempts kept; any other status → 409. Returns the delivery. Audited (`write`, field `status`), fail-closed |
| `POST /api/hub/deliveries/{id}/resolve` | `Employees.Summary.Write` | `Summary.Admin` | Close a `review` delivery as `resolved` (sets `finished_utc`); any other status → 409. Returns the delivery. Audited (`write`, field `status`), fail-closed |
| `GET /api/hub/diagnostics` | `Employees.Summary.Write` | `Summary.Read` or `Summary.Admin` | Component health for the monitor's Diagnostics tab: `caller`, `settings`, `sql`, `grants`, `audit`, `ukg`, `sync`, `destinations`, each `pass` / `warn` / `fail`. Read-only, not audited, always 200 (problems are statuses in the body). Setting / grant names are listed for `Summary.Admin` only; values never |
| `GET/POST /api/hub/clearview/run` | `Employees.Summary.Write` (or app role `Integration.Run`) | `Summary.Admin` | Drain the Clearview delivery queue now (runs even when `CLEARVIEW_ENABLED` is off). Returns the run counts (`claimed`, `sent`, `shadow`, `unchanged`, `skipped`, `review`, `failed`, `dead`, `waiting`, `resolved`, `purged`, `queue`); 502 when the run failed (e.g. Clearview 401). Audited (`write`, field `deliveries`), fail-closed |
| `POST /api/hub/clearview/discover?what=codes\|employees` | `Employees.Summary.Write` (or app role `Integration.Run`) | `Summary.Admin` | `codes` (default): per organization key, Clearview's stores (paired on `tdlNumber` and written to `ref.destination_codes`), jobs, termination reasons and mandatory attributes, plus unpaired stores and stale mappings, as a report to fill `provisioning/17`. `employees`: seeds `xref.employees` (`source = extract`) from Clearview's employee list by employee number + last name. Audited (`write`), fail-closed |
| `GET /api/employees/{id}/sensitive?reveal=sin` | `Employees.Sensitive.Read` **and** `Employees.Sensitive.Reveal` | `Sensitive.Admin` | Same, with full SIN |

`{id}` = UKG system employee ID (e.g. `EWLTH200NRY0`), visible in UKG page URLs.

### Birthday fields on `/api/hub/roster/contacts`
Every employee in the response has `birthMonth` and `birthDay` (numbers or `null`):
- `birthMonth` 1-12; `birthDay` 1-31, valid for the month; Feb 29 allowed.
- Both filled, or both `null` (no date of birth in UKG, or `HUB_STORE_BIRTHDAY` = `false`).
- No year, full date of birth or age is stored, logged or returned.
- Refreshed nightly (~2:15 AM Toronto); new hires appear the following morning.
- Returned on every call (same role, scope and filters); the access audit records the field names, never values.

**Rules:** every request needs the app's scope AND the user's role. Admin roles include their Read role.
Direct browser sessions (signed in at the Function App URL, no client app) get `SELF_CLIENT_SCOPES`
(default `Employees.Summary.Read`; set to `none` to disable). App-only tokens (no user) are rejected on
user endpoints.

## Workforce Data Hub sync

| Function | Trigger | What it does |
|---|---|---|
| `hubSyncTimer` | Timer, 10:05 / 14:05 / 18:05 / 22:05 **UTC** (6/10/14/18 ET in summer, one hour earlier in winter) | Intraday sync of UKG employee changes into `sqldb-hrint`. Does nothing unless `HUB_SYNC_ENABLED` = `true` |
| `hubSyncRun` | `GET/POST /api/hub/sync` | Same sync on demand (testing, catch-up). Needs role `Summary.Admin` + scope `Employees.Summary.Write`, or app role `Integration.Run`. Runs even when the timer is disabled |
| `clearviewConnectorTimer` | Timer, every 15 minutes | Drains `out.deliveries` for destination `clearview` (see [Clearview connector](#clearview-connector)). Does nothing unless `CLEARVIEW_ENABLED` = `true`. Also runs right after every succeeded / partial intraday sync (`hubSyncTimer` / `hubSyncRun`) when enabled |
| `clearviewRun` | `GET/POST /api/hub/clearview/run` | Same drain on demand; always allowed. Same permissions as `hubSyncRun`, audited |

Each run: window = end of last successful run (or first backfill start) minus 2 hours → `employee-changes` → per employee,
employment details (in-scope check) + job history → one SQL transaction replacing those employees' rows → event rebuild
(if `rpt.usp_rebuild_events` exists). Runs are logged in `stage.sync_runs` (`rpt.v_sync_health`). A partial run (some employees
failed) does not advance the window, so the next run retries them.

### Nightly job (`hubNightlyTimer`, 06:15 UTC = 2:15 AM Toronto summer / 1:15 AM winter)
1. Employment details for status A and L -> today's `stage.employment_snapshot` (Toronto date) + refresh current rows (with names)
2. Person details -> names + contact details + birth month/day (year discarded immediately) for active / on-leave staff only (everything else discarded)
3. Full refresh (employment + job history + events) for employees active in the DB but no longer A/L in UKG (missed terminations),
   A/L employees never seen, and employees whose status, district, store, job or FT/PT differs from the DB (changes the intraday
   sync missed). Decided before step 1's rows are written; a failed refresh keeps the old row, so the next night retries it
4. `stage.employee_contact` fully replaced (leavers' contacts removed)
5. 1st of the month (Toronto): `stage.usp_purge_out_of_scope`
6. No successful intraday sync in 24h -> logs `[hub-sync] failed: ...` (picked up by the App Insights alert)

### Contact details (sensitive tier)
Personal email, work email, work phone, company phone in `stage.employee_contact`, active / on-leave staff only.
Emails are classified by domain: `HUB_WORK_EMAIL_DOMAINS` = work, anything else = personal. Confirm fields with `ukg-contact-fields.ps1`.

Birth month and day (`birth_month`, `birth_day`, tinyint, both or neither; columns and check constraint added by
`provisioning/09-birthday.sql`) are set by the nightly job from UKG `dateOfBirth`; the year is never stored.
The intraday sync has no date of birth: it never changes these columns and leaves new employees' birthdays empty until the
next nightly run. Set `HUB_STORE_BIRTHDAY` = `false` to stop storing them (cleared at the next nightly run).

## Settings

| Setting | Purpose | Azure value |
|---|---|---|
| `UKG_BASE_URL` / `UKG_USERNAME` / `UKG_PASSWORD` / `UKG_CUSTOMER_API_KEY` | UKG connection | Key Vault references |
| `AUDIT_STORAGE_ACCOUNT` | Storage account for the audit table | `sthrintprodcc` (**required** — sensitive endpoint returns 503 without it) |
| `AUDIT_TABLE` | Audit table name | `AccessAudit` (created automatically) |
| `SELF_CLIENT_SCOPES` | Scopes for direct browser sessions | unset (= summary) or `none` |
| `ALLOWED_CLIENT_IDS` | Optional extra allow-list of client app IDs | unset, or comma-separated client IDs |
| `HUB_SQL_SERVER` | Hub SQL server | `sql-qsr-prod-cc.database.windows.net` |
| `HUB_SQL_DATABASE` | Hub database | `sqldb-hrint` |
| `HUB_LOOKBACK_MONTHS` | Scope for terminated employees | `24` |
| `HUB_SYNC_ENABLED` | Kill switch for the scheduled intraday sync AND the nightly job | `false` until the backfill finishes, then `true` |
| `HUB_WORK_EMAIL_DOMAINS` | Domains treated as work email | `qsrgroup.ca` (default) |
| `HUB_EMAIL_FIELDS` | UKG fields scanned for emails | default `emailAddress,alternateEmailAddress,emailAddressAlternate` |
| `HUB_WORK_PHONE_FIELDS` | UKG fields for work phone (priority order) | default `workPhone,workPhoneNumber` |
| `HUB_COMPANY_PHONE_FIELDS` | UKG field(s) for company phone | empty until confirmed |
| `HUB_STORE_BIRTHDAY` | Store birth month + day (no year) for `/api/hub/roster/contacts` | unset (= `true`); `false` clears birthdays at the next nightly run |
| `CLEARVIEW_BASE_URL` | Clearview Connect API base | default `https://api.clearviewconnect.com`; UAT `https://api-uat-cv-api-marketplace.azurewebsites.net` |
| `CLEARVIEW_AUTH_KEY_SWN6T`, `CLEARVIEW_AUTH_KEY_SWNGK` | Clearview `authorizationKey` per UKG company (one Clearview organization each) | Key Vault references. Unset, blank or an unresolved reference (`@Microsoft.KeyVault(` still literal) = missing: that company runs as shadow, nothing is sent |
| `CLEARVIEW_ENABLED` | Timer + after-sync runs of the connector | `false` until the shadow run is reviewed; manual `/api/hub/clearview/run` always works |
| `CLEARVIEW_LIVE_ENABLED` | Kill switch: `false` = every store behaves as shadow, even stores set to `live` | `false` until the phase 5 pilot |
| `CLEARVIEW_COMPANIES` | UKG companies sent to Clearview | default `SWN6T,SWNGK` (`M9WOJ` events become `review`, any other company `skipped`) |
| `CLEARVIEW_EXCLUDED_JOBS` | UKG job codes never sent | default `MM` |
| `CLEARVIEW_TERMINATION_REASON_ID` | Clearview termination reason used unless `ref.destination_codes` maps the category | default `13078` (what Flexspring sends for every termination) |
| `CLEARVIEW_MAX_PER_RUN` | Deliveries claimed per run | default `200` |
| `CLEARVIEW_WAITING_ALERT_DAYS` | Days after a sent import before `[delivery] waiting` is logged for an employee Payroll has not added | default `5` |
| `CLEARVIEW_TIMEOUT_MS` | Clearview call timeout | default `20000` |
| `HUB_SHADOW_RETENTION_DAYS` | Days masked shadow payloads are kept in `out.shadow_payloads` | default `30` |
| `ALLOW_LOCAL_NO_AUTH`, `LOCAL_ROLES`, `LOCAL_SCOPES` | Local testing without sign-in | **never set in Azure** (ignored there anyway) |

## Audit log

Sensitive reads, SIN reveals, and writes (store mode, delivery retry / resolve, Clearview run / discover) are recorded in Table Storage `AccessAudit`:
who, which app, which employee, which **field names**, action, outcome, time — never values.
Partition = `yyyyMM`; rows sort newest first. If the audit write fails, **no data is returned**.

## Local run

1. `npm install`
2. Copy `local.settings.example.json` → `local.settings.json`; fill in UKG values.
3. To test the sensitive endpoint locally, set `LOCAL_ROLES` = `Summary.Read,Sensitive.Admin` and
   `LOCAL_SCOPES` = `Employees.Summary.Read,Employees.Sensitive.Read,Employees.Sensitive.Reveal`.
   Audit records print to the console locally.
4. `npm start` → `http://localhost:7071/api/me`

## Tests

`npm run build`, then `node test/run-all.js` (mocked SQL / UKG / audit; no network, no real data).

## Database scripts (`provisioning/`)

Run manually in the Azure portal Query editor on `sqldb-hrint`; each is safe to re-run.

| Script | What it does |
|---|---|
| `09-birthday.sql` | Adds `birth_month` / `birth_day` + check constraint `stage.ck_contact_birthday` to `stage.employee_contact` |
| `10-workforce-event-key.sql` | Adds `event_key` (stable SHA-256 key, unique) to `rpt.workforce_events`, indexes for the event rebuild, and an `event_id` sequence if it is not an identity |
| `11-usp-rebuild-events.sql` | Creates `rpt.usp_rebuild_events` (event rules are in its header). Once it exists, every sync calls it; build the history once with `EXEC rpt.usp_rebuild_events @employee_ids = NULL` |
| `12-check-rebuild-events.sql` | Dry run of the full build, rolled back: events by rule and type, and a second run that must change nothing |

| `13-delivery-tables.sql` | Delivery design tables: `ref.destination_events` (seeded), `ref.destination_codes`, `ref.store_modes` (no row = off), `out.deliveries`, `out.last_sent`, `out.shadow_payloads`, `xref.employees` (never purged) |
| `14-check-deliveries.sql` | Dry run of the delivery queue for one store in shadow, rolled back; a second rebuild must queue nothing |
| `15-admin-endpoint-grants.sql` | Grants the Function App user INSERT/UPDATE on `ref.store_modes` and UPDATE on `out.deliveries` for the admin endpoints (store mode, retry, resolve). Without it they return 503 |
| `16-connector-grants-and-columns.sql` | Clearview connector: grants to `mi-func-hrint` on `out.last_sent`, `out.shadow_payloads`, `xref.employees`, `ref.destination_codes`, `stage.sync_runs` and SELECT on the tables it reads; adds `out.deliveries.response_ref`, the `waiting` / `skipped` statuses, `ref.destination_codes.destination_id` and the `category` / `company` code types. Run before the first connector run; the Diagnostics tab's grants check lists what is missing |
| `17-destination-codes-clearview.sql` | Re-runnable MERGE template for the job / termination / category / company pairs a person decides. Fill its VALUES block from the `discover` report (stores are paired automatically by `discover`, not here) |

13 and 14 have no comments: the portal Query editor rejected them with "Missing end comment mark". The design they implement
is in the plan doc (Delivery design); 14 switches one store (`@store`, default `T00037`) to shadow for `@destination` inside a
rolled-back transaction, deletes and rebuilds that store's employees' events so they queue as new, and must queue nothing on
a second rebuild.

Run 10, 11, 12 in order, review 12's result, then run the full build. Run 13 before re-running 11 (11 queues deliveries
once 13's tables exist; with every store off it queues nothing). Connectors and the delivery queue use `event_key`, never `event_id`.

`schema/` holds the database exported as JSON (views and procedures in `modules.json`, columns and primary keys in `columns.json`);
`checks/` holds dated query results.

## Clearview connector

Phase 4 of the Flexspring replacement: `src/shared/delivery.ts` (generic runner over `out.deliveries`, reused by Rosnet in
phase 6), `src/shared/deliveryStore.ts` (SQL), `src/shared/clearview/` (`client`, pure `mapper`, `connector`, `discover`),
`src/shared/connectors.ts` (wiring) and `src/functions/clearviewConnector.ts` (timer + endpoints). Design: plan doc, "Phase 4".

**Each run** (timer every 15 min, after each successful intraday sync, or `/api/hub/clearview/run`): lock via `stage.sync_runs`
(`run_type = delivery`) → claim up to `CLEARVIEW_MAX_PER_RUN` due `pending` / `failed` / `waiting` rows, skipping employees that have a
blocking row (`dead`, or `failed` / `waiting` not yet due), ordered per employee by effective date then
create < job < store < pay < update < terminate → per delivery: re-read the store's mode (`off` → `skipped`), read what the action
needs from UKG at send time (person details for an import, pay for import / rehire / pay change), build the Clearview call
sequence (the pure mapper), hash it → shadow or live (below) → afterwards `resolveCreated` (imports Payroll has added get their
`xref`), purge shadow payloads older than `HUB_SHADOW_RETENTION_DAYS`, and log
`[delivery] queue: destination=clearview pending=N oldest_pending_minutes=M`.

**Shadow vs live.** A delivery is sent only when its store is `live` in `ref.store_modes` **and** `CLEARVIEW_LIVE_ENABLED` = `true`
**and** the employee's company has a key; otherwise it runs as shadow (one warning per run says why). Shadow builds the exact
request, stores a masked copy in `out.shadow_payloads` (DOB `****-**-**`, SIN `*********`, pay `***`; Clearview ids it would look
up appear as `$lookup:…`) and marks the delivery `shadow`, so unmapped codes, missing SINs and bad dates surface before anything is
sent. Live checks the payload hash against `out.last_sent` (`unchanged` when equal), GETs before every write (an assignment, job or
termination that is already there is not sent twice), sends, then records `last_sent`, `response_ref` and any Clearview id learned
on the way in `xref.employees`.

**Statuses.** Besides the existing ones: `waiting` = the employee is not in Clearview yet (import not approved by Payroll, or an
employee Flexspring never created); retried hourly without counting an attempt, alerted as `[delivery] waiting: …` after
`CLEARVIEW_WAITING_ALERT_DAYS`. `skipped` = out of scope at send time (store off, company or job not sent, OPS). Transient failures
(network, timeout, 429, 5xx) retry after 5 min, 30 min, 2 h, 12 h, then `dead` (`[delivery] dead: destination=clearview
delivery_id=… employee=… attempts=5`); 400 / 422 and mapping or validation errors are `dead` at once with Clearview's message in
`last_error` (never values); 401 / 403 abort the run and leave every row untouched. A failed, waiting or dead delivery holds that
employee's later ones until it is resolved. Transfers to a non-store (OPS, FIN …) and `M9WOJ` events become `review`.

**Per action.** `create` is an **import** (`POST /employee/import` into Clearview's staging area, Flexspring's proven minimum plus
`preferredFirstName` and `externalId` = UKG employee ID; Payroll adds the employee, no `xref` until then) when Clearview has no
record of the employee, and a **rehire** (`PUT /employeeStatus/{id}/rehire`) when it has (`xref` present), whatever the event type.
`terminate` sends `{terminationDate, terminationReasonId}` (reason 13078 unless the category is mapped). `store` adds the store
assignment, ends the previous one the day before on a store transfer, and tries to patch the reporting store (unverified, warning
only if refused). `job` promotes the target job (or adds it at the current primary rate) and demotes the old primary. `pay` posts
the flat v2 body `{effectiveDate, payTypeCode, payRate, salaryHours}` on the primary job. `update` patches `empCatCode`.

**Mapping discovery.** Codes live in `ref.destination_codes` (`destination_code` = what Clearview calls it, `destination_id` = its
internal id). `POST /api/hub/clearview/discover` reads every organization and pairs stores automatically on **`tdlNumber`**: the hub
store code's digits (`T22446` → `22446`) equal the TDL number without its leading 1 (`122446`); the UKG code is never turned into
a Clearview number by rule, because UKG could not hold six digits. Paired stores and the `company` → `organizationId` rows are
written; jobs (`jobCode`, org `jobId`, name) and termination reasons are listed for a person to pair in `provisioning/17`; unpaired
hub and Clearview stores and mappings Clearview no longer knows are reported. `?what=employees` seeds `xref.employees` from
Clearview's employee list by employee number + last name (Flexspring never set `externalId`). The Diagnostics tab's
`destinations[0]` shows enabled / live / credentials, a timed `GET /organization/stores` (skipped without keys), the queue counts
and how many codes of each type are mapped.

**Two organizations, one key each.** Clearview holds two organizations (store 2462: organizationId 18, employerCode O01189;
store 6105: organizationId 1690, employerCode STIS). Each has its own `authorizationKey`, set per UKG company as
`CLEARVIEW_AUTH_KEY_SWN6T` / `CLEARVIEW_AUTH_KEY_SWNGK`; the client picks the key from the employee's company at send time. Which
company is which organization is confirmed by `discover` (the company row's notes carry the employer code).

**To confirm in UAT before live** (the shadow build makes none of these a blocker):
1. The import flow: does `externalId` survive Import → Payroll adding the employee, and is our employee number kept as
   `employeeNumber`? (Decides how created ids resolve; the fallback is employee number + last name.) Also the rehire body's field
   names: the v2 schema says `jobKey` / `primaryJobFlag` (what the connector sends), the swagger example says `jobId` / `primaryJob`.
2. Reporting store on a transfer: is `reportingStoreId` patchable? The connector tries `PATCH /employee/{id}` and records a warning
   on the delivery if Clearview refuses it.
3. Required attributes and category codes: `filecontrol?requiredAttributesOnly=true` per organization (listed by `discover`),
   `employeeCategoryCode` for F / P (the `category` code type is reserved and not sent yet), one UAT pay call to confirm the flat
   `yyyy-MM-dd` body fixes Flexspring's 400.

Tests: `test/clearview-mapper.test.js` (fixtures in `test/fixtures/clearview/`, one per operation), `test/delivery.test.js`,
`test/clearview-connector.test.js`, `test/clearview-function.test.js`; mocks only.

## Deploy

VS Code → Azure → `func-hrint-prod-cc` → **Deploy to Function App**.

### Letting the monitor call the admin endpoints

The read-only monitor UI (`ukg-ee-changes-monitor`) calls `PUT /api/hub/stores/…/mode` and `POST /api/hub/deliveries/{id}/retry|resolve`
with the signed-in user's token. After deploying, in the portal:

1. Function App `func-hrint-prod-cc` → **Authentication** → Microsoft identity provider → **Allowed client applications** →
   add the monitor's client ID (printed by the monitor's `deploy/01-entra-app.sh`). If `ALLOWED_CLIENT_IDS` is set, add it there too.
2. Function App → **CORS** → **Allowed Origins** → add the monitor's URL (e.g. `https://<monitor web app>.azurewebsites.net`);
   leave *Enable Access-Control-Allow-Credentials* off (the monitor sends a bearer token, not cookies).
3. `provisioning/15-admin-endpoint-grants.sql` on `sqldb-hrint`: the admin endpoints write `ref.store_modes` and `out.deliveries`
   directly, which the Function App user is not otherwise allowed to do.

The monitor's users still need role `Summary.Admin` on this API's enterprise app and the monitor app needs the delegated
`Employees.Summary.Write` scope with admin consent (both set up by `01-entra-app.sh`).
Monitor readers who are not admins need at least `Summary.Read` on this API to see the components on the Diagnostics tab
(`GET /api/hub/diagnostics`); only `Summary.Admin` sees which settings or grants are missing by name.
