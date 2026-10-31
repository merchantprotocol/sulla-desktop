// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

import { sealManifest, signHead, stateHash, type ManifestPlain, type StateEntry, type SyncHead } from './envelope.js';
import { CloudPuller, type ApplyRemoteInput, type ForkLocalInput, type LocalFileState, type PullRepository } from './pull.js';
import { commitStateHash } from './push.js';
import { parseManifestPlain, type RemoteVersion } from './validation.js';

const COLLECTION = '0b6f0c32-4d1e-4c8a-9a59-2f9f6d1e0a11';
const DEVICE = 'laptop';
const NOW = new Date('2026-10-23T18:30:00.000Z');

interface FakeFile { collectionId:string; path:string; current:string }
interface FakeVersion { fileId:string; chunks:string[]; deleted:boolean }

/** In-memory stand-in for PgCloudSyncRepository: content is the version's chunk list. */
class MemoryRepository implements PullRepository {
  files = new Map<string, FakeFile>();
  versions = new Map<string, FakeVersion>();
  cloudVersions = new Set<string>();
  heads = new Map<string, StateEntry>();
  journal:Array<{ fileId:string; versionId:string; op:string }> = [];
  conflicts = 0;
  writes = 0;
  savedHead?:SyncHead;

  async cloudHeads() { return [...this.heads.values()] }
  async hasLocalVersion(versionId:string) { return this.versions.has(versionId) }
  async isCloudVersion(versionId:string) { return this.cloudVersions.has(versionId) }
  async localFile(_collectionId:string, fileId:string):Promise<LocalFileState | null> {
    const file = this.files.get(fileId);
    if (!file) return null;
    return { path: file.path, currentVersionId: file.current, deleted: this.versions.get(file.current)?.deleted ?? false };
  }
  async forkLocalVersion(input:ForkLocalInput) {
    this.writes += 1;
    const source = this.versions.get(input.versionId)!;
    this.versions.set(input.newVersionId, { fileId: input.newFileId, chunks: [...source.chunks], deleted: false });
    this.files.set(input.newFileId, { collectionId: input.collectionId, path: input.path, current: input.newVersionId });
    this.journal.push({ fileId: input.newFileId, versionId: input.newVersionId, op: 'conflict' });
    this.conflicts += 1;
  }
  async applyRemoteVersion(input:ApplyRemoteInput) {
    this.writes += 1;
    const { remote } = input;
    this.versions.set(remote.versionId, { fileId: remote.fileId, chunks: input.content?.chunkIds ?? [], deleted: remote.deleted });
    const existing = this.files.get(remote.fileId);
    this.files.set(remote.fileId, { collectionId: input.collectionId, path: existing?.path ?? input.manifest.path, current: remote.versionId });
    this.cloudVersions.add(remote.versionId);
    this.heads.set(remote.fileId, { fileId: remote.fileId, versionId: remote.versionId, deleted: remote.deleted });
    this.journal.push({ fileId: remote.fileId, versionId: remote.versionId, op: remote.deleted ? 'delete' : 'put' });
  }
  async recordCloudHead(_collectionId:string, remote:RemoteVersion) {
    this.writes += 1;
    this.cloudVersions.add(remote.versionId);
    this.heads.set(remote.fileId, { fileId: remote.fileId, versionId: remote.versionId, deleted: remote.deleted });
  }
  async saveVerifiedHead(_collectionId:string, head:SyncHead) {
    this.writes += 1;
    this.savedHead = head;
  }
}

/** Remote content is identified by its cloud chunk ids. */
const remoteContent = {
  async materialize(_collectionId:string, _keyVersion:number, _root:Uint8Array, manifest:ManifestPlain) {
    const chunkIds = manifest.chunks.map(([id]) => `remote:${ id }`);
    return { chunkIds, chunks: chunkIds.map(id => ({ id, size: 1, storedSize: 1 })) };
  },
};

