// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Backup manifests signed before PR #2369 used the Files key Desktop derived from the
// compose-escaped secret (every `$` doubled). They must keep verifying; nothing else may.
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { IncrementalBackupService, IncrementalManifestSigner, type IncrementalManifest } from '../src/backup/incremental.js';
import { CapabilityKeyCandidates } from '../src/CapabilityKeyCandidates.js';

import type { BackupDatabaseOperations } from '../src/backup/database.js';
import type { BackupObjectStore } from '../src/backup/destinations.js';
import type { Config } from '../src/config.js';

/** Desktop's sullaFilesCapabilityKey derivation. */
const desktopKey = (secret:string) => createHmac('sha256', secret).update('sulla-files-capability-v1').digest('hex');
const escaped = (secret:string) => secret.replace(/\$/g, '$$$$');
const DOLLAR_SECRET = 'pa$$w$rd-Real_Install_Secret';
const PLAIN_SECRET = 'Plain_Install_Secret_without_dollars';

class MemoryStore implements BackupObjectStore {
  readonly description = 'memory';
  readonly objects = new Map<string, Buffer>();
  async has(key:string) { return this.objects.has(key) }
  async putImmutable(key:string, value:Buffer | string) { if (!this.objects.has(key)) this.objects.set(key, Buffer.from(value)) }
  async putFileImmutable() { throw new Error('unused') }
  async get(key:string) { const value = this.objects.get(key); if (!value) throw new Error(`missing ${ key }`); return Buffer.from(value) }
  async remove(key:string) { this.objects.delete(key) }
  async close() {}
}

const manifest = (id:string):IncrementalManifest => ({
  format: 'sulla-files-incremental-backup', version: 1, id, createdAt: '2026-11-01T00:00:00.000Z', tier: 'hourly',
  postgresVersion: '16.4', snapshotId: '1:1:', migrations: ['001_sulla_files.sql'], tables: [], excludedTableData: {}, entries: [],
});

function serviceFor(secret:string, capabilitySigningKey = desktopKey(secret)):IncrementalBackupService {
  const config = { databaseUrl: 'postgres://files', chunkRoot: '/nonexistent', capabilitySigningKey, localToken: secret } as unknown as Config;
  return new IncrementalBackupService(config, {} as BackupDatabaseOperations, {} as any);
}

async function stored(store:MemoryStore, key:string, id:string):Promise<string> {
  const signed = new IncrementalManifestSigner(key).signed(manifest(id));
  const path = IncrementalManifestSigner.manifestKey(signed.manifest);
  await store.putImmutable(path, JSON.stringify(signed));
  return path;
}

describe('capability key candidates', () => {
  // risk: security — the previous key exists only for a `$` secret whose current key is Desktop's derivation of it.
  it('adds the compose-escaped key only for a $ secret matching the current key', () => {
    const dual = CapabilityKeyCandidates.fromConfig({ capabilitySigningKey: desktopKey(DOLLAR_SECRET), localToken: DOLLAR_SECRET });
    expect(dual.all).toEqual([desktopKey(DOLLAR_SECRET), desktopKey(escaped(DOLLAR_SECRET))]);
    expect(dual.current).toBe(desktopKey(DOLLAR_SECRET));

    expect(CapabilityKeyCandidates.fromConfig({ capabilitySigningKey: desktopKey(PLAIN_SECRET), localToken: PLAIN_SECRET }).all).toEqual([desktopKey(PLAIN_SECRET)]);
    // An explicitly configured key unrelated to the local token never gains a second key.
    expect(CapabilityKeyCandidates.fromConfig({ capabilitySigningKey: 'x'.repeat(64), localToken: DOLLAR_SECRET }).all).toEqual(['x'.repeat(64)]);
    expect(CapabilityKeyCandidates.fromConfig({ capabilitySigningKey: desktopKey(DOLLAR_SECRET) }).all).toEqual([desktopKey(DOLLAR_SECRET)]);
  });
});

describe('incremental backup manifest verification across the #2369 key change', () => {
  // risk: data loss — backups written before #2369 must still restore.
  it('accepts a manifest signed with the old compose-escaped key when the secret holds $', async() => {
    const store = new MemoryStore();
    const path = await stored(store, desktopKey(escaped(DOLLAR_SECRET)), 'old');
    await expect(serviceFor(DOLLAR_SECRET).verifyManifest(store, path)).resolves.toMatchObject({ manifest: { id: 'old' } });
  });

  it('accepts a manifest signed with the current key', async() => {
    const store = new MemoryStore();
    const path = await stored(store, desktopKey(DOLLAR_SECRET), 'new');
    await expect(serviceFor(DOLLAR_SECRET).verifyManifest(store, path)).resolves.toMatchObject({ manifest: { id: 'new' } });
  });

  // risk: security — a forged or foreign manifest must never verify.
  it('rejects a manifest signed with an unrelated key, a tampered manifest and an unsigned one', async() => {
    const store = new MemoryStore();
    const service = serviceFor(DOLLAR_SECRET);
    await expect(service.verifyManifest(store, await stored(store, desktopKey('someone-else$'), 'foreign'))).rejects.toThrow('Backup manifest signature is invalid');

    const tamperedPath = await stored(store, desktopKey(escaped(DOLLAR_SECRET)), 'tampered');
    const tampered = JSON.parse(store.objects.get(tamperedPath)!.toString('utf8'));
    tampered.manifest.tier = 'weekly'; store.objects.set(tamperedPath, Buffer.from(JSON.stringify(tampered)));
    await expect(service.verifyManifest(store, tamperedPath)).rejects.toThrow('Backup manifest signature is invalid');

    const unsignedPath = await stored(store, desktopKey(DOLLAR_SECRET), 'unsigned');
    const unsigned = JSON.parse(store.objects.get(unsignedPath)!.toString('utf8'));
    delete unsigned.signature.value; store.objects.set(unsignedPath, Buffer.from(JSON.stringify(unsigned)));
    await expect(service.verifyManifest(store, unsignedPath)).rejects.toThrow('Backup manifest signature is invalid');
  });

  // risk: security — new data is never signed with the retired key.
  it('signs promoted manifests with the current key only', async() => {
    const store = new MemoryStore();
    const service = serviceFor(DOLLAR_SECRET);
    const source = await service.verifyManifest(store, await stored(store, desktopKey(escaped(DOLLAR_SECRET)), 'old'));
    const promoted = await service.promote(store, source, 'daily');
    expect(promoted.manifest.signature.value).toBe(new IncrementalManifestSigner(desktopKey(DOLLAR_SECRET)).sign(promoted.manifest.manifest));
  });

  // risk: security — a secret without $ keeps exactly one key, as before #2369.
  it('keeps single-key behaviour for a secret without $', async() => {
    const store = new MemoryStore();
    const service = serviceFor(PLAIN_SECRET);
    await expect(service.verifyManifest(store, await stored(store, desktopKey(PLAIN_SECRET), 'plain'))).resolves.toBeDefined();
    await expect(service.verifyManifest(store, await stored(store, desktopKey(escaped(DOLLAR_SECRET)), 'other'))).rejects.toThrow('Backup manifest signature is invalid');
  });

  // risk: security — when the configured key is not Desktop's derivation of the token, the escaped key is refused.
  it('refuses the escaped key when the configured key does not derive from the local token', async() => {
    const store = new MemoryStore();
    const service = serviceFor(DOLLAR_SECRET, 'k'.repeat(64));
    await expect(service.verifyManifest(store, await stored(store, desktopKey(escaped(DOLLAR_SECRET)), 'old'))).rejects.toThrow('Backup manifest signature is invalid');
  });
});
