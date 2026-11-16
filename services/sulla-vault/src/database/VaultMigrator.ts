// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Database } from '../db.js';
import { PostgresVaultSchemaMigrationRepository } from '../repositories/PostgresVaultSchemaMigrationRepository.js';

/**
 * Applies services/sulla-vault/migrations/NNN_*.sql in order inside one
 * transaction under an advisory lock. `moduleDir` is the directory of the
 * compiled db module (src/ or dist/); migrations are looked up next to it.
 */
export class VaultMigrator {
  constructor(private readonly moduleDir: string) {}

  async migrate(db: Database): Promise<void> {
    const here = this.moduleDir;
    let dir: string | undefined;
    let files: string[] = [];
    for (const candidate of [resolve(here, '../migrations'), resolve(here, '../../migrations')]) {
      try {
        files = (await readdir(candidate)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
        if (files.length) {
          dir = candidate;
          break;
        }
      } catch {
        // Try the source-tree path after the container path.
      }
    }
    if (!dir) {
      throw new Error('Could not find vault migrations');
    }
    const client = await db.connect();
    const ledger = new PostgresVaultSchemaMigrationRepository(client);
    try {
      await ledger.begin();
      await ledger.lock();
      for (const file of files) {
        const version = file.replace(/\.sql$/, '');
        // 001 creates vault_schema_migrations itself, so it always runs (it is idempotent).
        if (version !== '001_initial') {
          if (await ledger.isApplied(version)) continue;
        }
        await ledger.runScript(await readFile(resolve(dir, file), 'utf8'));
        await ledger.recordApplied(version);
      }
      await ledger.commit();
    } catch (error) {
      await ledger.rollback();
      throw error;
    } finally {
      client.release();
    }
  }
}
