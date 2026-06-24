/**
 * Migration 0036 — Create crm_audit table (Schema API audit + undo log).
 *
 * The dynamic-CRM safety model (design doc 02 §1.4) requires every mutating
 * Schema/Data op to be audit-logged and reversible. Migration 0027 only
 * created applescript_audit / notifications / function_runs — there is no
 * generic audit table — so the CRM gets its own here.
 *
 * Append-only from the service's perspective: every op INSERTs one row
 * capturing op name, affected entity, before/after JSON snapshots, and a
 * unique `undo_token`. `CrmSchemaService.undo(token)` looks the row up and
 * reverts it (archive a created row, un-archive an archived one, restore an
 * updated record's prior values, drop/re-create a link), then flips `undone`.
 *
 * Design: projects/sulla-crm-dynamic-architecture/02-SCHEMA-API.md §1.4
 */

export const up = `
  CREATE TABLE IF NOT EXISTS crm_audit (
    id           TEXT        PRIMARY KEY,
    tenant_id    TEXT        NOT NULL,
    undo_token   TEXT        NOT NULL,
    op           TEXT        NOT NULL,           -- createRecordType|addField|updateRecord|...
    entity_type  TEXT        NOT NULL,           -- record_type|field|relationship|view|dashboard|widget|record|link
    entity_id    TEXT,                           -- affected row id (null only if pre-insert failed)
    before       JSONB,                          -- prior snapshot (null for creates)
    after        JSONB,                          -- new snapshot (null for hard deletes)
    undone       BOOLEAN     NOT NULL DEFAULT false,
    created_by   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_audit_undo_token
    ON crm_audit (undo_token);
  CREATE INDEX IF NOT EXISTS idx_crm_audit_entity
    ON crm_audit (entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_crm_audit_tenant_created
    ON crm_audit (tenant_id, created_at DESC);
`;

export const down = `DROP TABLE IF EXISTS crm_audit CASCADE;`;
