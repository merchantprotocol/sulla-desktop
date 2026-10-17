import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { chunkId, decryptChunk, encryptChunk } from './crypto.js';
import { convertLegacyManifest, readLegacyChunk } from './legacyImport.js';
import { Store } from './store.js';

const collectionId = '12345678-1234-4123-8123-123456789abc';
const shadowId = 'abcdefab-1234-4123-8123-abcdefabcdef';

async function fixture(parts:Buffer[]) {
  const root = await mkdtemp(join(tmpdir(), 'sulla-legacy-import-')); const sourceRoot = join(root, 'source'); const targetRoot = join(root, 'target');
  const sourceKeys = { data: randomBytes(32), dedup: randomBytes(32) }; const shadowKeys = { data: randomBytes(32), dedup: randomBytes(32) }; const ids:string[] = [];
  for (const part of parts) {
    const id = chunkId(part, sourceKeys.dedup); ids.push(id); const directory = join(sourceRoot, collectionId, id.slice(0, 2));
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, id), await encryptChunk(part, sourceKeys.data, id));
  }
  await mkdir(targetRoot, { recursive: true });
  return { root, sourceRoot, targetRoot, sourceKeys, shadowKeys, ids, parts };
}

test('multi-version import preserves ordered plaintext hashes with fresh identities and retry-safe output', async() => {
  const item = await fixture([Buffer.from('version one: '), Buffer.from('alpha'), Buffer.from('version two')]);
  try {
    const store = new Store(item.targetRoot);
    const first = await convertLegacyManifest({ collectionId, chunkIds: item.ids.slice(0, 2), totalSize: item.parts[0].length + item.parts[1].length, sourceRoot: item.sourceRoot, sourceKeys: item.sourceKeys, shadowKeys: item.shadowKeys, store, shadowCollectionId: shadowId });
    const second = await convertLegacyManifest({ collectionId, chunkIds: item.ids, totalSize: item.parts.reduce((sum, part) => sum + part.length, 0), sourceRoot: item.sourceRoot, sourceKeys: item.sourceKeys, shadowKeys: item.shadowKeys, store, shadowCollectionId: shadowId });
    const retry = await convertLegacyManifest({ collectionId, chunkIds: item.ids, totalSize: second.totalSize, sourceRoot: item.sourceRoot, sourceKeys: item.sourceKeys, shadowKeys: item.shadowKeys, store, shadowCollectionId: shadowId });
    assert.deepEqual(retry.ids, second.ids); assert.equal(retry.hash, second.hash); assert.notDeepEqual(second.ids, item.ids);
    const restored:Buffer[] = [];
    for (const id of second.ids) restored.push(Buffer.from(await decryptChunk(await store.get(shadowId, id), item.shadowKeys.data, id)));
    assert.deepEqual(Buffer.concat(restored), Buffer.concat(item.parts)); assert.notEqual(first.plaintextHash, second.plaintextHash);
  } finally { item.sourceKeys.data.fill(0); item.sourceKeys.dedup.fill(0); item.shadowKeys.data.fill(0); item.shadowKeys.dedup.fill(0); await rm(item.root, { recursive: true }) }
});

test('corrupt, missing, wrong-key, and linked source chunks fail closed', async() => {
  const item = await fixture([Buffer.from('authenticated synthetic content')]); const sourcePath = join(item.sourceRoot, collectionId, item.ids[0].slice(0, 2), item.ids[0]);
  try {
    const store = new Store(item.targetRoot); const common = { collectionId, chunkIds: item.ids, totalSize: item.parts[0].length, sourceRoot: item.sourceRoot, shadowKeys: item.shadowKeys, store, shadowCollectionId: shadowId };
    const linkedRoot = join(item.root, 'linked-root'); await symlink(item.sourceRoot, linkedRoot, 'dir');
    await assert.rejects(readLegacyChunk(linkedRoot, collectionId, item.ids[0]), /ELOOP|linked|symbolic/i);
    await assert.rejects(convertLegacyManifest({ ...common, sourceKeys: { data: randomBytes(32), dedup: item.sourceKeys.dedup } }), /decrypt|cipher|import/i);
    const original = await readLegacyChunk(item.sourceRoot, collectionId, item.ids[0]);
    await writeFile(sourcePath, Buffer.concat([original.subarray(0, original.length - 1), Buffer.from([original.at(-1)! ^ 1])]));
    await assert.rejects(convertLegacyManifest({ ...common, sourceKeys: item.sourceKeys }));
    await rm(sourcePath); await assert.rejects(convertLegacyManifest({ ...common, sourceKeys: item.sourceKeys }), /does not exist|ENOENT/);
    const outside = join(item.root, 'outside'); await writeFile(outside, original); await symlink(outside, sourcePath);
    await assert.rejects(convertLegacyManifest({ ...common, sourceKeys: item.sourceKeys }), /ELOOP|linked|symbolic/i);
  } finally { item.sourceKeys.data.fill(0); item.sourceKeys.dedup.fill(0); item.shadowKeys.data.fill(0); item.shadowKeys.dedup.fill(0); await rm(item.root, { recursive: true }) }
});

test('source casing is preserved and ambiguous case-folded directories fail closed', async() => {
  const item = await fixture([Buffer.from('case-sensitive source')]);
  const upper = collectionId.toUpperCase();
  try {
    await rename(join(item.sourceRoot, collectionId), join(item.sourceRoot, upper));
    assert.ok((await readLegacyChunk(item.sourceRoot, collectionId, item.ids[0])).length > 0);
    const duplicate = join(item.sourceRoot, collectionId, item.ids[0].slice(0, 2));
    await mkdir(duplicate, { recursive: true });
    await writeFile(join(duplicate, item.ids[0]), await encryptChunk(item.parts[0], item.sourceKeys.data, item.ids[0]));
    await assert.rejects(readLegacyChunk(item.sourceRoot, collectionId, item.ids[0]), /ambiguous collection identities/);
  } finally { item.sourceKeys.data.fill(0); item.sourceKeys.dedup.fill(0); item.shadowKeys.data.fill(0); item.shadowKeys.dedup.fill(0); await rm(item.root, { recursive: true }) }
});
