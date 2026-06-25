/**
 * Migration 0029 — Create crm_record_types table.
 *
 * First of the Sulla dynamic-CRM metadata tables. A "record type" is a
 * dynamically-defined entity (the equivalent of a table) — e.g. Person,
 * Company, Engagement — stored as DATA, not DDL, so the AI/Heartbeat can
 * create new types at runtime through the guarded Schema API without a
 * code deploy.
 *
 * Schema-only (no data) per the no-user-data-in-migrations rule; the
 * default system types are inserted by a runtime CrmSystemSeeder.
 * `is_system = true` types cannot be archived/renamed. Soft-delete via
 * `archived`, never a hard delete.
 *
 * Design: projects/sulla-crm-dynamic-architecture/01-P1-SCHEMA-DRAFT.md
 */

export const up = `
  CREATE TABLE IF NOT EXISTS crm_record_types (
    id           TEXT        PRIMARY KEY,
    tenant_id    TEXT        NOT NULL,
    key          TEXT        NOT NULL,
    label        TEXT        NOT NULL,
    label_plural TEXT        NOT NULL,
    icon         TEXT,
    color        TEXT,
    description  TEXT,
    is_system    BOOLEAN     NOT NULL DEFAULT false,
    position     INTEGER     NOT NULL DEFAULT 0,
    created_by   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ,
    archived     BOOLEAN     NOT NULL DEFAULT false
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_record_types_tenant_key
    ON crm_record_types (tenant_id, key) WHERE archived = false;
`;

export const down = `DROP TABLE IF EXISTS crm_record_types CASCADE;`;
