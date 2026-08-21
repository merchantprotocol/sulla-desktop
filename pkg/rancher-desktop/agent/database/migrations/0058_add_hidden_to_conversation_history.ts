/**
 * Migration 0058 — Add explicit hidden flag to conversation_history.
 *
 * Part of the Conversation-Recall subconscious agent epic (01aZ), task scjd.
 *
 * Today "hidden from the user-facing history UI" is implicit: 4 query sites
 * in ConversationHistoryModel (getRecent/search/getByDateRange, all filtered
 * the same way) exclude rows via `channel_id NOT LIKE 'subconscious%'`. That
 * pattern only catches the `subconscious:<agent>` channel namespace — it
 * misses the worker/dispatch channels (`codex-test`, `thinker-worker`,
 * `opus-worker`, `fable-planner`) confirmed live in the DB, which are
 * internal machinery too but currently surface in history queries.
 *
 * This migration makes the concept an explicit column instead of a string
 * match, and backfills it for both categories above. Verified against the
 * live dev Postgres inside a rolled-back transaction: the backfill UPDATE
 * touches exactly 5,813 rows — the sum of every `subconscious:*` channel
 * (2081 + 2081 + 1348 + 105 + 4) plus the 4 named worker channels
 * (102 + 70 + 12 + 10), with zero rows caught outside that set.
 *
 * Follow-up (not in this migration): a separate long tail of
 * observer-prefixed channels (`observer-market`, `observer-operations`,
 * `Observer`, `Thinker`, `Goals Cascade Refresher`, etc., ~50 rows total)
 * looks like legacy identity-observer machinery too, but isn't named in
 * scjd's acceptance criteria and its provenance wasn't confirmed against
 * current code — left visible pending a deliberate decision rather than
 * silently hidden.
 */

export const up = `
  ALTER TABLE conversation_history ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;

  CREATE INDEX IF NOT EXISTS idx_conv_history_hidden ON conversation_history(hidden);

  UPDATE conversation_history
  SET hidden = TRUE
  WHERE hidden = FALSE
    AND (
      channel_id ILIKE 'subconscious%'
      OR channel_id = ANY(ARRAY['codex-test', 'thinker-worker', 'opus-worker', 'fable-planner'])
    );
`;

export const down = `
  DROP INDEX IF EXISTS idx_conv_history_hidden;
  ALTER TABLE conversation_history DROP COLUMN IF EXISTS hidden;
`;
