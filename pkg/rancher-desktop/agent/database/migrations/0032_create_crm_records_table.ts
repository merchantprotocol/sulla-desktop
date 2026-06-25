/**
 * Migration 0032 — Create crm_records table (the data; static core only).
 *
 * A "record" is a single row of business data (a contact, a deal, a job).
 * This table holds ONLY the static core every record needs — id, type,
 * tenant, a denormalized `title` for display and `search_text` for FTS,
 * and timestamps. Everything custom lives in crm_field_values (0033),
 * keyed by the record's type's fields.
 *
 * The GIN index drives Postgres full-text search over the denormalized
 * search_text (kept correct by the data ops on every write). Soft-delete
 * via `archived`; ON DELETE CASCADE keeps a rare hard purge clean.
 *
 * Design: projects/sulla-crm-dynamic-architecture/01-P1-SCHEMA-DRAFT.md
 */

export const up = `
  CREATE TABLE IF NOT EXISTS crm_records (
    id              TEXT        PRIMARY KEY,
    tenant_id       TEXT        NOT NULL,
    record_type_id  TEXT        NOT NULL REFERENCES crm_record_types(id) ON DELETE CASCADE,
    title           TEXT,
    search_text     TEXT,
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ,
    archived        BOOLEAN     NOT NULL DEFAULT false
  );

  CREATE INDEX IF NOT EXISTS idx_crm_records_type_created
    ON crm_records (record_type_id, created_at DESC) WHERE archived = false;

  CREATE INDEX IF NOT EXISTS idx_crm_records_search
    ON crm_records USING GIN (to_tsvector('english', coalesce(search_text, '')));
`;

export const down = `DROP TABLE IF EXISTS crm_records CASCADE;`;
