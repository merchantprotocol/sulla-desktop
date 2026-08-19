/**
 * Migration 0049 — Create system prompt section edits (staged proposals) table.
 *
 * Human-in-the-loop guardrail for AI-authored prompt changes. Agents NEVER write
 * a sulla_system_prompt_sections row directly — they stage a proposal here, and
 * the human approves / edits / denies it from Language Model Settings → System
 * Prompt. Only on approval is the proposed content copied into the live row.
 *
 * status:      pending | approved | denied | superseded
 *   - superseded: an older pending proposal for the same section, retired when a
 *     newer proposal for that section is approved (keeps history without ambiguity).
 * base_content: snapshot of the row's content at propose time — used to render an
 *   accurate diff and to detect when the live row drifted after the proposal.
 *
 * SCHEMA-ONLY (per the no-user-data-in-migrations rule — see 0042/0048).
 */

export const up = `
  CREATE TABLE IF NOT EXISTS sulla_system_prompt_section_edits (
    id               TEXT        PRIMARY KEY,
    section_id       TEXT        NOT NULL,
    proposed_content TEXT        NOT NULL,
    base_content     TEXT        NOT NULL DEFAULT '',
    rationale        TEXT,
    status           TEXT        NOT NULL DEFAULT 'pending',
    proposed_by      TEXT,
    reviewed_by      TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at      TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_sulla_sps_edits_pending
    ON sulla_system_prompt_section_edits (status, section_id, created_at DESC);
`;

export const down = `DROP TABLE IF EXISTS sulla_system_prompt_section_edits CASCADE;`;
