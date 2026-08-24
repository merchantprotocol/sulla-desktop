/**
 * Migration 0078 — durable persistence for agent questions raised through
 * `ask_user_question` (ApprovalService.parkQuestion).
 *
 * Today those questions live only as an in-memory Promise inside
 * ApprovalService, so a desktop restart loses every pending prompt and there
 * is no surface a mobile client can read or answer. `agent_questions` records
 * each question so it:
 *   - survives restart (offline-safe),
 *   - can be listed in a mobile inbox,
 *   - can be answered from any transport (desktop chat or mobile),
 *   - is deduplicated while still pending (never prompt the human twice), and
 *   - is routed back to the originating orchestration thread.
 *
 * Additive and self-contained: references no other table, only adds new
 * objects. The record/resolve hooks that populate it are wired in a
 * follow-up — see resources/sulla-docs/mobile/agent-questions-contract.md.
 */
export const up = `
CREATE TABLE IF NOT EXISTS agent_questions (
  id                TEXT        PRIMARY KEY,
  conversation_id   TEXT        NOT NULL,
  task_id           TEXT,
  agent             TEXT,
  kind              TEXT        NOT NULL DEFAULT 'decision',
  title             TEXT,
  context           TEXT,
  recommendation    TEXT,
  risk              TEXT,
  questions         JSONB       NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'pending',
  answers           JSONB,
  answered_by       TEXT,
  answered_via      TEXT,
  dedup_fingerprint TEXT        NOT NULL,
  timeout_ms        INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at       TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  CONSTRAINT agent_questions_kind_chk
    CHECK (kind IN ('decision', 'dependency', 'test')),
  CONSTRAINT agent_questions_status_chk
    CHECK (status IN ('pending', 'answered', 'expired', 'superseded', 'cancelled'))
);

-- Dedup: at most one live (pending) question per fingerprint, so a retrying
-- agent never stacks duplicate prompts on the human.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_questions_pending_fingerprint
  ON agent_questions (dedup_fingerprint)
  WHERE status = 'pending';

-- Inbox listing (newest pending first).
CREATE INDEX IF NOT EXISTS idx_agent_questions_status_created
  ON agent_questions (status, created_at DESC);

-- Reverse lookups from a thread or a Projects task.
CREATE INDEX IF NOT EXISTS idx_agent_questions_conversation
  ON agent_questions (conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_questions_task
  ON agent_questions (task_id)
  WHERE task_id IS NOT NULL;
`;

export const down = `
DROP TABLE IF EXISTS agent_questions CASCADE;
`;
