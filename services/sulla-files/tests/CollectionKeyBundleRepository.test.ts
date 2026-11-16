// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Runs the custody key-bundle and remote-recovery SQL against real Postgres (SULLA_FILES_TEST_DATABASE_URL).
// Own random schema; applies the real 007/011/017 migrations.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CollectionKeyBundleRepository, type StoredFilesKeyBundle } from '../src/Repositories/CollectionKeyBundleRepository.js';
import { CollectionKeyRepository } from '../src/Repositories/CollectionKeyRepository.js';
import { RemoteKeyRecoveryRepository } from '../src/Repositories/RemoteKeyRecoveryRepository.js';
import { KeyTablesSchema } from './support/KeyTablesSchema.js';

import type { FilesKeyBundleEnvelope } from '@sulla/vault-crypto';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const wrapped = { version: 1 as const, algorithm: 'xchacha20-poly1305' as const, nonce: 'n', ciphertext: 'c' };
const opaque = (tag:string) => ({ tag }) as unknown as FilesKeyBundleEnvelope;

describe.skipIf(!databaseUrl)('collection key bundles and remote key recovery (real Postgres)', () => {
  const schema = new KeyTablesSchema(databaseUrl ?? '');
  const bundles = new CollectionKeyBundleRepository(schema.pool);
  const keys = new CollectionKeyRepository(schema.pool);
  const remote = new RemoteKeyRecoveryRepository(schema.pool);
  const bundle = (collectionId:string, principalId:string, tag:string, keyVersion = 1, epoch = 1):StoredFilesKeyBundle => ({
    context: { collectionId, principalId, keyVersion, epoch }, authorityKeyId: `authority-${ tag }`, envelope: opaque(tag),
  });

  beforeAll(async() => { await schema.create() });
  afterAll(async() => { await schema.drop() });
  beforeEach(async() => { await schema.reset() });

  it('keeps the first persisted bundle for a context when concurrent enrollments race', async() => {
    // risk: data accuracy — only the immutable persisted envelope may ever be registered with Vault.
    const id = await schema.collection('p1');
    await bundles.insertIfAbsent(bundle(id, 'p1', 'winner'));
    await bundles.insertIfAbsent(bundle(id, 'p1', 'loser'));
    expect(await bundles.find(bundle(id, 'p1', 'x').context)).toEqual(bundle(id, 'p1', 'winner'));
    expect(await bundles.find(bundle(id, 'p1', 'x', 2).context)).toBeUndefined();
    expect(await bundles.find(bundle(id, 'p2', 'x').context)).toBeUndefined();
  });

  it('records the first Vault registration time and never moves it', async() => {
    // risk: audit accuracy — re-registration must not rewrite when custody was first confirmed.
    const id = await schema.collection('p1');
    const { context } = bundle(id, 'p1', 'a');
    await bundles.insertIfAbsent(bundle(id, 'p1', 'a'));
    await bundles.markRegistered(context);
    const first = (await schema.pool.query('SELECT authority_registered_at FROM files_collection_key_bundles WHERE collection_id=$1', [id])).rows[0].authority_registered_at;
    expect(first).toBeInstanceOf(Date);
    await new Promise(resolve => setTimeout(resolve, 5));
    await bundles.markRegistered(context);
    const second = (await schema.pool.query('SELECT authority_registered_at FROM files_collection_key_bundles WHERE collection_id=$1', [id])).rows[0].authority_registered_at;
    expect(second.getTime()).toBe(first.getTime());
  });

  it('returns only bundles matching the current key context of the principal\'s native random collections', async() => {
    // risk: security/tenant isolation — device recovery must use current-epoch bundles of the owner only.
    const mine = await schema.collection('p1');
    const stale = await schema.collection('p1');
    const theirs = await schema.collection('p2');
    const unpublished = await schema.collection('p1', { published: false });
    for (const id of [mine, stale, theirs, unpublished]) await keys.insertRandomKeys(schema.pool, id, wrapped, wrapped);
    await schema.pool.query('UPDATE files_collection_keys SET key_epoch=2 WHERE collection_id=$1', [stale]);
    await bundles.insertIfAbsent(bundle(mine, 'p1', 'mine'));
    await bundles.insertIfAbsent(bundle(stale, 'p1', 'stale-epoch-1'));
    await bundles.insertIfAbsent(bundle(theirs, 'p2', 'theirs'));
    await bundles.insertIfAbsent(bundle(unpublished, 'p1', 'unpublished'));
    expect(await bundles.currentBundlesForPrincipal('p1')).toEqual([bundle(mine, 'p1', 'mine')]);
    await bundles.insertIfAbsent(bundle(stale, 'p1', 'stale-epoch-2', 1, 2));
    // Ordered by collection id (uuid order equals lowercase hex string order).
    const expected = [bundle(mine, 'p1', 'mine'), bundle(stale, 'p1', 'stale-epoch-2', 1, 2)]
      .sort((left, right) => (left.context.collectionId < right.context.collectionId ? -1 : 1));
    expect(await bundles.currentBundlesForPrincipal('p1')).toEqual(expected);
  });

  it('keeps one remote-recovery proof per collection and replaces it with the newest verification', async() => {
    // risk: data accuracy — online-only eviction trusts this row's exact key context.
    const id = await schema.collection('p1');
    await remote.recordVerified({ collectionId: id, principalId: 'p1', keyVersion: 1, epoch: 1 }, 'authority-1');
    await remote.recordVerified({ collectionId: id, principalId: 'p1', keyVersion: 1, epoch: 2 }, 'authority-2');
    const rows = (await schema.pool.query('SELECT principal_id,key_version,key_epoch,authority_key_id FROM files_remote_key_recovery')).rows;
    expect(rows).toEqual([{ principal_id: 'p1', key_version: 1, key_epoch: 2, authority_key_id: 'authority-2' }]);
  });
});
