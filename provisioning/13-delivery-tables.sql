/*
  13-delivery-tables.sql - delivery queue, crosswalk, destination mappings and store modes (plan: Delivery design).
  Run in the Azure portal Query editor on sqldb-hrint BEFORE the updated 11-usp-rebuild-events.sql. Safe to re-run:
  tables are created only if missing, and seed rows are added only if missing (your edits are kept).

  Nothing is queued until a store is switched to shadow or live in ref.store_modes (no row = off).
  No payloads, DOB, SIN or pay are stored, except masked shadow payloads (out.shadow_payloads, kept 30 days).
  Statements that must start a batch go through EXEC (the Query editor does not support GO).
*/
IF SCHEMA_ID('out') IS NULL  EXEC('CREATE SCHEMA [out]');
IF SCHEMA_ID('xref') IS NULL EXEC('CREATE SCHEMA xref');

/* ref: what each destination takes, what it calls things, and which stores are on */
IF OBJECT_ID('ref.destination_events', 'U') IS NULL
    CREATE TABLE ref.destination_events (
        destination  varchar(20) NOT NULL CONSTRAINT ck_destination_events_dest CHECK (destination IN ('clearview', 'rosnet')),
        event_type   varchar(40) NOT NULL,                  /* rpt.workforce_events.event_type */
        action       varchar(30) NOT NULL,                  /* what the connector does: create, terminate, store, job, pay, update */
        CONSTRAINT pk_destination_events PRIMARY KEY (destination, event_type));

IF OBJECT_ID('ref.destination_codes', 'U') IS NULL
    CREATE TABLE ref.destination_codes (
        destination      varchar(20)  NOT NULL CONSTRAINT ck_destination_codes_dest CHECK (destination IN ('clearview', 'rosnet')),
        code_type        varchar(20)  NOT NULL CONSTRAINT ck_destination_codes_type CHECK (code_type IN ('job', 'store', 'termination')),
        ukg_code         varchar(20)  NOT NULL,
        destination_code nvarchar(50) NOT NULL,
        notes            nvarchar(200) NULL,
        updated_utc      datetime2(0) NOT NULL CONSTRAINT df_destination_codes_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT pk_destination_codes PRIMARY KEY (destination, code_type, ukg_code));

IF OBJECT_ID('ref.store_modes', 'U') IS NULL
    CREATE TABLE ref.store_modes (
        destination  varchar(20)   NOT NULL CONSTRAINT ck_store_modes_dest CHECK (destination IN ('clearview', 'rosnet')),
        store        varchar(20)   NOT NULL,                /* UKG store code (org level 2), e.g. T00037 */
        mode         varchar(10)   NOT NULL CONSTRAINT ck_store_modes_mode CHECK (mode IN ('off', 'shadow', 'live')),
        changed_utc  datetime2(0)  NOT NULL CONSTRAINT df_store_modes_changed DEFAULT SYSUTCDATETIME(),
        changed_by   nvarchar(200) NULL,
        CONSTRAINT pk_store_modes PRIMARY KEY (destination, store));

/* out: the queue, the no-change check, masked shadow payloads */
IF OBJECT_ID('out.deliveries', 'U') IS NULL
    CREATE TABLE [out].deliveries (
        delivery_id      bigint IDENTITY(1,1) NOT NULL CONSTRAINT pk_deliveries PRIMARY KEY,
        destination      varchar(20)   NOT NULL,
        event_key        binary(32)    NOT NULL,            /* rpt.workforce_events.event_key */
        version          int           NOT NULL,            /* 1, then +1 each time the event changes in a way that matters */
        kind             varchar(10)   NOT NULL CONSTRAINT ck_deliveries_kind CHECK (kind IN ('event', 'removed')),
        employee_id      varchar(20)   NOT NULL,
        event_type       varchar(40)   NOT NULL,
        action           varchar(30)   NULL,
        effective_date   date          NOT NULL,
        store            varchar(20)   NULL,                /* the shadow / live store that queued it */
        status           varchar(20)   NOT NULL CONSTRAINT df_deliveries_status DEFAULT 'pending'
                         CONSTRAINT ck_deliveries_status CHECK (status IN
                           ('pending', 'sent', 'unchanged', 'shadow', 'failed', 'dead', 'superseded', 'review', 'resolved')),
        attempts         int           NOT NULL CONSTRAINT df_deliveries_attempts DEFAULT 0,
        next_attempt_utc datetime2(0)  NULL,
        queued_utc       datetime2(0)  NOT NULL CONSTRAINT df_deliveries_queued DEFAULT SYSUTCDATETIME(),
        finished_utc     datetime2(0)  NULL,
        mode_at_send     varchar(10)   NULL,
        payload_hash     binary(32)    NULL,
        last_error       nvarchar(300) NULL,                /* sanitised: no personal data */
        CONSTRAINT ux_deliveries_version UNIQUE (destination, event_key, version));

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('out.deliveries') AND name = 'ix_deliveries_work')
    CREATE INDEX ix_deliveries_work ON [out].deliveries (destination, status, next_attempt_utc)
        INCLUDE (employee_id, effective_date);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('out.deliveries') AND name = 'ix_deliveries_employee')
    CREATE INDEX ix_deliveries_employee ON [out].deliveries (destination, employee_id, effective_date, delivery_id);

