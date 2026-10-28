// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { PoolClient } from 'pg';

export async function up(client: PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS integration_packages (
    id text NOT NULL, version text NOT NULL, template_id text NOT NULL,
    manifest jsonb NOT NULL, files jsonb NOT NULL, installed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, version)
  )`);
}
export async function down(client: PoolClient): Promise<void> { await client.query('DROP TABLE IF EXISTS integration_packages') }
