// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const up = `CREATE SEQUENCE IF NOT EXISTS subject_memory.memory_pack_install_seq;
CREATE TABLE IF NOT EXISTS subject_memory.packs (
  slug text PRIMARY KEY,
  version integer NOT NULL,
  source text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  files_hash text NOT NULL,
  created_subjects text[] NOT NULL DEFAULT '{}',
  install_seq bigint NOT NULL DEFAULT nextval('subject_memory.memory_pack_install_seq'),
  contributed_aliases jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE subject_memory.packs ADD COLUMN IF NOT EXISTS created_subjects text[] NOT NULL DEFAULT '{}';
ALTER TABLE subject_memory.packs ADD COLUMN IF NOT EXISTS install_seq bigint NOT NULL DEFAULT nextval('subject_memory.memory_pack_install_seq');
ALTER TABLE subject_memory.packs ADD COLUMN IF NOT EXISTS contributed_aliases jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS packs_install_seq_idx ON subject_memory.packs(install_seq);`;
export const down = `DROP TABLE IF EXISTS subject_memory.packs;
DROP SEQUENCE IF EXISTS subject_memory.memory_pack_install_seq;`;
