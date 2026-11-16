-- SPDX-License-Identifier: GPL-2.0-or-later
-- Stop every write in every collection from queuing on one row.
--
-- 042 bumped a single fuse_tree_state row from a statement trigger on files,
-- file_folders, collections and files_protected_files. The row lock is held
-- until commit, so every write transaction (including audit-log appends into
-- the Logs collection) serialized from its first file/folder statement through
-- its WAL flush, whatever collection or path it touched.
--
-- The revision is now the sum of 64 slots. A transaction bumps only the slot
-- of its own backend, so concurrent sessions rarely share a row. The sum is
-- still read in the same MVCC snapshot as the tree it labels and still grows
-- with every committed change, so a mount cache keyed on it stays exact.
-- fuse_tree_state becomes a view with the same shape and continues from the
-- old value, so existing readers and mounted clients see no reset.
CREATE TABLE fuse_tree_revision_slots (
  slot SMALLINT PRIMARY KEY CHECK(slot >= 0 AND slot < 64),
  revision BIGINT NOT NULL DEFAULT 0
);
INSERT INTO fuse_tree_revision_slots(slot,revision)
  SELECT s,CASE WHEN s=0 THEN COALESCE((SELECT revision FROM fuse_tree_state WHERE singleton=TRUE),1) ELSE 0 END
  FROM generate_series(0,63) AS s;

CREATE OR REPLACE FUNCTION bump_fuse_tree_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE fuse_tree_revision_slots SET revision=revision+1 WHERE slot=pg_backend_pid() % 64;
  RETURN NULL;
END $$;

DROP TABLE fuse_tree_state;
CREATE VIEW fuse_tree_state AS
  SELECT TRUE AS singleton,SUM(revision)::bigint AS revision FROM fuse_tree_revision_slots;
