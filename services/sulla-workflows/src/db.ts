import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { config } from './config.js';

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

export async function migrate(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDir = path.resolve(here, '../../../../migrations');
  const files = (await fs.readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
  for (const file of files) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
