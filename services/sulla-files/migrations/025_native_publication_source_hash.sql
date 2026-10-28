-- SPDX-License-Identifier: GPL-2.0-or-later
-- Preserve the pre-publication source hash with the durable action so a
-- process-restart acknowledgement can prove both sides of the transition.
ALTER TABLE files_native_source_operations ADD COLUMN source_hash TEXT;

UPDATE files_native_source_operations o SET source_hash=COALESCE(
  (SELECT n.source_hash FROM files_native_sources n WHERE n.file_id=o.file_id),
  o.desired_hash
);

ALTER TABLE files_native_source_operations
  ALTER COLUMN source_hash SET NOT NULL,
  ADD CONSTRAINT files_native_source_operations_source_hash_check CHECK(source_hash ~ '^[a-f0-9]{64}$');
