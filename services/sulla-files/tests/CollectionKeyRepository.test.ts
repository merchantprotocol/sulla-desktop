// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Runs the collection-key and key-state SQL against real Postgres (SULLA_FILES_TEST_DATABASE_URL).
// Own random schema; applies the real 007/011/017 migrations.
import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FilesKeyring, FilesMasterKeyRejectedError } from '../src/keyring.js';
import { CollectionKeyRepository } from '../src/Repositories/CollectionKeyRepository.js';
import { FilesKeyStateRepository } from '../src/Repositories/FilesKeyStateRepository.js';
import { KeyTablesSchema } from './support/KeyTablesSchema.js';

import type { Envelope } from '../src/crypto.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const envelope = (tag:string):Envelope => ({ version: 1, algorithm: 'xchacha20-poly1305', nonce: `n-${ tag }`, ciphertext: `c-${ tag }` });

describe.skipIf(!databaseUrl)('collection keys and key state (real Postgres)', () => {
  const schema = new KeyTablesSchema(databaseUrl ?? '');
  const keys = new CollectionKeyRepository(schema.pool);
  const state = new FilesKeyStateRepository(schema.pool);

  beforeAll(async() => { await schema.create() });
  afterAll(async() => { await schema.drop() });
  beforeEach(async() => { await schema.reset() });

  it('stores random and legacy keys with the right origin and reads them back by collection', async() => {
    // risk: data accuracy — a wrong origin routes a collection to the wrong sync/recovery path.
    const random = await schema.collection('u1');
    const legacy = await schema.collection('u1');
    await keys.insertRandomKeys(schema.pool, random, envelope('d1'), envelope('k1'));
    await keys.insertLegacySigningKeys(schema.pool, legacy, envelope('d2'), envelope('k2'));
    expect(await keys.findWrappedKeys(random)).toEqual({ data_key: envelope('d1'), dedup_key: envelope('k1') });
    expect(await keys.findKeyOrigin(random)).toBe('random');
    expect(await keys.findKeyOrigin(legacy)).toBe('legacy-signing-v1');
    expect(await keys.findWrappedKeys(await schema.collection('u1'))).toBeUndefined();
    await expect(keys.insertRandomKeys(schema.pool, random, envelope('x'), envelope('y'))).rejects.toThrow();
  });

  it('limits unlock verification and recovery listings to published, non-legacy-source collections', async() => {
    // risk: tenant/data scope — unpublished or legacy-source keys must never be verified or replaced.
    const published = await schema.collection('u1');
    const unpublished = await schema.collection('u1', { published: false });
    const legacySource = await schema.collection('u1', { legacySource: true });
    for (const id of [published, unpublished, legacySource]) await keys.insertRandomKeys(schema.pool, id, envelope(id), envelope(id));
    expect((await keys.publishedWrappedKeys()).map(row => row.collection_id)).toEqual([published]);
    expect(await keys.publishedKeyOrigins()).toEqual([{ collection_id: published, key_origin: 'random' }]);
    expect(await keys.publishedCollectionStates()).toEqual([{ collection_id: published, key_origin: 'random', owner_user_id: 'u1', compatibility_state: 'native' }]);
  });

  it('lists only native published collections, keyed or not, ordered by id for the legacy key migration', async() => {
    // risk: data accuracy — external/legacy collections must stay unkeyed until the secure import.
    const native = [await schema.collection('u1'), await schema.collection('u1')].sort();
    await schema.collection('u1', { compatibility: 'legacy-external-data' });
    await keys.insertRandomKeys(schema.pool, native[1], envelope('d'), envelope('k'));
    const rows = await keys.lockNativeCollectionsForLegacyMigration();
    expect(rows.map(row => row.id)).toEqual(native);
    expect(rows[0]).toMatchObject({ data_key: null, dedup_key: null, key_origin: null });
    expect(rows[1]).toMatchObject({ data_key: envelope('d'), key_origin: 'random' });
  });

  it('replaces wrapped keys for one collection only', async() => {
    // risk: data loss — a recovery rewrite must not touch other collections' envelopes.
    const a = await schema.collection('u1'); const b = await schema.collection('u1');
    await keys.insertRandomKeys(schema.pool, a, envelope('a'), envelope('a'));
    await keys.insertRandomKeys(schema.pool, b, envelope('b'), envelope('b'));
    await keys.replaceWrappedKeys(schema.pool, a, envelope('a2'), envelope('a3'));
    expect(await keys.findWrappedKeys(a)).toEqual({ data_key: envelope('a2'), dedup_key: envelope('a3') });
    expect(await keys.findWrappedKeys(b)).toEqual({ data_key: envelope('b'), dedup_key: envelope('b') });
  });

  it('reads the key context and lists only owned native random collections', async() => {
    // risk: tenant isolation — custody enrollment must only enroll the principal's own random-key collections.
    const mine = await schema.collection('owner');
    const legacyKey = await schema.collection('owner');
    const external = await schema.collection('owner', { compatibility: 'legacy-external-data' });
    const theirs = await schema.collection('other');
    await keys.insertRandomKeys(schema.pool, mine, envelope('1'), envelope('1'));
    await keys.insertLegacySigningKeys(schema.pool, legacyKey, envelope('2'), envelope('2'));
    await keys.insertRandomKeys(schema.pool, external, envelope('3'), envelope('3'));
    await keys.insertRandomKeys(schema.pool, theirs, envelope('4'), envelope('4'));
    expect(await keys.ownedRandomCollectionIds('owner')).toEqual([mine]);
    const context = { collection_id: mine, owner_user_id: 'owner', compatibility_state: 'native', key_origin: 'random', key_version: 1, key_epoch: 1 };
    expect(await keys.findKeyContext(mine)).toEqual(context);
    const client = await schema.pool.connect();
    try {
      await client.query('BEGIN');
      expect(await keys.lockKeyContext(mine, client)).toEqual(context);
      await client.query('ROLLBACK');
    } finally { client.release() }
    expect(await keys.lockKeyContext(await schema.collection('owner'))).toBeUndefined();
  });

  it('inserts the verifier once and lets device recovery replace it', async() => {
    // risk: security — first unlock must never silently overwrite an existing master verifier.
    expect(await state.findVerifier()).toBeUndefined();
    await state.insertVerifier(schema.pool, envelope('v1'));
    await expect(state.insertVerifier(schema.pool, envelope('v2'))).rejects.toThrow();
    await state.upsertVerifier(schema.pool, envelope('v3'));
    expect(await state.findVerifier()).toEqual(envelope('v3'));
  });

  it('first unlock migrates native collections to the legacy signing-derived keys and rejects a different master later', async() => {
    // risk: data accuracy/security — the derived content keys must be byte-identical to the legacy scheme,
    // and a wrong master must be refused without touching stored keys.
    const id = await schema.collection('u1');
    const master = Buffer.alloc(32, 7); const signing = 'legacy-signing-key';
    const first = new FilesKeyring(schema.pool);
    await first.unlock(master, signing);
    const keys1 = await first.copyKeys(id); // copy: close() zeroes the cached key buffers
    expect(Buffer.from(keys1.data)).toEqual(createHmac('sha256', signing).update(`sulla:files:data-key:v1:${ id }`).digest());
    expect(Buffer.from(keys1.dedup)).toEqual(createHmac('sha256', signing).update(`sulla:files:dedup-key:v1:${ id }`).digest());
    expect(await keys.findKeyOrigin(id)).toBe('legacy-signing-v1');
    await expect(first.requireLegacySync(id)).resolves.toBeUndefined();
    first.close();

    const stored = await keys.findWrappedKeys(id);
    await expect(new FilesKeyring(schema.pool).unlock(Buffer.alloc(32, 9), signing)).rejects.toBeInstanceOf(FilesMasterKeyRejectedError);
    expect(await keys.findWrappedKeys(id)).toEqual(stored);

    const again = new FilesKeyring(schema.pool);
    await again.unlock(master, 'ignored-after-first-unlock');
    expect(Buffer.from((await again.keys(id)).data)).toEqual(Buffer.from(keys1.data));
    again.close();
  });

  it('refuses the first-unlock migration when a native collection already has keys, and commits nothing', async() => {
    // risk: data loss — existing key rows must never be re-derived; the transaction must roll back.
    const keyed = await schema.collection('u1');
    await keys.insertRandomKeys(schema.pool, keyed, envelope('d'), envelope('k'));
    await expect(new FilesKeyring(schema.pool).unlock(Buffer.alloc(32, 7), 'signing')).rejects.toThrow('Files key unlock failed; existing data was preserved');
    expect(await state.findVerifier()).toBeUndefined();
    expect(await keys.findWrappedKeys(keyed)).toEqual({ data_key: envelope('d'), dedup_key: envelope('k') });
  });
});
