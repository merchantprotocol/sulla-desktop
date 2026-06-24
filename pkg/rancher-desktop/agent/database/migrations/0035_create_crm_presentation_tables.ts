/**
 * Migration 0035 — Create CRM presentation-metadata tables.
 *
 * The presentation layer that makes the dynamic engine usable, all driven
 * by metadata (no entity-specific UI code):
 *   crm_views       — a saved lens over one record type (table | kanban |
 *                     calendar | list | gallery) with visible fields,
 *                     filters, sort, group-by. This is what makes
 *                     "opportunities / appointments / jobs" three views of
 *                     one Engagement type.
 *   crm_dashboards  — a named page of widgets (Sales, Production, …).
 *   crm_widgets     — a dashboard component bound to one record type with
 *                     an aggregation config (metric/field/period/display);
 *                     compiles to SUM/COUNT over crm_field_values.
 *   crm_menu_items  — left-nav entries, usually auto-created when a record
 *                     type is created (nav is a projection of metadata).
 *
 * Schema-only; the default system views/dashboards/widgets/nav are inserted
 * by the runtime CrmSystemSeeder. Soft-delete via `archived`.
 *
 * Design: projects/sulla-crm-dynamic-architecture/00-VISION-AND-ARCHITECTURE.md §4.3
 *         projects/sulla-crm-dynamic-architecture/03-SYSTEM-SEED.md
 */

export const up = `
  CREATE TABLE IF NOT EXISTS crm_dashboards (
    id          TEXT        PRIMARY KEY,
    tenant_id   TEXT        NOT NULL,
    key         TEXT        NOT NULL,
    name        TEXT        NOT NULL,
    icon        TEXT,
    layout      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    is_system   BOOLEAN     NOT NULL DEFAULT false,
    position    INTEGER     NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ,
    archived    BOOLEAN     NOT NULL DEFAULT false
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_dashboards_tenant_key
    ON crm_dashboards (tenant_id, key) WHERE archived = false;

  CREATE TABLE IF NOT EXISTS crm_views (
    id              TEXT        PRIMARY KEY,
    tenant_id       TEXT        NOT NULL,
    record_type_id  TEXT        NOT NULL REFERENCES crm_record_types(id) ON DELETE CASCADE,
    name            TEXT        NOT NULL,
    kind            TEXT        NOT NULL,            -- table|kanban|calendar|list|gallery
    config          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    is_system       BOOLEAN     NOT NULL DEFAULT false,
    position        INTEGER     NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ,
    archived        BOOLEAN     NOT NULL DEFAULT false
  );
  CREATE INDEX IF NOT EXISTS idx_crm_views_type
    ON crm_views (record_type_id) WHERE archived = false;

  CREATE TABLE IF NOT EXISTS crm_widgets (
    id              TEXT        PRIMARY KEY,
    tenant_id       TEXT        NOT NULL,
    dashboard_id    TEXT        NOT NULL REFERENCES crm_dashboards(id) ON DELETE CASCADE,
    record_type_id  TEXT        NOT NULL REFERENCES crm_record_types(id) ON DELETE CASCADE,
    name            TEXT        NOT NULL,
    kind            TEXT        NOT NULL,            -- stat|line|bar|funnel|list|table
    config          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    position        INTEGER     NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ,
    archived        BOOLEAN     NOT NULL DEFAULT false
  );
  CREATE INDEX IF NOT EXISTS idx_crm_widgets_dashboard
    ON crm_widgets (dashboard_id) WHERE archived = false;

  CREATE TABLE IF NOT EXISTS crm_menu_items (
    id              TEXT        PRIMARY KEY,
    tenant_id       TEXT        NOT NULL,
    label           TEXT        NOT NULL,
    icon            TEXT,
    target_type     TEXT        NOT NULL,            -- record_type|dashboard|url
    target_id       TEXT,                            -- record_type_id or dashboard_id
    target_url      TEXT,
    auto_created    BOOLEAN     NOT NULL DEFAULT false,
    is_system       BOOLEAN     NOT NULL DEFAULT false,
    position        INTEGER     NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ,
    archived        BOOLEAN     NOT NULL DEFAULT false
  );
  CREATE INDEX IF NOT EXISTS idx_crm_menu_items_tenant_position
    ON crm_menu_items (tenant_id, position) WHERE archived = false;
`;

export const down = `
  DROP TABLE IF EXISTS crm_menu_items CASCADE;
  DROP TABLE IF EXISTS crm_widgets CASCADE;
  DROP TABLE IF EXISTS crm_views CASCADE;
  DROP TABLE IF EXISTS crm_dashboards CASCADE;
`;
