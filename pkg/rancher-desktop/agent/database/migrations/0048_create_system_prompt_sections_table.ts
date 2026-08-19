/**
 * Migration 0048 — Create system prompt sections table.
 *
 * Backs the editable CORE of the agent system prompt. Each identity file
 * (soul, user, environment, agents, heartbeat) becomes one row here, plus
 * any custom sections the human adds from the Language Model Settings →
 * System Prompt UI.
 *
 * THREE-LAYER RESOLUTION (highest wins):
 *   1. agent-specific physical file  (~/sulla/agents/<id>/*.md)  — per-agent override
 *   2. DB row                        (this table)                — editable global core
 *   3. baked-in native fallback      (soul.ts, bundled *.md)     — ships with app, SEEDS the row
 *
 * SCHEMA-ONLY (per the no-user-data-in-migrations rule — see 0042): this
 * migration creates the table and nothing else. The canonical rows are
 * seeded at runtime from the baked native fallbacks by
 * SystemPromptSectionModel.seedDefaults(), invoked from the database
 * bootstrap. Seeding at runtime (not here) keeps the baked fallback the
 * single source of truth and lets `is_customized` govern upstream drift.
 *
 * Columns:
 *   is_builtin     — one of the canonical identity rows (resettable, not deletable).
 *                    Custom user-added sections are false (fully deletable).
 *   is_generated   — body is produced at runtime (e.g. `environment`); shown
 *                    read-only in the UI, DB content is ignored at compile time.
 *   is_customized  — flipped true the first time the human edits the row. Frozen
 *                    rows are never overwritten when a newer app ships an updated
 *                    baked default; untouched rows follow upstream.
 *   priority / cache_stability — govern placement + KV-cache tier for CUSTOM rows
 *                    (builtin rows keep their registered section's priority/tier).
 */

export const up = `
  CREATE TABLE IF NOT EXISTS sulla_system_prompt_sections (
    id              TEXT        PRIMARY KEY,
    title           TEXT        NOT NULL,
    content         TEXT        NOT NULL DEFAULT '',
    priority        INTEGER     NOT NULL DEFAULT 100,
    enabled         BOOLEAN     NOT NULL DEFAULT true,
    cache_stability TEXT        NOT NULL DEFAULT 'stable',
    is_builtin      BOOLEAN     NOT NULL DEFAULT false,
    is_generated    BOOLEAN     NOT NULL DEFAULT false,
    is_customized   BOOLEAN     NOT NULL DEFAULT false,
    source          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_sulla_sps_enabled_priority
    ON sulla_system_prompt_sections (enabled, priority, id);
`;

export const down = `DROP TABLE IF EXISTS sulla_system_prompt_sections CASCADE;`;
