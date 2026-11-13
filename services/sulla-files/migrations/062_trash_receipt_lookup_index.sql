-- SPDX-License-Identifier: GPL-2.0-or-later
CREATE INDEX IF NOT EXISTS files_database_operation_receipts_trash_file_created_idx
  ON files_database_operation_receipts (file_id, created_at DESC)
  WHERE action = 'trash';
