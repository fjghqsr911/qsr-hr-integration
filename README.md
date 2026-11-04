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
| `POST /api/hub/deliveries/{id}/resolve` | `Employees.Summary.Write` | `Summary.Admin` | Close a `review` or `dead` delivery as `resolved` (sets `finished_utc`); any other status → 409. A dead delivery blocks the employee's later ones until it is retried or resolved. Returns the delivery. Audited (`write`, field `status`), fail-closed |
| `GET /api/hub/diagnostics` | `Employees.Summary.Write` | `Summary.Read` or `Summary.Admin` | Component health for the monitor's Diagnostics tab: `caller`, `settings`, `sql`, `grants`, `audit`, `ukg`, `sync`, `entra`, `destinations`, each `pass` / `warn` / `fail`. Read-only, not audited, always 200 (problems are statuses in the body). Setting / grant names are listed for `Summary.Admin` only; values never |
| `GET/POST /api/hub/clearview/run` | `Employees.Summary.Write` (or app role `Integration.Run`) | `Summary.Admin` | Drain the Clearview delivery queue now (runs even when `CLEARVIEW_ENABLED` is off). Returns the run counts (`claimed`, `sent`, `shadow`, `unchanged`, `skipped`, `review`, `failed`, `dead`, `waiting`, `resolved`, `purged`, `queue`); 502 when the run failed (e.g. Clearview 401). Audited (`write`, field `deliveries`), fail-closed |
| `POST /api/hub/clearview/discover?what=codes\|employees` | `Employees.Summary.Write` (or app role `Integration.Run`) | `Summary.Admin` | `codes` (default): per organization key, Clearview's stores (paired on `tdlNumber` and written to `ref.destination_codes`), jobs, termination reasons and mandatory attributes, plus unpaired stores and stale mappings, as a report to fill `provisioning/17`. `employees`: seeds `xref.employees` (`source = extract`) from Clearview's employee list by employee number + last name. 409 while `CLEARVIEW_ENABLED` is not `true` (the first Clearview call starts billing). Audited (`write`), fail-closed |
| `GET /api/employees/{id}/sensitive?reveal=sin` | `Employees.Sensitive.Read` **and** `Employees.Sensitive.Reveal` | `Sensitive.Admin` | Same, with full SIN |
| `POST /api/hub/entra/sync` | `Employees.Summary.Write` (or app role `Integration.Run`) | `Entra.Admin` | Run the [Entra sync](#entra-sync) now (snapshot, link, compare; never writes to Entra). Returns the run counts; 409 while another run holds the lock, 502 when the run failed. Audited (`write`, field `proposals`), fail-closed |
| `POST /api/hub/entra/proposals/{id}/accept` | `Employees.Summary.Write` | `Entra.Admin` | `proposed` -> `accepted`, then applied at once (`applyOutcome` = `applied` / `failed` / `stale`) unless the proposal is due later (`due_later`, e.g. a disable on the date last worked) or `ENTRA_WRITE_ENABLED` is off (`writes_disabled`: the acceptance is still recorded). Returns the proposal; any other status -> 409. Audited (`write`, the field or kind), fail-closed |
| `POST /api/hub/entra/proposals/{id}/reject` | `Employees.Summary.Write` | `Entra.Admin` | `proposed` / `accepted` -> `rejected` and a rejection row: the identical change is not proposed again until the difference disappears. 409 otherwise. Audited |
| `POST /api/hub/entra/proposals/{id}/apply` | `Employees.Summary.Write` | `Entra.Admin` | `accepted` -> `applying` -> `applied` / `failed` (502, Graph status + code in `error`) / `stale` (Entra no longer holds the value the proposal was built on). 409 before the due date, 409 `writes_disabled` unless `ENTRA_WRITE_ENABLED` = `true`, 409 on any other status. Audited BEFORE the Graph write |
| `POST /api/hub/entra/proposals/decide` body `{ "ids": [..], "action": "accept" \| "reject" }` | `Employees.Summary.Write` | `Entra.Admin` | Bulk accept (same rules as above, applied at once when possible) or reject; at most `ENTRA_MAX_DECIDE` ids; `results[]` with one `outcome` per id (`applied`, `accepted`, `due_later`, `writes_disabled`, `failed`, `stale`, `rejected`, `conflict`, `not_found`). One audit record per id |
| `POST` / `DELETE /api/hub/entra/groups/{gid}/members` body `{ "employeeIds": [..] }` | `Employees.Summary.Write` | `Entra.Admin` | Add / remove linked employees to a **managed** group now (Graph write per employee, recorded as `manual` proposals in status `applied`); unlinked employees and existing / non-members are skipped (`results[].outcome`). 409 `group_not_manageable` (not managed, dynamic or role-assignable), 409 `writes_disabled`, 404 unknown group. One audit record per employee written |
| `PUT /api/hub/entra/groups/{gid}/managed` body `{ "managed": true \| false }` | `Employees.Summary.Write` | `Entra.Admin` | Opt a group in (members fetched at the next sync; rules and manual members allowed) or out. Dynamic / role-assignable groups cannot be managed (409). Audited |
| `PUT /api/hub/entra/rules`, `PUT /api/hub/entra/rules/{id}` | `Employees.Summary.Write` | `Entra.Admin` | Create / replace a group rule: `{ groupId, name, jobCodes, districts, stores, companies, statuses (A,L,T; default A,L), mode (add_only \| add_and_remove), enabled, notes }`; csv tokens `^[A-Za-z0-9]{1,20}$`, arrays or comma-separated, stored upper-case; the group must be managed (409). Returns the rule. Audited |
| `DELETE /api/hub/entra/rules/{id}` | `Employees.Summary.Write` | `Entra.Admin` | Delete a rule; its open proposals become `stale`. Audited |
| `POST /api/hub/entra/links` body `{ "employeeId", "userObjectId" }` | `Employees.Summary.Write` | `Entra.Admin` | Manual link (replaces the employee's current link; the employee's open proposals become `stale`). 404 when the user is not in the snapshot, 409 `user_already_linked` when another employee holds the user. Audited |
| `DELETE /api/hub/entra/links/{employeeId}` | `Employees.Summary.Write` | `Entra.Admin` | Unlink (open proposals -> `stale`); 404 when not linked. Audited |

`{id}` = UKG system employee ID (e.g. `EWLTH200NRY0`), visible in UKG page URLs.

### Birthday fields on `/api/hub/roster/contacts`
Every employee in the response has `birthMonth` and `birthDay` (numbers or `null`):
- `birthMonth` 1-12; `birthDay` 1-31, valid for the month; Feb 29 allowed.
- Both filled, or both `null` (no date of birth in UKG, or `HUB_STORE_BIRTHDAY` = `false`).
- No year, full date of birth or age is stored, logged or returned.
- Refreshed nightly (~2:15 AM Toronto); new hires appear the following morning.
- Returned on every call (same role, scope and filters); the access audit records the field names, never values.

**Rules:** every request needs the app's scope AND the user's role. Admin roles include their Read role
(`Entra.Admin` includes `Summary.Read`; it is the only role that may change anything in Entra and is granted by `deploy/02-entra-admin-role.sh`).
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
| `entraSyncTimer` | Timer, 06:45 **UTC** daily (after the nightly) | Snapshots Entra users and groups, links them to employees and turns UKG differences into **proposals** (see [Entra sync](#entra-sync)). Does nothing unless `ENTRA_SYNC_ENABLED` = `true`. Also runs right after every succeeded / partial intraday sync when enabled. Never writes to Entra |
| `entraSyncRun` | `POST /api/hub/entra/sync` | Same run on demand; always allowed. Role `Entra.Admin` + scope `Employees.Summary.Write`, or app role `Integration.Run`; audited |

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
| `CLEARVIEW_AUTH_MODE` | `oauth` (self-service API connection, OAuth2 client credentials) or `key` (the partner model: `authorizationKey` query parameter, what Flexspring uses) | default `oauth` |
| `CLEARVIEW_TOKEN_URL`, `CLEARVIEW_SCOPE` | OAuth mode: the Access Token URL and Scope shown on the Clearview Connections page | from Clearview; scope optional |
| `CLEARVIEW_CLIENT_ID_SWN6T`, `CLEARVIEW_CLIENT_SECRET_SWN6T`, `CLEARVIEW_CLIENT_ID_SWNGK`, `CLEARVIEW_CLIENT_SECRET_SWNGK` | OAuth mode: client id and secret per UKG company (one Clearview organization each). Secrets expire after 24 months | secrets as Key Vault references. Unset, blank or an unresolved reference (`@Microsoft.KeyVault(` still literal) = missing: that company runs as shadow, nothing is sent |
| `CLEARVIEW_SECRET_EXPIRES_SWN6T`, `CLEARVIEW_SECRET_EXPIRES_SWNGK` | Optional, set by hand from the Clearview page: when each OAuth secret expires (ISO date). Diagnostics warns 60 days ahead and once past | e.g. `2028-11-02` |
| `CLEARVIEW_AUTH_KEY_SWN6T`, `CLEARVIEW_AUTH_KEY_SWNGK` | Key mode only: Clearview `authorizationKey` per UKG company | Key Vault references; same missing rule as above |
| `CLEARVIEW_ENABLED` | Timer + after-sync runs, **and the only switch that lets any code path call Clearview** (billing starts at the first call). Off: manual `/api/hub/clearview/run` still works but every store runs as shadow, `discover` answers 409, the diagnostics probe is skipped | `false` until a deliberate first `discover` |
| `CLEARVIEW_LIVE_ENABLED` | Kill switch: `false` = every store behaves as shadow, even stores set to `live` | `false` until the phase 5 pilot |
| `CLEARVIEW_COMPANIES` | UKG companies sent to Clearview | default `SWN6T,SWNGK` (`M9WOJ` events become `review`, any other company `skipped`) |
| `CLEARVIEW_EXCLUDED_JOBS` | UKG job codes never sent | default `MM` |
| `CLEARVIEW_TERMINATION_REASON_ID` | Clearview termination reason used unless `ref.destination_codes` maps the category | default `13078` (what Flexspring sends for every termination) |
| `CLEARVIEW_MAX_PER_RUN` | Deliveries claimed per run | default `200` |
| `CLEARVIEW_WAITING_ALERT_DAYS` | Days after a sent import before `[delivery] waiting` is logged for an employee Payroll has not added | default `5` |
| `CLEARVIEW_TIMEOUT_MS` | Clearview call timeout | default `20000` |
| `HUB_SHADOW_RETENTION_DAYS` | Days masked shadow payloads are kept in `out.shadow_payloads` | default `30` |
| `ENTRA_SYNC_ENABLED` | Timer + after-sync Entra runs (snapshot, link, compare: proposals only). Manual `POST /api/hub/entra/sync` always works | `false` until `deploy/01-entra-graph-permissions.sh` has run and scripts 18-20 are in place, then `true` |
| `ENTRA_WRITE_ENABLED` | Kill switch for **every** Graph write (apply, manual group members). Off: accept still records, apply and members answer 409 `writes_disabled` | `false` until the first proposals have been reviewed, then `true` |
| `ENTRA_ACCOUNT_DOMAINS` | Account domains whose Entra users are snapshotted and matched to work emails | default `qsrgroup.ca` |
| `ENTRA_GRAPH_BASE` | Microsoft Graph base URL | default `https://graph.microsoft.com/v1.0` |
| `ENTRA_HEAD_OFFICE_CITY` | `officeLocation` for head office staff (department `Head Office`) | unset = their `officeLocation` is left alone |
| `ENTRA_MAX_DECIDE` | Max ids per `proposals/decide` and per manual group member call | default `200` |
| `ALLOW_LOCAL_NO_AUTH`, `LOCAL_ROLES`, `LOCAL_SCOPES` | Local testing without sign-in | **never set in Azure** (ignored there anyway) |

## Audit log

Sensitive reads, SIN reveals, and writes (store mode, delivery retry / resolve, Clearview run / discover, every Entra action: sync, accept / reject / apply,
group members, managed flag, rules, links) are recorded in Table Storage `AccessAudit`:
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
| `16-connector-grants-and-columns.sql` | Clearview connector: grants to `mi-func-hrint` on `out.last_sent`, `out.shadow_payloads`, `xref.employees`, `ref.destination_codes`, `stage.sync_runs` and SELECT on the tables it reads; adds `out.deliveries.response_ref`, the `waiting` / `skipped` statuses, `ref.destination_codes.destination_id`, the `category` / `company` code types and the `company` column (primary key becomes destination, code_type, company, ukg_code). Run before the first connector run; the Diagnostics tab's grants check lists what is missing |
| `17-destination-codes-clearview.sql` | Re-runnable MERGE template for the job / termination / category / company pairs a person decides, one row per organization (`company` = `SWN6T` or `SWNGK`; empty = shared). Fill its VALUES block from the `discover` report (stores are paired automatically by `discover`, not here) |
| `18-ref-stores.sql` | `ref.stores`: store names, brands, districts, cities (filled from the store CSV) for the monitor directory and the Entra department / officeLocation |
| `19-directory-view.sql` | `rpt.v_directory`: one row per employee with store name and city, job title and **work email** (the only contact column; personal details stay out of reach of the monitor) |
| `20-entra-tables.sql` | Schema `entra`: `users`, `groups`, `group_members` (snapshot), `links`, `link_issues`, `rules`, `proposals`, `rejections`, `sync_runs`; grants the Function App user the schema plus SELECT on `ref.stores`, `rpt.v_directory` and `rpt.workforce_events`. Run after 18 and 19 and before the first Entra sync; the Diagnostics tab's entra row reports these objects and grants (skipped until they exist) |

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
request, stores a masked copy in `out.shadow_payloads` (DOB `****-**-**`, SIN `*********`, email `***@***`, pay `***`; Clearview ids it would look
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
employee's later ones until it is retried or resolved (`POST /api/hub/deliveries/{id}/resolve` closes a `dead` one too). A claim
also marks `superseded` any pending / failed / waiting row that a newer version of the same event has replaced (the event rebuild
does this for pending and failed, never for waiting). Transfers to a non-store (OPS, FIN …) and `M9WOJ` events become `review`.

**Per action.** `create` is an **import** (`POST /employee/import` into Clearview's staging area, Flexspring's proven minimum plus
`preferredFirstName` and `externalId` = UKG employee ID; Payroll adds the employee, no `xref` until then) when Clearview has no
record of the employee, and a **rehire** (`PUT /employeeStatus/{id}/rehire`) when it has (`xref` present), whatever the event type.
`terminate` sends `{terminationDate, terminationReasonId}` (reason 13078 unless the category is mapped). `store` adds the store
assignment, on a store transfer ends only the open assignment of the store the employee left (`from_store`; other open assignments
stay, a missing one is a warning) the day before, and tries to patch the reporting store (unverified, warning only if refused).
`job` promotes the target job (or adds it at the current primary rate and pay type, `salaryHours` 40 when salaried) and demotes
the old primary. `pay` posts
the flat v2 body `{effectiveDate, payTypeCode, payRate, salaryHours}` on the primary job. `update` patches `empCatCode`.

**Mapping discovery.** Codes live in `ref.destination_codes` (`destination_code` = what Clearview calls it, `destination_id` = its
internal id, `company` = the UKG company whose Clearview organization the row belongs to, empty = shared). Job codes, job ids and
termination reason ids differ per organization, so those rows are per company; stores and the company rows are shared. The mapper
looks up the employee's company first, then the shared row. `POST /api/hub/clearview/discover` reads every organization and pairs stores automatically on **`tdlNumber`**: the hub
store code's digits (`T22446` → `22446`) equal the TDL number without its leading 1 (`122446`); the UKG code is never turned into
a Clearview number by rule, because UKG could not hold six digits. Paired stores and the `company` → `organizationId` rows are
written; jobs (`jobCode`, org `jobId`, name) and termination reasons are listed for a person to pair in `provisioning/17`; unpaired
hub and Clearview stores and mappings Clearview no longer knows are reported. `?what=employees` seeds `xref.employees` from
Clearview's employee list by employee number + last name (Flexspring never set `externalId`). The Diagnostics tab's
`destinations[0]` shows enabled / live / credentials, a timed `GET /organization/stores` (skipped without keys), the queue counts
and how many codes of each type are mapped.

**Authentication: two organizations, one credential each.** Clearview holds two organizations (store 2462: organizationId 18,
employerCode O01189; store 6105: organizationId 1690, employerCode STIS). Self-service "API Connections" (Clearview Admin →
Connections) issue **OAuth2 client credentials** per organization: an OAuth Client ID, a Scope, the API base URL, an Access Token
URL and OAuth Secrets that expire after 24 months. That is `CLEARVIEW_AUTH_MODE = oauth` (default): the client fetches a bearer
token per organization with the client-credentials grant, caches it until expiry minus 60 s, refreshes it once on a 401 and then
fails. The `authorizationKey` query parameter in the v2 spec is the *partner* model Flexspring uses; `CLEARVIEW_AUTH_MODE = key`
keeps it available. The client picks the organization's credential from the employee's company at send time; which company is
which organization is confirmed by `discover` (the company row's notes carry the employer code).

**Billing.** Every Clearview API connection costs USD per active store per month from its **first API call** after activation
(no partial months), per organization. So nothing in hrint-api calls Clearview unless `CLEARVIEW_ENABLED` is `true`: the client
is built without credentials (every run is shadow), `discover` answers 409 and the diagnostics probe reports
`skipped: connector disabled; first call starts billing`. The first call should be a deliberate `discover`; the client logs
`[clearview] first call this process org=<company>` once per organization per process and nothing else.

**Three self-service products**, each a separate subscription per organization (the two write products are mandatory; the read
product is what the connector uses for existing employees and ID resolution):

| Product | Fee (per active store / month) | Endpoints the connector uses |
|---|---|---|
| Post New Hires to CLEARVIEW | USD 3 | `POST /employee/import`, `GET /employee/import/{n}/status`, `GET /organization/stores`, `GET /store/{id}`, `GET /job`, `GET /organization/filecontrol` (the import and all of discovery) |
| Post Updates to Existing Employees | USD 3 | `PATCH /employee/{id}`, `POST /employeeStatus/{id}/terminate`, `PUT …/terminate`, `POST /employeeStoreAssignment/{id}`, `PUT …/assignment/{aid}`, `POST /employeeJob/{id}/job`, `PUT …/job/{jobId}`, `POST …/pay`, `PUT …/pay/{payId}`. **`PUT /employeeStatus/{id}/rehire` is in neither guide: confirm it is covered by Post Updates** (rehire stays implemented) |
| Get Employees from CLEARVIEW | USD 5 | `GET /employee/externalId/…`, `GET /employee/employeeNumber/…`, `GET /employee/{id}`, `GET /organization/employees` (xref seeding and ID resolution), `GET /employeeJob/{id}` (current primary job and rate before job / pay changes), `GET /employeeStoreAssignment/{id}` (assignment to end on a transfer), `GET /terminationReason` |

Every read in the third row goes through one seam, `ClearviewReads` in `src/shared/clearview/connector.ts` (`ClearviewApiReads`
over the API today), so the read product can be dropped later by tracking `jobId` / `assignmentId` in `xref` ourselves and
replacing that one class; the write calls and the New Hires lookups stay as they are.

**To confirm in UAT before live** (the shadow build makes none of these a blocker):
1. The import flow: does `externalId` survive Import → Payroll adding the employee, and is our employee number kept as
   `employeeNumber`? (Decides how created ids resolve; the fallback is employee number + last name.) The rehire body uses
   `jobs[{jobId, payTypeCode, payRate, primaryJob, salaryHours}]` and `storeAssignments[{storeId, employeeNameOnRegister,
   employeeIdOnRegister}]` as Clearview documents; confirm with one UAT rehire.
2. Reporting store on a transfer: is `reportingStoreId` patchable? The connector tries `PATCH /employee/{id}` and records a warning
   on the delivery if Clearview refuses it.
3. Required attributes and category codes: `filecontrol?requiredAttributesOnly=true` per organization (listed by `discover`),
   `employeeCategoryCode` for F / P (the `category` code type is reserved and not sent yet), one UAT pay call to confirm the flat
   `yyyy-MM-dd` body fixes Flexspring's 400.

Tests: `test/clearview-mapper.test.js` (fixtures in `test/fixtures/clearview/`, one per operation), `test/delivery.test.js`,
`test/clearview-connector.test.js`, `test/clearview-function.test.js`; mocks only.

## Entra sync

Keeps Entra ID in step with UKG for everyone with a `qsrgroup.ca` work email, **without pushing anything automatically**: the sync
(`src/shared/entra/`: `snapshot`, `link`, pure `compare`, `apply`, `store`, `sync`, `runner`; `src/shared/graph.ts`; `src/functions/entraSync.ts`,
`entraAdmin.ts`) only writes *proposals* to the hub database; an `Entra.Admin` accepts, rejects or applies them from the monitor, and every
Graph write happens through this Function App's managed identity, audited before it runs, and only while `ENTRA_WRITE_ENABLED` = `true`.

**Each run** (06:45 UTC timer, after each successful intraday sync, or `POST /api/hub/entra/sync`; locked through `entra.sync_runs` for 30 min):
1. **Snapshot**: Graph `GET /users` per `ENTRA_ACCOUNT_DOMAINS` (`endsWith` filter on UPN and mail, `ConsistencyLevel: eventual`, guests dropped) ->
   `entra.users` (users that drop out of the listing get `missing_since_utc`); `GET /groups` -> `entra.groups`; members of **managed** groups only ->
   `entra.group_members`. `onPremisesSyncEnabled` is snapshotted even though accounts are cloud-only: such users get `blocked` proposals.
2. **Link**: `lower(work_email)` from `rpt.v_directory` = `lower(upn)` or `lower(mail)` -> `entra.links` (`matched_email`). Links persist: the hub
   purges work emails at termination, so the link is the only key afterwards. Manual links (`POST /api/hub/entra/links`) always win. Problems go to
   `entra.link_issues`, rebuilt each run: `duplicate_email` (two employees one email, one email two users, or the user already linked elsewhere),
   `email_not_in_entra`, `email_changed` (linked account no longer carries the work email: relink), `user_missing`, `user_without_employee` (orphans).
3. **Compare** (pure, `compare.ts`): desired = `jobTitle` from `ref.job_codes`, `department` = store name from `ref.stores` or `Head Office`,
   `officeLocation` = store city (head office: `ENTRA_HEAD_OFFICE_CITY`, or left alone), `accountEnabled` = status A / L. Differences become
   proposals: `attribute` per field (active / on-leave staff only), `disable` for a termination with `due_date` = `date_last_worked` (else
   `termination_date`), `enable` for a rehire, `group_add` / `group_remove` from `entra.rules` (managed, non-dynamic, non-role-assignable groups;
   `add_only` never removes; predicates job codes / districts / stores / companies / statuses are csv, NULL = any, all must match). The latest
   `rpt.workforce_events` row is attached as `event_id` for context (refreshed every run; it is not a stable key). Open proposals are keyed by
   `dedupe_hash` = sha256(employee | kind | field | group | value) (filtered unique index), so a repeat run refreshes `last_seen_utc` instead of
   duplicating; a difference that disappeared stales the open row; a `rejected` hash is suppressed until the difference disappears, then the rejection
   is deleted so a later recurrence is proposed again.

**Statuses**: `proposed` -> `accepted` -> `applying` -> `applied` | `failed` | `stale`; `rejected`; `blocked` (on-prem synced account). A termination
proposal stays `accepted` until its due date (Toronto); the monitor shows it as due from that day and an admin applies it (never the timer).
Apply claims the row with a status-guarded `UPDATE ... OUTPUT` (two admins: the loser gets 409), re-reads the user from Graph, gives up as `stale`
when Entra no longer holds `current_value`, then writes one field (`PATCH /users/{id}`), `{accountEnabled}`, `POST /groups/{id}/members/$ref` (already a
member = no-op) or `DELETE .../members/{uid}/$ref` (404 = no-op) and refreshes the snapshot row. Graph errors (`Graph 403: Authorization_RequestDenied`
for a user holding a directory role, say) end as `failed` with status + code only; there is no retry loop.

**Graph access**: application permissions on the Function App's system-assigned identity, granted all at once by `deploy/01-entra-graph-permissions.sh`
(`User.Read.All`, `GroupMember.Read.All`, `User.ReadWrite.All`, `User.EnableDisableAccount.All`, `GroupMember.ReadWrite.All`; nothing wider). The client
(`graph.ts`, no SDK) caches the token until expiry minus 60 s, times out after 20 s, retries 429 / 503 / 504 honouring `Retry-After` (max 3), follows
`@odata.nextLink`; its errors carry the HTTP status and Graph `error.code` only, never a body, a token or a query string. `deploy/02-entra-admin-role.sh`
adds the `Entra.Admin` app role to the hrint-api registration (existing roles kept) and assigns it to `ENTRA_ADMINS`.

**Order of operations**: scripts 18 (with the store CSV), 19, 20 on `sqldb-hrint` -> `01-entra-graph-permissions.sh` -> `ENTRA_SYNC_ENABLED=true` ->
`POST /api/hub/entra/sync` and check the `entra` row of `GET /api/hub/diagnostics` (token + `GET /users?$top=1` probe, its own objects + grants check, last run age, counts: users,
linked, unlinked with email, orphans, proposed, due, failed, blocked) -> `02-entra-admin-role.sh` -> review proposals -> `ENTRA_WRITE_ENABLED=true`.

Tests: `test/compare.test.js`, `test/link.test.js`, `test/graph.test.js` (stubbed fetch), `test/entraSync.test.js`, `test/entraAdmin.test.js`; mocks only.

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
