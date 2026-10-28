// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { config } from './config.js';

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
// Session-level launch locks must not consume the work-query pool while a
// runner handshake is polling. Keeping a small separate pool prevents a wave
// of launches from starving the queries needed to complete those launches.
export const advisoryLockPool = new Pool({ connectionString: config.databaseUrl, max: 4 });

export async function migrate(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDir = path.resolve(here, '../../../../migrations');
  const files = (await fs.readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
  for (const file of files) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
}

export async function closeDb(): Promise<void> {
  await Promise.all([pool.end(), advisoryLockPool.end()]);
}