IF OBJECT_ID('out.last_sent', 'U') IS NULL
    CREATE TABLE [out].last_sent (
        destination   varchar(20)  NOT NULL,
        employee_id   varchar(20)  NOT NULL,
        operation     varchar(30)  NOT NULL,                /* e.g. employee, job, pay, status */
        payload_hash  binary(32)   NOT NULL,
        sent_utc      datetime2(0) NOT NULL,
        CONSTRAINT pk_last_sent PRIMARY KEY (destination, employee_id, operation));

/* Shadow payloads with DOB, SIN and pay masked, for comparison with Flexspring. The connector deletes rows after 30 days. */
IF OBJECT_ID('out.shadow_payloads', 'U') IS NULL
    CREATE TABLE [out].shadow_payloads (
        delivery_id   bigint        NOT NULL CONSTRAINT pk_shadow_payloads PRIMARY KEY
                      CONSTRAINT fk_shadow_payloads_delivery REFERENCES [out].deliveries (delivery_id) ON DELETE CASCADE,
        payload       nvarchar(max) NOT NULL,
        built_utc     datetime2(0)  NOT NULL CONSTRAINT df_shadow_payloads_built DEFAULT SYSUTCDATETIME());

/* xref: who each employee is at each destination. Keyed on the UKG employee ID; never purged. */
IF OBJECT_ID('xref.employees', 'U') IS NULL
    CREATE TABLE xref.employees (
        destination  varchar(20)  NOT NULL CONSTRAINT ck_xref_employees_dest CHECK (destination IN ('clearview', 'rosnet')),
        employee_id  varchar(20)  NOT NULL,                 /* UKG employee ID (never the employee number) */
        external_id  nvarchar(64) NOT NULL,                 /* Clearview employee ID / Rosnet GUID */
        payroll_id   varchar(20)  NULL,                     /* Rosnet Payroll ID */
        pos_id       varchar(40)  NULL,                     /* Rosnet / Aloha POS ID */
        source       varchar(20)  NOT NULL CONSTRAINT ck_xref_employees_source CHECK (source IN ('extract', 'created', 'matched')),
        created_utc  datetime2(0) NOT NULL CONSTRAINT df_xref_employees_created DEFAULT SYSUTCDATETIME(),
        updated_utc  datetime2(0) NOT NULL CONSTRAINT df_xref_employees_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT pk_xref_employees PRIMARY KEY (destination, employee_id),
        CONSTRAINT ux_xref_employees_external UNIQUE (destination, external_id));

/* seed: which events each destination takes (plan: Delivery design). Added only if missing.
   Not seeded (open decisions): leave of absence / return; Rosnet pay; Rosnet Additional company / Company record ended. */
INSERT INTO ref.destination_events (destination, event_type, action)
SELECT s.destination, s.event_type, s.action
FROM (VALUES
    ('clearview', 'New hire', 'create'),        ('clearview', 'Rehire', 'create'),
    ('clearview', 'Cross-company transfer in', 'create'),
    ('clearview', 'Termination', 'terminate'),  ('clearview', 'Hired but never worked', 'terminate'),
    ('clearview', 'Administrative termination', 'terminate'),
    ('clearview', 'Store transfer', 'store'),   ('clearview', 'Temporary transfer', 'store'),
    ('clearview', 'Promotion', 'job'),          ('clearview', 'Demotion', 'job'),         ('clearview', 'Job change', 'job'),
    ('clearview', 'Pay change', 'pay'),
    ('clearview', 'Part-time to full-time', 'update'), ('clearview', 'Full-time to part-time', 'update'),
    ('rosnet', 'New hire', 'create'),           ('rosnet', 'Rehire', 'create'),
    ('rosnet', 'Cross-company transfer in', 'create'),
    ('rosnet', 'Termination', 'terminate'),     ('rosnet', 'Hired but never worked', 'terminate'),
    ('rosnet', 'Administrative termination', 'terminate'),
    ('rosnet', 'Store transfer', 'store'),      ('rosnet', 'Temporary transfer', 'store'),
    ('rosnet', 'Promotion', 'job'),             ('rosnet', 'Demotion', 'job'),            ('rosnet', 'Job change', 'job')
) s (destination, event_type, action)
WHERE NOT EXISTS (SELECT 1 FROM ref.destination_events d WHERE d.destination = s.destination AND d.event_type = s.event_type);

/* check */
SELECT (SELECT COUNT(*) FROM sys.tables t WHERE SCHEMA_NAME(t.schema_id) + '.' + t.name IN
          ('ref.destination_events', 'ref.destination_codes', 'ref.store_modes', 'out.deliveries', 'out.last_sent',
           'out.shadow_payloads', 'xref.employees'))                                        AS tables_present,   /* expect 7 */
       (SELECT COUNT(*) FROM ref.destination_events)                                        AS destination_events, /* expect 25 */
       (SELECT COUNT(*) FROM ref.store_modes WHERE mode <> 'off')                           AS stores_switched_on; /* expect 0 */
