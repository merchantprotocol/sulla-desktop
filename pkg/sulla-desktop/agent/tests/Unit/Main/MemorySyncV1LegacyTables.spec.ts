// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// Cloud memory sync no longer moves the retired observations / identity_observations tables. The
// real MemorySyncV1 pull loop and the real record crypto run here; the cloud API, the vault key
// unwrap, settings and Postgres are recording fakes.
// @vitest-environment node
import '../../Support/TestHomeEnv';

import crypto from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemorySyncV1 } from '../../../../main/cloud/memorySyncV1';
import { encryptMemoryRecord } from '../../../../main/cloud/memorySyncV1/protocol';

const USER_ID = 'cloud-user-1';
const LOCAL_DEVICE = 'desktop-local';
const FOREIGN_DEVICE = 'desktop-other';
const MEMORY_KEY = crypto.randomBytes(32);

/** Records every SQL statement with its parameters; every read returns no rows. */
class RecordingPostgres {
  readonly statements: Array<{ sql: string; params: unknown[] }> = [];
  async query(sql: string, params: unknown[] = []): Promise<unknown[]> { this.statements.push({ sql, params }); return [] }
  async queryOne(sql: string, params: unknown[] = []): Promise<null> { this.statements.push({ sql, params }); return null }
  touching(pattern: RegExp): Array<{ sql: string; params: unknown[] }> {
    return this.statements.filter(s => pattern.test(s.sql) || s.params.some(p => pattern.test(JSON.stringify(p) ?? '')));
  }
}

/** Serves one page of pulled changes from the memory-sync cloud API. */
class FakeMemoryCloud {
  constructor(private readonly records: unknown[]) {}
  async request(method: string, path: string): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
    if (method === 'GET' && path === '/memory-sync/v1/key-slot') return this.reply(200, { wrappedKey: 'wrapped' });
    if (method === 'GET' && path.startsWith('/memory-sync/v1/changes')) return this.reply(200, { records: this.records, head: null, nextCursor: null });
    return this.reply(500, { error: `unexpected ${ method } ${ path }` });
  }
  private reply(status: number, body: unknown) { return { ok: status < 300, status, json: async() => body } }
}

/** Builds encrypted wire records the way another device would push them. */
class WireRecordFactory {
  live(table: string, pk: string, value: Record<string, unknown>, seq: number) {
    const id = `${ table }:${ pk }`;
    const plain = { format: 1, table, id, value, sourceDeviceId: FOREIGN_DEVICE };
    return { id, generation: 1, seq, deleted: false, deviceId: FOREIGN_DEVICE, envelope: encryptMemoryRecord(MEMORY_KEY, USER_ID, id, 1, plain) };
  }
  deleted(table: string, pk: string, seq: number) {
    return { id: `${ table }:${ pk }`, generation: 2, seq, deleted: true, deviceId: FOREIGN_DEVICE };
  }
}

const f = vi.hoisted(() => ({ db: null as any, cloud: null as any, settings: new Map<string, string>() }));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test', isPackaged: false }, safeStorage: {} }));
vi.mock('@pkg/agent/database/PostgresClient', () => ({
  postgresClient: {
    query:    (sql: string, params?: unknown[]) => f.db.query(sql, params),
    queryOne: (sql: string, params?: unknown[]) => f.db.queryOne(sql, params),
  },
}));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: {
    get: async(key: string, fallback?: string) => f.settings.get(key) ?? fallback,
    set: async(key: string, value: string) => { f.settings.set(key, value) },
  },
}));
vi.mock('../../../../main/deviceIdentity', () => ({ getDesktopDeviceId: async() => LOCAL_DEVICE }));
vi.mock('../../../../main/sullaCloudAuth', () => ({ getCurrentUserId: async() => USER_ID }));
vi.mock('../../../../main/cloud/cloudFetch', () => ({
  cloudRequest:     (method: string, path: string) => f.cloud.request(method, path),
  isCloudSignedIn:  async() => true,
}));
vi.mock('../../../../main/cloud/cloudSettings', () => ({ getCloudPreferences: async() => ({}), isCloudKindEnabled: () => true }));
vi.mock('../../../../main/cloud/filesSyncV1/containerClient', () => ({
  FilesSyncClientError: class extends Error { code = '' },
  FilesSyncContainer:   { vaultUnwrapMemoryKey: async() => ({ memoryKey: MEMORY_KEY.toString('base64') }) },
}));

const wire = new WireRecordFactory();
const LEGACY = /\b(?:identity_)?observations\b/;

beforeEach(() => {
  f.db = new RecordingPostgres();
  f.settings.clear();
});

describe('cloud memory sync pull after observation memory removal', () => {
  it('ignores pulled observations and identity_observations records but still applies subject memory', async() => {
    // risk: a background sync keeps writing, queueing or archiving rows in the removed memory systems
    f.cloud = new FakeMemoryCloud([
      wire.live('observations', 'obs-1', { id: 'obs-1', content: 'old top-10 fact', always_on: true }, 1),
      wire.live('identity_observations', 'idn-1', { id: 'idn-1', content: 'old profile line' }, 2),
      wire.deleted('observations', 'obs-2', 3),
      wire.live('subject_memory.items', 'item-1', { id: 'item-1', kind: 'fact', text: 'kept v7 memory' }, 4),
    ]);

    await MemorySyncV1.syncNow();

    expect(MemorySyncV1.getStatus()[0].lastError).toBeUndefined();
    expect(f.db.touching(LEGACY)).toEqual([]);
    expect(f.db.touching(/memory_sync_v1_pending/).filter((s: any) => /INSERT/.test(s.sql))).toEqual([]);
    expect(f.db.statements.some((s: any) => /INSERT INTO subject_memory\.items/.test(s.sql) && String(s.params[0]).includes('kept v7 memory'))).toBe(true);
    expect(f.settings.get('memorySyncV1Cursor')).toBe('4');
  });
});
