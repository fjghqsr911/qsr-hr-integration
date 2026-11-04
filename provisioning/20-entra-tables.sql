-- 20-entra-tables.sql: schema entra for the Entra ID sync (snapshot of users and groups, employee to user links,
-- proposed changes an admin accepts or rejects, group rules, sync run lock). Nothing here is pushed to Entra by itself:
-- the sync only writes proposals; hrint-api applies an accepted proposal when an admin asks.
-- Requires 18-ref-stores.sql and 19-directory-view.sql for the grants at the end (skipped when they do not exist yet).
-- Run in the Azure portal Query editor on sqldb-hrint (open from the database, not master) as the Entra admin.
-- Safe to re-run. Comments contain no apostrophes and no dashes other than the comment marker.

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'entra')
    EXEC('CREATE SCHEMA entra AUTHORIZATION dbo');
GO

-- ---- snapshot of the Entra users in the account domains (guests dropped) ----
IF OBJECT_ID('entra.users', 'U') IS NULL
BEGIN
    CREATE TABLE entra.users (
        object_id          varchar(36)   NOT NULL CONSTRAINT pk_entra_users PRIMARY KEY,
        upn                nvarchar(254) NULL,
        mail               nvarchar(254) NULL,
        display_name       nvarchar(256) NULL,
        job_title          nvarchar(128) NULL,
        department         nvarchar(128) NULL,
        office_location    nvarchar(128) NULL,
        account_enabled    bit           NOT NULL CONSTRAINT df_entra_users_enabled DEFAULT 1,
        employee_id_attr   nvarchar(64)  NULL,
        user_type          varchar(20)   NULL,
        onprem_synced      bit           NOT NULL CONSTRAINT df_entra_users_onprem DEFAULT 0,
        fetched_utc        datetime2(0)  NOT NULL,
        missing_since_utc  datetime2(0)  NULL
    );
    CREATE INDEX ix_entra_users_upn  ON entra.users (upn);
    CREATE INDEX ix_entra_users_mail ON entra.users (mail);
END;

-- ---- snapshot of the Entra groups; only managed groups get members fetched and may be targeted ----
IF OBJECT_ID('entra.groups', 'U') IS NULL
BEGIN
    CREATE TABLE entra.groups (
        object_id            varchar(36)   NOT NULL CONSTRAINT pk_entra_groups PRIMARY KEY,
        display_name         nvarchar(256) NULL,
        description          nvarchar(1024) NULL,
        group_types          nvarchar(200) NULL,
        security_enabled     bit           NOT NULL CONSTRAINT df_entra_groups_security DEFAULT 0,
        mail_enabled         bit           NOT NULL CONSTRAINT df_entra_groups_mail DEFAULT 0,
        role_assignable      bit           NOT NULL CONSTRAINT df_entra_groups_role DEFAULT 0,
        managed              bit           NOT NULL CONSTRAINT df_entra_groups_managed DEFAULT 0,
        member_count         int           NULL,
        fetched_utc          datetime2(0)  NOT NULL,
        members_fetched_utc  datetime2(0)  NULL
    );
END;

IF OBJECT_ID('entra.group_members', 'U') IS NULL
BEGIN
    CREATE TABLE entra.group_members (
        group_id     varchar(36)  NOT NULL,
        user_id      varchar(36)  NOT NULL,
        fetched_utc  datetime2(0) NOT NULL,
        CONSTRAINT pk_entra_group_members PRIMARY KEY (group_id, user_id)
    );
    CREATE INDEX ix_entra_group_members_user ON entra.group_members (user_id);
END;

-- ---- employee to Entra user link: persisted, because the work email is purged from the hub at termination ----
IF OBJECT_ID('entra.links', 'U') IS NULL
BEGIN
    CREATE TABLE entra.links (
        employee_id     varchar(20)   NOT NULL CONSTRAINT pk_entra_links PRIMARY KEY,
        user_object_id  varchar(36)   NOT NULL,
        method          varchar(20)   NOT NULL,
        matched_email   nvarchar(254) NULL,
        linked_utc      datetime2(0)  NOT NULL CONSTRAINT df_entra_links_linked DEFAULT SYSUTCDATETIME(),
        linked_by       nvarchar(200) NULL,
        CONSTRAINT ck_entra_links_method CHECK (method IN ('matched_email', 'manual'))
    );
    CREATE UNIQUE INDEX ux_entra_links_user ON entra.links (user_object_id);
