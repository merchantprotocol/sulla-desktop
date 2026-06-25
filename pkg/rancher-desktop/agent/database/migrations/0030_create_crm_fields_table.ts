/**
 * Migration 0030 — Create crm_fields table.
 *
 * A "field" is a dynamically-defined, typed attribute on a record type
 * (the equivalent of a column). The UI renders entirely from this
 * metadata. `data_type` is one of:
 *   text | long_text | number | currency | date | datetime | bool |
 *   select | multi_select | relation | email | phone | url | json | computed
 * with type-specific options (select options, number precision, relation
 * target, formula) stored in the `config` JSONB blob.
 *
 * `is_title = true` marks the field that populates the denormalized
 * crm_records.title (folded in from the system-seed design). `is_system`
 * fields are guarded against archive/key/type changes.
 *
 * Design: projects/sulla-crm-dynamic-architecture/01-P1-SCHEMA-DRAFT.md
 */

export const up = `
  CREATE TABLE IF NOT EXISTS crm_fields (
    id              TEXT        PRIMARY KEY,
    tenant_id       TEXT        NOT NULL,
    record_type_id  TEXT        NOT NULL REFERENCES crm_record_types(id) ON DELETE CASCADE,
    key             TEXT        NOT NULL,
    label           TEXT        NOT NULL,
    data_type       TEXT        NOT NULL,
    config          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    is_required     BOOLEAN     NOT NULL DEFAULT false,
    is_unique       BOOLEAN     NOT NULL DEFAULT false,
    is_title        BOOLEAN     NOT NULL DEFAULT false,
    is_system       BOOLEAN     NOT NULL DEFAULT false,
    position        INTEGER     NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ,
    archived        BOOLEAN     NOT NULL DEFAULT false
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_fields_type_key
    ON crm_fields (record_type_id, key) WHERE archived = false;

  CREATE INDEX IF NOT EXISTS idx_crm_fields_type
    ON crm_fields (record_type_id);
`;

export const down = `DROP TABLE IF EXISTS crm_fields CASCADE;`;
