// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes the single-file coherent backup format so the OOP move cannot change a byte of it.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupContainer, BackupFileDigest, type BackupManifest, type BackupObject } from '../src/backup/container.js';

const COLLECTION = '0b6f8c3e-4a1d-4c2b-9e7f-1a2b3c4d5e6f';
const sha = (value:Buffer | string) => createHash('sha256').update(value).digest('hex');

describe('coherent backup container', () => {
  let root = '';
  const container = new BackupContainer();
  const digest = new BackupFileDigest();

  beforeEach(async() => { root = await mkdtemp(join(tmpdir(), 'sulla-backup-container-spec-')) });
  afterEach(async() => { await rm(root, { recursive: true, force: true }) });

  async function fixture(chunkBytes = Buffer.from('ciphertext-bytes')) {
    const rows = Buffer.from('collections\t{"id":"x"}\n'); const evidence = Buffer.from('{"tables":[]}'); const chunkId = sha(chunkBytes);
    const sources = { rows: join(root, 'rows.jsonl'), evidence: join(root, 'evidence.json'), chunk: join(root, 'chunk.bin') };
    await writeFile(sources.rows, rows); await writeFile(sources.evidence, evidence); await writeFile(sources.chunk, chunkBytes);
    const objects:BackupObject[] = [
      { path: 'database/rows.jsonl', type: 'postgres-rows', sourcePath: sources.rows, ...await digest.sha256(sources.rows) },
      { path: 'schema/evidence.json', type: 'schema-evidence', sourcePath: sources.evidence, ...await digest.sha256(sources.evidence) },
      { path: `chunks/${ COLLECTION }/${ chunkId.slice(0, 2) }/${ chunkId }`, type: 'encrypted-chunk', sourcePath: sources.chunk, ...await digest.sha256(sources.chunk) },
    ];
    const manifest:BackupManifest = {
      format: 'sulla-files-coherent-backup', version: 1, createdAt: '2026-11-16T08:00:00.000Z', postgresVersion: '16.4', snapshotId: '100:100:',
      migrations: ['001_init.sql'], tables: [{ name: 'collections' }], excludedTableData: {}, entries: objects.map(({ sourcePath: _source, ...entry }) => entry),
    };
    return { rows, evidence, chunkBytes, objects, manifest };
  }

  // risk: data loss — archives written by older builds must stay readable, so the byte layout is fixed.
  it('writes MAGIC, a big-endian manifest length, the manifest JSON, then entry bytes in manifest order', async() => {
    const { rows, evidence, chunkBytes, objects, manifest } = await fixture();
    const archive = join(root, 'out', 'one.sulla-files-backup');
    await container.write(archive, manifest, objects);
    const bytes = await readFile(archive);
    const magic = Buffer.from('SULLA-FILES-BACKUP\n', 'ascii'); const json = Buffer.from(JSON.stringify(manifest));
    const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(json.length));
    expect(bytes.equals(Buffer.concat([magic, length, json, rows, evidence, chunkBytes]))).toBe(true);
  });

  // risk: data loss — a restore must get back exactly the bytes that were backed up.
  it('extracts every entry with its original bytes and manifest', async() => {
    const { chunkBytes, objects, manifest } = await fixture();
    const archive = join(root, 'one.sulla-files-backup');
    await container.write(archive, manifest, objects);
    const extracted = await container.extract(archive, join(root, 'extracted'));
    expect(extracted.manifest).toEqual(manifest);
    expect(await readFile(extracted.path(objects[2].path))).toEqual(chunkBytes);
    await extracted.cleanup();
    expect(existsSync(join(root, 'extracted'))).toBe(false);
  });

  // risk: silent corruption — a flipped ciphertext byte must fail the restore and leave no partial extraction.
  it('rejects an archive whose entry bytes no longer match the manifest digest', async() => {
    const { objects, manifest } = await fixture();
    const archive = join(root, 'one.sulla-files-backup');
    await container.write(archive, manifest, objects);
    const bytes = await readFile(archive); bytes[bytes.length - 1] ^= 0xff; await writeFile(archive, bytes);
    await expect(container.extract(archive, join(root, 'extracted'))).rejects.toThrow(/digest mismatch/);
    expect(existsSync(join(root, 'extracted'))).toBe(false);
  });

  // risk: path traversal — a manifest entry must never write outside the restore stage.
  it('refuses to write an entry whose path escapes the allowed layout', async() => {
    const { objects, manifest } = await fixture();
    manifest.entries[2] = { ...manifest.entries[2], path: '../../etc/passwd' }; objects[2] = { ...objects[2], path: '../../etc/passwd' };
    await expect(container.write(join(root, 'bad.sulla-files-backup'), manifest, objects)).rejects.toThrow(/Unsafe backup entry path/);
  });

  // risk: corrupt archive — objects copied out of manifest order would pair bytes with the wrong digest.
  it('refuses objects that are not in manifest order and leaves no temporary file', async() => {
    const { objects, manifest } = await fixture();
    await expect(container.write(join(root, 'out', 'bad.sulla-files-backup'), manifest, [objects[1], objects[0], objects[2]])).rejects.toThrow(/ordering mismatch/);
    expect(await readdir(join(root, 'out'))).toEqual([]);
  });
});
