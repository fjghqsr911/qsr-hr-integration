IF SCHEMA_ID('out') IS NULL  EXEC('CREATE SCHEMA [out]');
IF SCHEMA_ID('xref') IS NULL EXEC('CREATE SCHEMA xref');

IF OBJECT_ID('ref.destination_events', 'U') IS NULL
    CREATE TABLE ref.destination_events (
        destination  varchar(20) NOT NULL CONSTRAINT ck_destination_events_dest CHECK (destination IN ('clearview', 'rosnet')),
        event_type   varchar(40) NOT NULL,
        action       varchar(30) NOT NULL,
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
        store        varchar(20)   NOT NULL,
        mode         varchar(10)   NOT NULL CONSTRAINT ck_store_modes_mode CHECK (mode IN ('off', 'shadow', 'live')),
        changed_utc  datetime2(0)  NOT NULL CONSTRAINT df_store_modes_changed DEFAULT SYSUTCDATETIME(),
        changed_by   nvarchar(200) NULL,
        CONSTRAINT pk_store_modes PRIMARY KEY (destination, store));

IF OBJECT_ID('out.deliveries', 'U') IS NULL
    CREATE TABLE [out].deliveries (
        delivery_id      bigint IDENTITY(1,1) NOT NULL CONSTRAINT pk_deliveries PRIMARY KEY,
        destination      varchar(20)   NOT NULL,
        event_key        binary(32)    NOT NULL,
        version          int           NOT NULL,
        kind             varchar(10)   NOT NULL CONSTRAINT ck_deliveries_kind CHECK (kind IN ('event', 'removed')),
        employee_id      varchar(20)   NOT NULL,
        event_type       varchar(40)   NOT NULL,
        action           varchar(30)   NULL,
        effective_date   date          NOT NULL,
        store            varchar(20)   NULL,
        status           varchar(20)   NOT NULL CONSTRAINT df_deliveries_status DEFAULT 'pending'
                         CONSTRAINT ck_deliveries_status CHECK (status IN
                           ('pending', 'sent', 'unchanged', 'shadow', 'failed', 'dead', 'superseded', 'review', 'resolved')),
        attempts         int           NOT NULL CONSTRAINT df_deliveries_attempts DEFAULT 0,
        next_attempt_utc datetime2(0)  NULL,
        queued_utc       datetime2(0)  NOT NULL CONSTRAINT df_deliveries_queued DEFAULT SYSUTCDATETIME(),
        finished_utc     datetime2(0)  NULL,
        mode_at_send     varchar(10)   NULL,
        payload_hash     binary(32)    NULL,
        last_error       nvarchar(300) NULL,
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
        operation     varchar(30)  NOT NULL,
        payload_hash  binary(32)   NOT NULL,
        sent_utc      datetime2(0) NOT NULL,
        CONSTRAINT pk_last_sent PRIMARY KEY (destination, employee_id, operation));

IF OBJECT_ID('out.shadow_payloads', 'U') IS NULL
    CREATE TABLE [out].shadow_payloads (
        delivery_id   bigint        NOT NULL CONSTRAINT pk_shadow_payloads PRIMARY KEY
                      CONSTRAINT fk_shadow_payloads_delivery REFERENCES [out].deliveries (delivery_id) ON DELETE CASCADE,
        payload       nvarchar(max) NOT NULL,
        built_utc     datetime2(0)  NOT NULL CONSTRAINT df_shadow_payloads_built DEFAULT SYSUTCDATETIME());

IF OBJECT_ID('xref.employees', 'U') IS NULL
    CREATE TABLE xref.employees (
        destination  varchar(20)  NOT NULL CONSTRAINT ck_xref_employees_dest CHECK (destination IN ('clearview', 'rosnet')),
        employee_id  varchar(20)  NOT NULL,
        external_id  nvarchar(64) NOT NULL,
        payroll_id   varchar(20)  NULL,
        pos_id       varchar(40)  NULL,
        source       varchar(20)  NOT NULL CONSTRAINT ck_xref_employees_source CHECK (source IN ('extract', 'created', 'matched')),
        created_utc  datetime2(0) NOT NULL CONSTRAINT df_xref_employees_created DEFAULT SYSUTCDATETIME(),
        updated_utc  datetime2(0) NOT NULL CONSTRAINT df_xref_employees_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT pk_xref_employees PRIMARY KEY (destination, employee_id),
        CONSTRAINT ux_xref_employees_external UNIQUE (destination, external_id));

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

SELECT (SELECT COUNT(*) FROM sys.tables t WHERE SCHEMA_NAME(t.schema_id) + '.' + t.name IN
          ('ref.destination_events', 'ref.destination_codes', 'ref.store_modes', 'out.deliveries', 'out.last_sent',
           'out.shadow_payloads', 'xref.employees'))                                        AS tables_present,
       (SELECT COUNT(*) FROM ref.destination_events)                                        AS destination_events,
       (SELECT COUNT(*) FROM ref.store_modes WHERE mode <> 'off')                           AS stores_switched_on;
