// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const up = `CREATE TABLE IF NOT EXISTS subject_memory.packs (slug text PRIMARY KEY, version integer NOT NULL, source text NOT NULL, installed_at timestamptz NOT NULL DEFAULT now(), files_hash text NOT NULL);`;
export const down = `DROP TABLE IF EXISTS subject_memory.packs;`;
