// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface InstalledMigration { sql: string; hash: string; tables: string[]; extensions: string[] }

/** The migration files shipped with this build: their SQL, digest and the tables/extensions they create. */
export class MigrationCatalog {
  static readonly defaultDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

  constructor(private readonly directory:string = MigrationCatalog.defaultDirectory) {}

  async installed():Promise<Map<string, InstalledMigration>> {
    const installed = new Map<string, InstalledMigration>();
    for (const name of (await readdir(this.directory)).filter(value => /^\d+_[a-z0-9_]+\.sql$/.test(value))) {
      const sql = await readFile(resolve(this.directory, name), 'utf8');
      installed.set(name, {
        sql,
        hash:       createHash('sha256').update(sql).digest('hex'),
        tables:     MigrationCatalog.tablesCreatedBy(sql),
        extensions: MigrationCatalog.extensionsCreatedBy(sql),
      });
    }
    return installed;
  }

  static tablesCreatedBy(sql:string):string[] {
    const names = new Set<string>();
    const pattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?([a-z][a-z0-9_]*)["']?/gi;
    for (const match of sql.matchAll(pattern)) names.add(match[1]);
    return [...names];
  }

  static extensionsCreatedBy(sql:string):string[] {
    const names = new Set<string>();
    const pattern = /CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z][a-z0-9_]*)"?/gi;
    for (const match of sql.matchAll(pattern)) names.add(match[1]);
    return [...names];
  }
}
