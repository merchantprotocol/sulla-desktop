// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs/promises';
import path from 'path';
import { postgresClient } from '../database/PostgresClient';
import { resetV7SubjectMemoryCache } from './V7SubjectMemory';

/** Write a portable v7 snapshot atomically. Callers choose the destination. */
export async function exportV7SubjectMemory(file: string): Promise<void> {
  const rows = await postgresClient.query<{ doc: unknown }>('SELECT subject_memory.export_json() doc');
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(rows[0]?.doc ?? { version: 7 }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Idempotently load a portable snapshot made by exportV7SubjectMemory. */
export async function importV7SubjectMemory(file: string): Promise<number> {
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  const rows = await postgresClient.query<{ result: { imported?: number } }>('SELECT subject_memory.import_json($1::jsonb) result', [JSON.stringify(doc)]);
  resetV7SubjectMemoryCache();
  return Number(rows[0]?.result?.imported ?? 0);
}
