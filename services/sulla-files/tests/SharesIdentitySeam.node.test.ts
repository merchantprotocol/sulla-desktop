// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type pg from 'pg';

import type { Config } from '../src/config.js';
import { SharesService } from '../src/shares.js';
import type { Store } from '../src/store.js';

const identity = { user: 'fixture-owner', device: 'fixture-request-device' };
const canonical = 'fixture-canonical-device';
const input = { collectionId: 'fixture-collection', folderPath: 'captures', deviceId: identity.device };

interface FixtureRow {
  id: string;
  owner_user_id: string;
  target_type: string;
  display_name: string;
  mime: string;
  access_mode: string;
  revoked_at: string | null;
  device_id: string;
  display_sharer_name: boolean;
}

class ShareFixtureDatabase {
  readonly restoredId = 'fixture-revoked-share';
  readonly rows = new Map<string, FixtureRow>([[this.restoredId, {
    id: this.restoredId, owner_user_id: identity.user, target_type: 'folder',
    display_name: 'captures', mime: 'application/json', access_mode: 'view',
    revoked_at: '2026-01-01T00:00:00Z', device_id: 'fixture-old-device', display_sharer_name: true,
  }]]);
  writes = 0;

  readonly pool = {
    connect: async() => ({ query: this.query.bind(this), release() {} }),
  } as unknown as pg.Pool;

  private async query(sql: string, values: unknown[]) {
    const [id, owner] = values as string[];
    const row = this.rows.get(id);
    if (sql.startsWith('SELECT pg_advisory_')) return { rows: [] };
    if (sql.startsWith('SELECT * FROM file_share_links WHERE id=$1 AND owner_user_id=$2')) {
      return { rows: row?.owner_user_id === owner ? [row] : [] };
    }
    if (sql.startsWith('INSERT INTO file_share_links')) {
      this.rows.set(id, {
        id, owner_user_id: owner, target_type: String(values[2]), display_name: String(values[6]),
        mime: String(values[7]), access_mode: String(values[8]), device_id: String(values[16]),
        revoked_at: 'pending', display_sharer_name: Boolean(values[14]),
      });
    } else if (sql.startsWith('UPDATE file_share_links SET revoked_at=NULL,public_url=')) {
      assert.ok(row);
      row.revoked_at = null;
      row.device_id = String(values[3]);
    } else if (sql.startsWith('UPDATE file_share_links SET public_url=')) {
      assert.ok(row);
      row.revoked_at = null;
    } else if (!sql.startsWith('INSERT INTO file_share_events') && !sql.startsWith('UPDATE file_share_links SET revoked_at=COALESCE')) {
      throw new Error('Unexpected query in synthetic share seam');
    }
    this.writes++;

    return { rows: [] };
  }
}

class SyntheticShareBroker {
  readonly devices: unknown[] = [];

  async execute(path: string, method?: string, json?: unknown) {
    assert.equal(path, '/shares');
    assert.equal(method, 'POST');
    const body = JSON.parse(String(json));
    this.devices.push(body.deviceId);

    return { status: 201, body: { ...body, url: 'https://shares.invalid/fixture', keepUntil: body.keepUntil ?? null } };
  }
}

// risk: request/local provenance or old stored device must not address a different Cloud device.
test('SharesService sends and records the canonical ID on create and restore', async() => {
  const db = new ShareFixtureDatabase();
  const broker = new SyntheticShareBroker();
  const service = new SharesService(db.pool, { mode: 'desktop', cloudDeviceId: canonical } as Config, {} as Store, { cloudBroker: broker });

  const created = await service.create(identity, input);
  const restored = await service.restore(identity, db.restoredId);

  assert.deepEqual(broker.devices, [canonical, canonical]);
  for (const row of [created, restored]) {
    assert.equal(row.device_id, canonical);
    assert.equal(row.revoked_at, null);
  }
});

// risk: missing canonical identity must fail closed before any public or durable local change.
test('SharesService rejects create and restore without a canonical ID', async() => {
  const db = new ShareFixtureDatabase();
  const broker = new SyntheticShareBroker();
  const service = new SharesService(db.pool, { mode: 'desktop', deviceId: 'fixture-local-host' } as Config, {} as Store, { cloudBroker: broker });

  await assert.rejects(service.create(identity, input), { status: 503 });
  await assert.rejects(service.restore(identity, db.restoredId), { status: 503 });
  assert.deepEqual(broker.devices, []);
  assert.equal(db.writes, 0);
  assert.equal(db.rows.get(db.restoredId)?.revoked_at, '2026-01-01T00:00:00Z');
});