END;

-- ---- link problems, rebuilt by every sync ----
IF OBJECT_ID('entra.link_issues', 'U') IS NULL
BEGIN
    CREATE TABLE entra.link_issues (
        issue_id        bigint IDENTITY(1,1) NOT NULL CONSTRAINT pk_entra_link_issues PRIMARY KEY,
        employee_id     varchar(20)   NULL,
        user_object_id  varchar(36)   NULL,
        kind            varchar(30)   NOT NULL,
        detail          nvarchar(300) NULL,
        seen_utc        datetime2(0)  NOT NULL CONSTRAINT df_entra_link_issues_seen DEFAULT SYSUTCDATETIME(),
        CONSTRAINT ck_entra_link_issues_kind CHECK (kind IN ('duplicate_email', 'email_not_in_entra', 'user_without_employee', 'email_changed', 'user_missing'))
    );
    CREATE INDEX ix_entra_link_issues_employee ON entra.link_issues (employee_id);
    CREATE INDEX ix_entra_link_issues_user ON entra.link_issues (user_object_id);
END;

-- ---- group rules: which employees should be in a managed group; NULL predicate = any ----
IF OBJECT_ID('entra.rules', 'U') IS NULL
BEGIN
    CREATE TABLE entra.rules (
        rule_id      int IDENTITY(1,1) NOT NULL CONSTRAINT pk_entra_rules PRIMARY KEY,
        group_id     varchar(36)   NOT NULL,
        name         nvarchar(100) NOT NULL,
        job_codes    nvarchar(400) NULL,
        districts    nvarchar(400) NULL,
        stores       nvarchar(1000) NULL,
        companies    nvarchar(200) NULL,
        statuses     varchar(20)   NOT NULL CONSTRAINT df_entra_rules_statuses DEFAULT 'A,L',
        mode         varchar(20)   NOT NULL CONSTRAINT df_entra_rules_mode DEFAULT 'add_only',
        enabled      bit           NOT NULL CONSTRAINT df_entra_rules_enabled DEFAULT 1,
        notes        nvarchar(300) NULL,
        updated_utc  datetime2(0)  NOT NULL CONSTRAINT df_entra_rules_updated DEFAULT SYSUTCDATETIME(),
        updated_by   nvarchar(200) NULL,
        CONSTRAINT ck_entra_rules_mode CHECK (mode IN ('add_only', 'add_and_remove'))
    );
    CREATE INDEX ix_entra_rules_group ON entra.rules (group_id);
END;

-- ---- proposed Entra changes (the queue the admin works) ----
IF OBJECT_ID('entra.proposals', 'U') IS NULL
BEGIN
    CREATE TABLE entra.proposals (
        proposal_id     bigint IDENTITY(1,1) NOT NULL CONSTRAINT pk_entra_proposals PRIMARY KEY,
        employee_id     varchar(20)   NOT NULL,
        user_object_id  varchar(36)   NOT NULL,
        kind            varchar(20)   NOT NULL,
        field           varchar(20)   NULL,
        group_id        varchar(36)   NULL,
        current_value   nvarchar(256) NULL,
        proposed_value  nvarchar(256) NULL,
        due_date        date          NULL,
        source          varchar(20)   NOT NULL CONSTRAINT df_entra_proposals_source DEFAULT 'compare',
        event_id        bigint        NULL,
        rule_id         int           NULL,
        status          varchar(20)   NOT NULL CONSTRAINT df_entra_proposals_status DEFAULT 'proposed',
        dedupe_hash     binary(32)    NOT NULL,
        proposed_utc    datetime2(0)  NOT NULL CONSTRAINT df_entra_proposals_proposed DEFAULT SYSUTCDATETIME(),
        last_seen_utc   datetime2(0)  NOT NULL CONSTRAINT df_entra_proposals_seen DEFAULT SYSUTCDATETIME(),
        decided_by      nvarchar(200) NULL,
        decided_utc     datetime2(0)  NULL,
        applied_utc     datetime2(0)  NULL,
        error           nvarchar(300) NULL,
        CONSTRAINT ck_entra_proposals_kind CHECK (kind IN ('attribute', 'group_add', 'group_remove', 'disable', 'enable')),
        CONSTRAINT ck_entra_proposals_field CHECK (field IS NULL OR field IN ('jobTitle', 'department', 'officeLocation')),
        CONSTRAINT ck_entra_proposals_source CHECK (source IN ('compare', 'rule', 'manual')),
        CONSTRAINT ck_entra_proposals_status CHECK (status IN ('proposed', 'accepted', 'applying', 'applied', 'rejected', 'stale', 'failed', 'blocked'))
    );
    CREATE UNIQUE INDEX ux_entra_proposals_open ON entra.proposals (dedupe_hash)
        WHERE status IN ('proposed', 'accepted', 'applying', 'blocked');
    CREATE INDEX ix_entra_proposals_queue ON entra.proposals (status, due_date, proposed_utc);
    CREATE INDEX ix_entra_proposals_employee ON entra.proposals (employee_id);
