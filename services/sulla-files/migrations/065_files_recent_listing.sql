-- SPDX-License-Identifier: GPL-2.0-or-later
-- Bounded "Recent" / "Agent files" views read the newest active files of one collection without scanning it.
CREATE INDEX IF NOT EXISTS files_recent_active ON files(collection_id,updated_at DESC,id DESC) WHERE deleted_at IS NULL;
