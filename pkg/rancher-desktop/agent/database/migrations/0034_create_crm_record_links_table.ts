/**
 * Migration 0034 — Create crm_record_links table (relationship instances).
 *
 * The actual links between records, instantiating a definition from
 * crm_relationships (0031). Works for every cardinality — one_to_one /
 * one_to_many constraints are enforced in the app layer; the table itself
 * is the general many-to-many join. The unique index dedupes
 * (relationship, from, to) triples; the from/to indexes drive detail-view
 * lookups in both directions.
 *
 * Design: projects/sulla-crm-dynamic-architecture/01-P1-SCHEMA-DRAFT.md
 */

export const up = `
  CREATE TABLE IF NOT EXISTS crm_record_links (
    id               TEXT        PRIMARY KEY,
    tenant_id        TEXT        NOT NULL,
    relationship_id  TEXT        NOT NULL REFERENCES crm_relationships(id) ON DELETE CASCADE,
    from_record_id   TEXT        NOT NULL REFERENCES crm_records(id) ON DELETE CASCADE,
    to_record_id     TEXT        NOT NULL REFERENCES crm_records(id) ON DELETE CASCADE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_links_unique
    ON crm_record_links (relationship_id, from_record_id, to_record_id);

  CREATE INDEX IF NOT EXISTS idx_crm_links_from
    ON crm_record_links (from_record_id);

  CREATE INDEX IF NOT EXISTS idx_crm_links_to
    ON crm_record_links (to_record_id);
`;

export const down = `DROP TABLE IF EXISTS crm_record_links CASCADE;`;
