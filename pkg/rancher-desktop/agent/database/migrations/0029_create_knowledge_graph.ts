export const up = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE OR REPLACE FUNCTION norm_alias(x text) RETURNS text
 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT regexp_replace(lower(unaccent('unaccent', x)), '[^a-z0-9#]+', '', 'g') $$;

CREATE TABLE IF NOT EXISTS knowledge_nodes (
 id TEXT PRIMARY KEY,
 node_type TEXT NOT NULL DEFAULT 'entity',
 title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', detail TEXT,
 link_count INTEGER NOT NULL DEFAULT 0, recall_count INTEGER NOT NULL DEFAULT 0,
 last_recalled_at TIMESTAMPTZ, archived BOOLEAN NOT NULL DEFAULT false,
 merged_into TEXT REFERENCES knowledge_nodes(id), source TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || summary)) STORED
);
CREATE TABLE IF NOT EXISTS node_aliases (
 alias TEXT NOT NULL, alias_norm TEXT NOT NULL,
 node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
 PRIMARY KEY (alias_norm, node_id)
);
CREATE TABLE IF NOT EXISTS node_links (
 src_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
 dst_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
 relation_type TEXT NOT NULL DEFAULT 'related_to',
 strength REAL NOT NULL DEFAULT 0.3, fire_count INTEGER NOT NULL DEFAULT 0,
 last_fired_at TIMESTAMPTZ, confirmed BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (src_id, dst_id, relation_type), CHECK (src_id <> dst_id)
);
CREATE INDEX IF NOT EXISTS idx_node_aliases_norm ON node_aliases (alias_norm);
CREATE INDEX IF NOT EXISTS idx_node_aliases_trgm ON node_aliases USING gin (alias_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_tsv ON knowledge_nodes USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_node_links_src ON node_links (src_id) INCLUDE (dst_id, relation_type, strength, confirmed, last_fired_at, created_at);
CREATE INDEX IF NOT EXISTS idx_node_links_dst ON node_links (dst_id) INCLUDE (src_id, relation_type, strength, confirmed, last_fired_at, created_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_hub ON knowledge_nodes (link_count DESC) WHERE archived = false;
`;

export const down = `
DROP TABLE IF EXISTS node_links CASCADE;
DROP TABLE IF EXISTS node_aliases CASCADE;
DROP TABLE IF EXISTS knowledge_nodes CASCADE;
DROP FUNCTION IF EXISTS norm_alias(text);
`;
