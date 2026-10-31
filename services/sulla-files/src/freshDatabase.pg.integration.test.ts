// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import { migrate } from './db.js';
import { LocalFilesManager } from './localManager.js';
import { collectionIdFor, ensureSystemAreas } from './systemAreas.js';

import type { Config } from './config.js';

const databaseUrl = process.env.SULLA_FILES_FRESH_DATABASE_TEST_URL;
const databaseName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : '';
const enabled = Boolean(databaseUrl && process.env.SULLA_FILES_ALLOW_DESTRUCTIVE_TESTS === '1' && /(^test_|_test$)/.test(databaseName));
const integration = enabled ? test : test.skip;

integration('boots Files twice on an empty database with one stable home collection', async() => {
  const db = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-fresh-'));
  const userId = 'fresh-database-owner';
  const config = {
    userId, orgId: undefined, dataRoot: join(root, 'data'), chunkRoot: join(root, 'chunks'),
    serverUrl: undefined, keyring: { unlocked: true, create: async() => ({ data: {}, dedup: {} }) },
  } as unknown as Config;
  try {
    await migrate(db);
    await db.query('TRUNCATE collections CASCADE');
    for (let boot = 0; boot < 2; boot++) {
      await ensureSystemAreas(db, config);
      const manager = new LocalFilesManager(db, config);
      await manager.initialize();
      await manager.close();
    }
    const homes = (await db.query("SELECT id FROM collections WHERE owner_user_id=$1 AND explorer_path='' AND published=TRUE", [userId])).rows;
    assert.deepEqual(homes, [{ id: collectionIdFor(userId) }]);
  } finally {
    await db.end();
    await rm(root, { recursive: true, force: true });
  }
});
