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
| `ALLOW_LOCAL_NO_AUTH`, `LOCAL_ROLES`, `LOCAL_SCOPES` | Local testing without sign-in | **never set in Azure** (ignored there anyway) |

## Audit log

Sensitive reads, SIN reveals, and (future) writes are recorded in Table Storage `AccessAudit`:
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

13 and 14 have no comments: the portal Query editor rejected them with "Missing end comment mark". The design they implement
is in the plan doc (Delivery design); 14 switches one store (`@store`, default `T00037`) to shadow for `@destination` inside a
rolled-back transaction, deletes and rebuilds that store's employees' events so they queue as new, and must queue nothing on
a second rebuild.

Run 10, 11, 12 in order, review 12's result, then run the full build. Run 13 before re-running 11 (11 queues deliveries
once 13's tables exist; with every store off it queues nothing). Connectors and the delivery queue use `event_key`, never `event_id`.

`schema/` holds the database exported as JSON (views and procedures in `modules.json`, columns and primary keys in `columns.json`);
`checks/` holds dated query results.

## Deploy

VS Code → Azure → `func-hrint-prod-cc` → **Deploy to Function App**.
