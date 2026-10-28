-- SPDX-License-Identifier: GPL-2.0-or-later
-- Extend the existing native journal; no second recovery authority.
ALTER TABLE files_database_operation_receipts ADD COLUMN folder_plan JSONB;
ALTER TABLE file_folders ADD COLUMN deleted_at TIMESTAMPTZ;
CREATE INDEX files_path_operations_batch_item ON files_path_operations((plan->>'operationId'),(plan->>'itemId')) WHERE plan->>'version'='2';
ALTER TABLE files_path_operations DROP CONSTRAINT files_path_operations_action_check;
ALTER TABLE files_path_operations ADD CONSTRAINT files_path_operations_action_check
  CHECK(action IN('move','copy','rename','trash','create-folder'));
ALTER TABLE files_path_operations DROP CONSTRAINT files_path_operations_state_check;
ALTER TABLE files_path_operations ADD CONSTRAINT files_path_operations_state_check
  CHECK(state IN('planned','publishing','db-committed','completed','error','rolled-back',
    'undo-planned','undo-publishing','undo-db-committed','undone'));
