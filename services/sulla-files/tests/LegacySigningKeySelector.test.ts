// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// First-unlock legacy key migration against real Postgres (SULLA_FILES_TEST_DATABASE_URL).
// Content written before PR #2369 on a `$` secret used keys derived from the compose-escaped
// Files key; the migration must wrap those keys so the stored chunks stay readable.
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityKeyCandidates } from '../src/CapabilityKeyCandidates.js';
import { chunkId, decryptAndVerifyChunk, encryptChunk } from '../src/crypto.js';
import { FilesKeyring } from '../src/keyring.js';
import { CollectionKeyRepository } from '../src/Repositories/CollectionKeyRepository.js';
import { LegacySigningKeySelector } from '../src/Services/LegacySigningKeySelector.js';
import { Store } from '../src/store.js';
import { KeyTablesSchema } from './support/KeyTablesSchema.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const desktopKey = (secret:string) => createHmac('sha256', secret).update('sulla-files-capability-v1').digest('hex');
const escaped = (secret:string) => secret.replace(/\$/g, '$$$$');
const DOLLAR_SECRET = 'pa$$w$rd-Real_Install_Secret';
const PLAIN_SECRET = 'Plain_Install_Secret_without_dollars';
const MASTER = Buffer.alloc(32, 7);

describe.skipIf(!databaseUrl)('legacy signing key selection at first unlock (real Postgres)', () => {
  const schema = new KeyTablesSchema(databaseUrl ?? '');
  const collectionKeys = new CollectionKeyRepository(schema.pool);
  let root = ''; let store:Store;

  beforeAll(async() => {
    await schema.create();
    // chunks exactly as 001_sulla_files.sql creates it.
    await schema.pool.query(`CREATE TABLE IF NOT EXISTS chunks (collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,id TEXT NOT NULL,size INTEGER NOT NULL CHECK(size>=0),stored_size INTEGER NOT NULL CHECK(stored_size>=0),location TEXT NOT NULL,refcount BIGINT NOT NULL DEFAULT 0 CHECK(refcount>=0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(collection_id,id))`);
  });
  afterAll(async() => { await schema.drop() });
  beforeEach(async() => { await schema.reset(); root = await mkdtemp(join(tmpdir(), 'sulla-legacy-key-spec-')); store = new Store(root) });
  afterEach(async() => { await rm(root, { recursive: true, force: true }) });

  /** A stored chunk encrypted with the legacy keys derived from `signingKey`, as pre-keychain Files wrote it. */
  async function writeChunk(collectionId:string, signingKey:string, plain = randomBytes(64)):Promise<{ id:string; plain:Buffer; envelope:Buffer }> {
    const data = LegacySigningKeySelector.dataKey(signingKey, collectionId); const dedup = LegacySigningKeySelector.dedupKey(signingKey, collectionId);
    const id = chunkId(plain, dedup);
    const envelope = await encryptChunk(plain, data, id);
    await store.put(collectionId, id, envelope);
    await schema.pool.query('INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,1)', [collectionId, id, plain.length, envelope.length, `chunks/${ collectionId }/${ id }`]);
    return { id, plain, envelope };
  }

  async function unlock(secret:string):Promise<FilesKeyring> {
    const keyring = new FilesKeyring(schema.pool, undefined, undefined, undefined, new LegacySigningKeySelector(store));
    await keyring.unlock(MASTER, CapabilityKeyCandidates.fromConfig({ capabilitySigningKey: desktopKey(secret), localToken: secret }));
    return keyring;
  }

  // risk: data loss — content written with the pre-#2369 key must stay readable after migration.
  it('wraps the old compose-escaped derivation for a collection whose chunks were written with it', async() => {
    const id = await schema.collection('u1');
    const chunk = await writeChunk(id, desktopKey(escaped(DOLLAR_SECRET)));
    const keyring = await unlock(DOLLAR_SECRET);
    const keys = await keyring.copyKeys(id);
    expect(Buffer.from(keys.data)).toEqual(LegacySigningKeySelector.dataKey(desktopKey(escaped(DOLLAR_SECRET)), id));
    expect(await decryptAndVerifyChunk(chunk.envelope, keys.data, keys.dedup, chunk.id, chunk.plain.length)).toEqual(chunk.plain);
    expect(await collectionKeys.findKeyOrigin(id)).toBe('legacy-signing-v1');
    keyring.close();
  });

  // risk: data accuracy — each collection gets the key its own content was written with.
  it('wraps the current derivation for content written with the current key, side by side with an old one', async() => {
    const fresh = await schema.collection('u1'); const old = await schema.collection('u1');
    await writeChunk(fresh, desktopKey(DOLLAR_SECRET)); await writeChunk(old, desktopKey(escaped(DOLLAR_SECRET)));
    const keyring = await unlock(DOLLAR_SECRET);
    expect(Buffer.from((await keyring.copyKeys(fresh)).data)).toEqual(LegacySigningKeySelector.dataKey(desktopKey(DOLLAR_SECRET), fresh));
    expect(Buffer.from((await keyring.copyKeys(old)).data)).toEqual(LegacySigningKeySelector.dataKey(desktopKey(escaped(DOLLAR_SECRET)), old));
    keyring.close();
  });

  // risk: security — a chunk encrypted under an unrelated key never selects the previous key.
  it('keeps the current key when no candidate decrypts the stored chunks or the collection has none', async() => {
    const foreign = await schema.collection('u1'); const empty = await schema.collection('u1');
    await writeChunk(foreign, desktopKey('someone-else$'));
    const keyring = await unlock(DOLLAR_SECRET);
    expect(Buffer.from((await keyring.copyKeys(foreign)).data)).toEqual(LegacySigningKeySelector.dataKey(desktopKey(DOLLAR_SECRET), foreign));
    expect(Buffer.from((await keyring.copyKeys(empty)).data)).toEqual(LegacySigningKeySelector.dataKey(desktopKey(DOLLAR_SECRET), empty));
    keyring.close();
  });

  // risk: data accuracy — a secret without $ derives exactly as before #2369.
  it('derives from the current key for a secret without $', async() => {
    const id = await schema.collection('u1');
    const chunk = await writeChunk(id, desktopKey(PLAIN_SECRET));
    const keyring = await unlock(PLAIN_SECRET);
    const keys = await keyring.copyKeys(id);
    expect(Buffer.from(keys.data)).toEqual(LegacySigningKeySelector.dataKey(desktopKey(PLAIN_SECRET), id));
    expect(await decryptAndVerifyChunk(chunk.envelope, keys.data, keys.dedup, chunk.id, chunk.plain.length)).toEqual(chunk.plain);
    keyring.close();
  });
});
