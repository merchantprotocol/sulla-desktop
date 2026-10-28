-- SPDX-License-Identifier: GPL-2.0-or-later
-- Incremented by every file update, including legacy upload/restore/watcher
-- writers. Undo uses this monotonic value to detect changes and ABA sequences.
ALTER TABLE files ADD COLUMN operation_revision BIGINT NOT NULL DEFAULT 0;
CREATE FUNCTION files_advance_operation_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.operation_revision := OLD.operation_revision + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER files_advance_operation_revision BEFORE UPDATE ON files
  FOR EACH ROW EXECUTE FUNCTION files_advance_operation_revision();

-- No FK to files/versions: an authorized purge must remain possible. A missing
-- file/version makes undo conflict; it must never recreate a purged identity.
CREATE TABLE files_database_operation_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id TEXT NOT NULL,
  actor_scope TEXT NOT NULL,
  idempotency_key UUID NOT NULL,
  request JSONB NOT NULL,
  collection_id UUID NOT NULL,
  file_id UUID NOT NULL,
  action TEXT NOT NULL CHECK(action IN('move','rename','trash')),
  state TEXT NOT NULL CHECK(state IN('completed','skipped','undone')),
  before_state JSONB NOT NULL,
  after_state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  undone_at TIMESTAMPTZ,
  UNIQUE(actor_user_id,actor_scope,idempotency_key),
  CHECK((state='undone') = (undone_at IS NOT NULL))
);