END;

-- ---- rejected changes are not proposed again until the difference disappears ----
IF OBJECT_ID('entra.rejections', 'U') IS NULL
BEGIN
    CREATE TABLE entra.rejections (
        dedupe_hash   binary(32)    NOT NULL CONSTRAINT pk_entra_rejections PRIMARY KEY,
        proposal_id   bigint        NOT NULL,
        rejected_by   nvarchar(200) NULL,
        rejected_utc  datetime2(0)  NOT NULL CONSTRAINT df_entra_rejections_utc DEFAULT SYSUTCDATETIME()
    );
END;

-- ---- sync runs (also the 30 minute running lock) ----
IF OBJECT_ID('entra.sync_runs', 'U') IS NULL
BEGIN
    CREATE TABLE entra.sync_runs (
        run_id           uniqueidentifier NOT NULL CONSTRAINT pk_entra_sync_runs PRIMARY KEY,
        started_utc      datetime2(0)  NOT NULL CONSTRAINT df_entra_sync_runs_started DEFAULT SYSUTCDATETIME(),
        finished_utc     datetime2(0)  NULL,
        status           varchar(20)   NOT NULL,
        trigger_kind     varchar(20)   NOT NULL,
        users_fetched    int           NULL,
        groups_fetched   int           NULL,
        linked           int           NULL,
        proposals_new    int           NULL,
        proposals_stale  int           NULL,
        error_summary    nvarchar(1000) NULL,
        CONSTRAINT ck_entra_sync_runs_trigger CHECK (trigger_kind IN ('timer', 'after-sync', 'manual'))
    );
    CREATE INDEX ix_entra_sync_runs_started ON entra.sync_runs (started_utc DESC);
END;

-- ---- grants to the Function App user ----
DECLARE @app sysname = N'mi-func-hrint';
DECLARE @sql nvarchar(max);
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @app)
BEGIN
    SET @sql = N'GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::entra TO ' + QUOTENAME(@app) + N';';
    IF OBJECT_ID('ref.stores', 'U') IS NOT NULL
        SET @sql = @sql + N'GRANT SELECT ON OBJECT::ref.stores TO ' + QUOTENAME(@app) + N';';
    IF OBJECT_ID('rpt.v_directory', 'V') IS NOT NULL
        SET @sql = @sql + N'GRANT SELECT ON OBJECT::rpt.v_directory TO ' + QUOTENAME(@app) + N';';
    IF OBJECT_ID('rpt.workforce_events', 'U') IS NOT NULL
        SET @sql = @sql + N'GRANT SELECT ON OBJECT::rpt.workforce_events TO ' + QUOTENAME(@app) + N';';
    EXEC sp_executesql @sql;
END
ELSE
    PRINT 'Function App user mi-func-hrint not found: grants skipped';

-- Verification: the entra tables with their row counts, then the grants
SELECT t.name AS table_name, SUM(p.rows) AS row_count
FROM sys.tables t
JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
WHERE t.schema_id = SCHEMA_ID('entra')
GROUP BY t.name ORDER BY t.name;

SELECT p.state_desc, p.permission_name, p.class_desc,
       CASE p.class_desc WHEN 'SCHEMA' THEN SCHEMA_NAME(p.major_id)
                         ELSE OBJECT_SCHEMA_NAME(p.major_id) + '.' + OBJECT_NAME(p.major_id) END AS securable
FROM sys.database_permissions p
JOIN sys.database_principals dp ON dp.principal_id = p.grantee_principal_id
WHERE dp.name = @app
  AND ((p.class_desc = 'SCHEMA' AND p.major_id = SCHEMA_ID('entra'))
       OR p.major_id IN (OBJECT_ID('ref.stores'), OBJECT_ID('rpt.v_directory'), OBJECT_ID('rpt.workforce_events')))
ORDER BY securable, p.permission_name;