function manifestFor(path:string, parentVersionId:string | null, content:string):ManifestPlain {
  const bytes = Buffer.from(content);
  return {
    v: 1, path, mime: 'text/plain', size: bytes.length, mtime: NOW.toISOString(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    chunks: [[createHash('sha256').update(`id:${ content }`).digest('hex'), bytes.length]],
    deleted: false, parentVersionId,
  };
}

async function remoteVersion(root:Uint8Array, fileId:string, versionId:string, parentVersionId:string | null, seq:number, content:string) {
  const manifest = manifestFor('notes.txt', parentVersionId, content);
  return {
    fileId, versionId, parentVersionId, deleted: false, seq, deviceId: 'other-device', createdAt: NOW.toISOString(),
    manifest: await sealManifest(root, COLLECTION, 1, fileId, versionId, manifest),
    chunkIds: manifest.chunks.map(([id]) => id),
  };
}

/** Collection where file F was pushed at seq 1 as V0, plus a valid seq-1 head. */
async function fixture() {
  const root = new Uint8Array(randomBytes(32));
  const fileId = randomUUID();
  const v0 = randomUUID();
  const repository = new MemoryRepository();
  repository.files.set(fileId, { collectionId: COLLECTION, path: 'notes.txt', current: v0 });
  repository.versions.set(v0, { fileId, chunks: ['local:v0'], deleted: false });
  repository.cloudVersions.add(v0);
  repository.heads.set(fileId, { fileId, versionId: v0, deleted: false });
  const head1 = await signHead(root, { collectionId: COLLECTION, keyVersion: 1, seq: 1, stateHash: await stateHash([...repository.heads.values()]), prevMac: '' });
  return { root, fileId, v0, repository, head1 };
}

function puller(repository:MemoryRepository, pages:Array<{ versions:unknown[]; head:SyncHead }>) {
  const api = { changes: async() => pages.shift() ?? { versions: [], head: pages.at(-1)!.head } };
  return new CloudPuller(api, repository, remoteContent, DEVICE, () => NOW);
}

test('conflict keeps both: the unpushed local edit becomes a conflicted copy with its own content, remote lands on the original', async() => {
  const { root, fileId, v0, repository, head1 } = await fixture();
  const v1 = randomUUID();
  repository.versions.set(v1, { fileId, chunks: ['local:v1-edit'], deleted: false });
  repository.files.get(fileId)!.current = v1;
  const v2 = randomUUID();
  const remote = await remoteVersion(root, fileId, v2, v0, 2, 'remote edit');
  const head2 = await signHead(root, {
    collectionId: COLLECTION, keyVersion: 1, seq: 2, prevMac: head1.mac,
    stateHash: await stateHash([{ fileId, versionId: v2, deleted: false }]),
  });

  const result = await puller(repository, [{ versions: [remote], head: head2 }]).pull({ collectionId: COLLECTION, keyVersion: 1, lastSeq: 1, head: head1 }, root);

  assert.equal(result.conflicts, 1);
  const original = repository.files.get(fileId)!;
  assert.equal(original.current, v2);
  assert.deepEqual(repository.versions.get(v2)!.chunks, [`remote:${ remote.chunkIds[0] }`]);
  const copies = [...repository.files.entries()].filter(([id]) => id !== fileId);
  assert.equal(copies.length, 1);
  const [copyId, copy] = copies[0];
  assert.equal(copy.path, 'notes (conflicted copy laptop 2026-10-23 1830).txt');
  assert.deepEqual(repository.versions.get(copy.current)!.chunks, ['local:v1-edit']);
  assert.notEqual(copy.current, v1);
  assert.ok(repository.journal.some(entry => entry.fileId === copyId && entry.op === 'conflict'));
  assert.equal(repository.versions.get(v1)!.chunks[0], 'local:v1-edit', 'the original local version is never rewritten');
});

test('a remote version on top of an already-pushed local version applies without a copy', async() => {
  const { root, fileId, v0, repository, head1 } = await fixture();
  const v2 = randomUUID();
  const remote = await remoteVersion(root, fileId, v2, v0, 2, 'remote edit');
  const head2 = await signHead(root, {
    collectionId: COLLECTION, keyVersion: 1, seq: 2, prevMac: head1.mac,
    stateHash: await stateHash([{ fileId, versionId: v2, deleted: false }]),
  });
  const result = await puller(repository, [{ versions: [remote], head: head2 }]).pull({ collectionId: COLLECTION, keyVersion: 1, lastSeq: 1, head: head1 }, root);
  assert.equal(result.conflicts, 0);
  assert.equal(repository.files.size, 1);
  assert.equal(repository.files.get(fileId)!.current, v2);
});

test('head rollback, fork and omission are refused before any local write', async() => {
  const { root, fileId, v0, repository, head1 } = await fixture();
  const state = await stateHash([...repository.heads.values()]);
  const head2 = await signHead(root, { collectionId: COLLECTION, keyVersion: 1, seq: 2, stateHash: state, prevMac: head1.mac });

  // Rollback: server serves the older seq-1 head after we verified seq 2.
  await assert.rejects(
    puller(repository, [{ versions: [], head: head1 }]).pull({ collectionId: COLLECTION, keyVersion: 1, lastSeq: 2, head: head2 }, root),
    /rollback/,
  );
  // Fork: a validly signed seq-2 head that does not chain to the seq-1 head we hold.
  const forked = await signHead(root, { collectionId: COLLECTION, keyVersion: 1, seq: 2, stateHash: state, prevMac: 'f'.repeat(64) });
  await assert.rejects(
    puller(repository, [{ versions: [], head: forked }]).pull({ collectionId: COLLECTION, keyVersion: 1, lastSeq: 1, head: head1 }, root),
    /fork/,
  );
  // Same seq, different head.
  await assert.rejects(
    puller(repository, [{ versions: [], head: forked }]).pull({ collectionId: COLLECTION, keyVersion: 1, lastSeq: 2, head: head2 }, root),
    /fork/,
  );
  // Omission: the head covers a version the server did not list.
  const v2 = randomUUID();
  const hidden = await signHead(root, {
    collectionId: COLLECTION, keyVersion: 1, seq: 2, prevMac: head1.mac,
    stateHash: await stateHash([{ fileId, versionId: v2, deleted: false }]),
  });
  await assert.rejects(
    puller(repository, [{ versions: [], head: hidden }]).pull({ collectionId: COLLECTION, keyVersion: 1, lastSeq: 1, head: head1 }, root),
    /state/,
  );
  // Forged MAC.
  await assert.rejects(
    puller(repository, [{ versions: [], head: { ...head2, mac: '0'.repeat(64) } }]).pull({ collectionId: COLLECTION, keyVersion: 1, lastSeq: 1, head: head1 }, root),
    /MAC/,
  );
  assert.equal(repository.writes, 0);
  assert.equal(repository.files.get(fileId)!.current, v0);
});

test('pull state hash is checked against cloud heads, not local files with unpushed edits', async() => {
  const { root, fileId, repository, head1 } = await fixture();
  const unpushed = randomUUID();
  repository.versions.set(unpushed, { fileId, chunks: ['local:unpushed'], deleted: false });
  repository.files.get(fileId)!.current = unpushed;
  const result = await puller(repository, [{ versions: [], head: head1 }]).pull({ collectionId: COLLECTION, keyVersion: 1, lastSeq: 1, head: head1 }, root);
  assert.equal(result.applied, 0);
  assert.equal(repository.savedHead?.seq, 1);
});

test('commit stateHash has one entry per file: the committed version replaces only its own file', async() => {
  const a = randomUUID(), b = randomUUID();
  const aOld = randomUUID(), aNew = randomUUID(), bDeleted = randomUUID();
  const heads:StateEntry[] = [
    { fileId: a, versionId: aOld, deleted: false },
    { fileId: b, versionId: bDeleted, deleted: true },
  ];
  const expected = await stateHash([{ fileId: a, versionId: aNew, deleted: false }, { fileId: b, versionId: bDeleted, deleted: true }]);
  assert.equal(await commitStateHash(heads, { fileId: a, versionId: aNew, deleted: false }), expected);
  // Listing a superseded version too (the old bug: hashing every pushed version row) must not match.
  assert.notEqual(await stateHash([...heads, { fileId: a, versionId: aNew, deleted: false }]), expected);
  const c = randomUUID(), cNew = randomUUID();
  assert.equal(
    await commitStateHash(heads, { fileId: c, versionId: cNew, deleted: false }),
    await stateHash([...heads, { fileId: c, versionId: cNew, deleted: false }]),
  );
});


test('legacy singleton zero-byte chunk parses and applies as a canonical empty file', async() => {
  const root = new Uint8Array(randomBytes(32));
  const fileId = randomUUID(), versionId = randomUUID();
  const legacyChunkId = 'a'.repeat(64);
  const manifest = parseManifestPlain({
    v: 1, path: 'empty.txt', mime: 'text/plain', size: 0, mtime: NOW.toISOString(),
    sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
    chunks: [[legacyChunkId, 0]], deleted: false, parentVersionId: null,
  });
  const remote = {
    fileId, versionId, parentVersionId: null, deleted: false, seq: 1, deviceId: 'cloud', createdAt: NOW.toISOString(),
    manifest: await sealManifest(root, COLLECTION, 1, fileId, versionId, manifest), chunkIds: [legacyChunkId],
  };
  const repository = new MemoryRepository();
  const head = await signHead(root, {
    collectionId: COLLECTION, keyVersion: 1, seq: 1, prevMac: '',
    stateHash: await stateHash([{ fileId, versionId, deleted: false }]),
  });
  const seen:ManifestPlain[] = [];
  const content = {
    async materialize(_collectionId:string, _keyVersion:number, _root:Uint8Array, opened:ManifestPlain) {
      seen.push(opened);
      return { chunkIds: [], chunks: [] };
    },
  };
  const api = { changes: async() => ({ versions: [remote], head }) };
  const result = await new CloudPuller(api, repository, content, DEVICE, () => NOW)
    .pull({ collectionId: COLLECTION, keyVersion: 1, lastSeq: 0, head: null }, root);

  assert.equal(result.applied, 1);
  assert.deepEqual(seen[0].chunks, [], 'legacy zero-byte chunk is not downloaded');
  assert.deepEqual(repository.versions.get(versionId)?.chunks, []);
});

test('a zero-byte chunk remains invalid when the manifest declares non-empty content', () => {
  assert.throws(() => parseManifestPlain({
    v: 1, path: 'not-empty.txt', mime: 'text/plain', size: 1, mtime: NOW.toISOString(),
    sha256: 'b'.repeat(64), chunks: [['a'.repeat(64), 0]], deleted: false, parentVersionId: null,
  }), /chunk size invalid/);
});
