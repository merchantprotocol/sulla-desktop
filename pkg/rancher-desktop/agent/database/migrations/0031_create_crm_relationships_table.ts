/**
 * Migration 0031 — Create crm_relationships table.
 *
 * A "relationship" is a dynamically-defined, typed link between two record
 * types (e.g. Person → Company, Engagement → Person). Cardinality is one of
 * one_to_one | one_to_many | many_to_many. The relationship row is the
 * DEFINITION; the actual links between records live in crm_record_links
 * (migration 0034).
 *
 * `from_label`/`to_label` are the human labels shown on each side's detail
 * view (e.g. "Company" / "People"). Soft-delete via `archived`.
 *
 * Design: projects/sulla-crm-dynamic-architecture/01-P1-SCHEMA-DRAFT.md
 */

export const up = `
  CREATE TABLE IF NOT EXISTS crm_relationships (
    id            TEXT        PRIMARY KEY,
    tenant_id     TEXT        NOT NULL,
    from_type_id  TEXT        NOT NULL REFERENCES crm_record_types(id) ON DELETE CASCADE,
    to_type_id    TEXT        NOT NULL REFERENCES crm_record_types(id) ON DELETE CASCADE,
    cardinality   TEXT        NOT NULL,
    from_label    TEXT,
    to_label      TEXT,
    key           TEXT        NOT NULL,
    is_system     BOOLEAN     NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ,
    archived      BOOLEAN     NOT NULL DEFAULT false
  );

  CREATE INDEX IF NOT EXISTS idx_crm_relationships_from
    ON crm_relationships (from_type_id);

  CREATE INDEX IF NOT EXISTS idx_crm_relationships_to
    ON crm_relationships (to_type_id);
`;

export const down = `DROP TABLE IF EXISTS crm_relationships CASCADE;`;
