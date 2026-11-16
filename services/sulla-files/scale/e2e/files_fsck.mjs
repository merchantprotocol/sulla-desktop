// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Files integrity checker (fsck). Runs INSIDE the sulla_files container (it uses the service's own
// `pg` module, database URL and chunk volume), normally piped in by files_fsck.py:
//
//   docker exec -i -w /app/services/sulla-files -e FSCK_OPTS='{"deep":true}' sulla_files node --input-type=module - < files_fsck.mjs
//
// Default mode is READ-ONLY: it never writes the database or the chunk store. For every non-deleted
// file it checks the current version the way the content read path does (fileStream.ts descriptor):
// version row -> manifest row -> chunk geometry -> `chunks` metadata rows -> the encrypted blob on
// disk (exact stored size). --deep also parses every blob's encryption envelope. It cannot decrypt
// (the key only exists inside the unlocked service); files_fsck.py --mount proves decryption by
// reading files back through the Files mount.
//
// Repair is opt-in ({"repair":true}) and never deletes anything:
//   * chunk_row_missing with the blob still on disk (the build #1 retry bug) -> re-register the
//     `chunks` row for the existing blob. Lossless: the content was never gone, only its metadata.
//   * anything unrecoverable is only reported, unless {"rollbackUnrecoverable":true}: then a NEW
//     version restoring the newest readable ancestor is added. The broken version stays in history.
// Every action is printed as a JSONL `repair` record and written to audit_log ('files-fsck-repair').
// Output: JSONL on stdout. Records: {"type":"problem"|"repair"|"progress"|"summary"|"error",...}.
// Never prints file content or keys.

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const CHUNK_BYTES = 4 * 1024 * 1024;
const ZSTD_BLOCK_BYTES = 128 * 1024;
const EMPTY_ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({ version: 1, algorithm: 'xchacha20-poly1305', nonce: '', ciphertext: '' }));
const b64Length = length => Math.ceil(length * 4 / 3);
/** Same bound as crypto.ts maxEncryptedChunkBytes (zstd bound + AEAD tag + envelope). */
export function maxEncryptedChunkBytes(plainBytes) {
  const compressed = plainBytes + Math.floor(plainBytes / 256) + (plainBytes < ZSTD_BLOCK_BYTES ? Math.floor((ZSTD_BLOCK_BYTES - plainBytes) / 2048) : 0);
  return EMPTY_ENVELOPE_BYTES + b64Length(24) + b64Length(compressed + 16);
}
const CHUNK_ID = /^[a-f0-9]{64}$/;

/** Writes one JSON object per line. */
class JsonlOutput {
  constructor(stream) { this.stream = stream }
  write(record) { this.stream.write(`${ JSON.stringify(record) }\n`) }
}

/** The encrypted chunk store on disk (store.ts layout: <root>/<collection>/<id[0:2]>/<id>). */
class ChunkBlobStore {
  constructor(root) { this.root = root }
  path(collectionId, id) {
    if (!CHUNK_ID.test(id) || !/^[\w-]+$/.test(collectionId)) return undefined;
    return join(this.root, collectionId, id.slice(0, 2), id);
  }
  /** Stored size, or undefined when the blob is not on disk. Never follows symlinks. */
  async size(collectionId, id) {
    const path = this.path(collectionId, id);
    if (!path) return undefined;
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      return info.isFile() ? info.size : undefined;
    } catch { return undefined } finally { await handle?.close() }
  }
  /** Structural check of the encryption envelope (no key needed): JSON, xchacha20, 24-byte nonce, tag present. */
  async envelopeProblem(collectionId, id, expectedBytes) {
    const path = this.path(collectionId, id);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const bytes = Buffer.alloc(expectedBytes);
      let offset = 0;
      while (offset < expectedBytes) {
        const { bytesRead } = await handle.read(bytes, offset, expectedBytes - offset, offset);
        if (!bytesRead) return 'short_read';
        offset += bytesRead;
      }
      const envelope = JSON.parse(bytes.toString('utf8'));
      if (envelope?.version !== 1 || envelope?.algorithm !== 'xchacha20-poly1305') return 'bad_envelope_header';
      if (Buffer.from(String(envelope.nonce), 'base64url').length !== 24) return 'bad_nonce';
      if (Buffer.from(String(envelope.ciphertext), 'base64url').length < 16) return 'ciphertext_too_short';
      return undefined;
    } catch (error) { return error instanceof SyntaxError ? 'envelope_not_json' : `read_failed:${ error?.code ?? 'error' }` } finally { await handle?.close() }
  }
}

/** Read-only queries. Every query is bounded (keyset pages, ANY() over one page of ids). */
class FilesCatalog {
  constructor(db) { this.db = db }
  async hasTable(name) { return Boolean((await this.db.query('SELECT to_regclass($1) IS NOT NULL ok', [name])).rows[0].ok) }
  async page(after, limit, collectionId) {
    return (await this.db.query(`SELECT f.id::text file_id,f.collection_id::text,f.path,f.current_version_id::text,c.explorer_path,
        v.id::text version_id,v.file_id::text version_file_id,v.chunk_collection_id::text,v.size version_size,v.deleted version_deleted,v.manifest_hash,
        m.hash IS NOT NULL manifest_exists,m.chunk_ids,m.total_size
      FROM files f JOIN collections c ON c.id=f.collection_id
      LEFT JOIN file_versions v ON v.id=f.current_version_id
      LEFT JOIN manifests m ON m.hash=v.manifest_hash
      WHERE f.deleted_at IS NULL AND f.id>$1::uuid AND ($3::uuid IS NULL OR f.collection_id=$3::uuid)
      ORDER BY f.id LIMIT $2`, [after, limit, collectionId ?? null])).rows;
  }
  async chunkRows(pairs) {
    if (!pairs.length) return new Map();
    const rows = (await this.db.query(`SELECT c.collection_id::text,c.id,c.size,c.stored_size,c.refcount FROM chunks c
      JOIN unnest($1::uuid[],$2::text[]) want(collection_id,id) ON want.collection_id=c.collection_id AND want.id=c.id`,
    [pairs.map(pair => pair[0]), pairs.map(pair => pair[1])])).rows;
    return new Map(rows.map(row => [`${ row.collection_id }:${ row.id }`, row]));
  }
  async cacheStates(pairs, enabled) {
    if (!enabled || !pairs.length) return new Map();
    const rows = (await this.db.query(`SELECT k.collection_id::text,k.chunk_id,k.state FROM files_chunk_cache k
      JOIN unnest($1::uuid[],$2::text[]) want(collection_id,id) ON want.collection_id=k.collection_id AND want.id=k.chunk_id`,
    [pairs.map(pair => pair[0]), pairs.map(pair => pair[1])])).rows;
    return new Map(rows.map(row => [`${ row.collection_id }:${ row.chunk_id }`, row.state]));
  }
  async version(fileId, versionId) {
    return (await this.db.query(`SELECT v.id::text version_id,v.file_id::text version_file_id,v.parent_version_id::text,v.chunk_collection_id::text,v.size version_size,
        v.deleted version_deleted,v.manifest_hash,m.hash IS NOT NULL manifest_exists,m.chunk_ids,m.total_size
      FROM file_versions v LEFT JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1 AND v.file_id=$2`, [versionId, fileId])).rows[0];
  }
}

/** Checks one version the way fileStream.ts descriptor() + streamFileContent() would read it. */
class VersionInspector {
  constructor(catalog, blobs, options) { this.catalog = catalog; this.blobs = blobs; this.options = options }

  /** Problems of the version row itself (no chunk lookups). */
  static rowProblems(row, fileId) {
    if (!row.version_id) return [{ class: 'version_missing' }];
    if (row.version_file_id !== fileId) return [{ class: 'version_wrong_file' }];
    if (row.version_deleted) return [{ class: 'version_deleted' }];
    if (!row.manifest_hash || !row.manifest_exists) return [{ class: 'manifest_missing', manifestHash: row.manifest_hash ?? null }];
    const ids = Array.isArray(row.chunk_ids) ? row.chunk_ids.map(String) : [];
    const declared = Number(row.version_size);
    const expected = Math.max(1, Math.ceil(declared / CHUNK_BYTES));
    if (!Number.isSafeInteger(declared) || declared < 0 || ids.length !== expected || Number(row.total_size) !== declared) {
      return [{ class: 'manifest_geometry_invalid', chunks: ids.length, expectedChunks: expected, totalSize: Number(row.total_size), versionSize: declared }];
    }
    return [];
  }

  static plannedChunks(row) {
    const ids = row.chunk_ids.map(String); const declared = Number(row.version_size);
    return ids.map((id, index) => ({ id, size: index < ids.length - 1 ? CHUNK_BYTES : declared - CHUNK_BYTES * (ids.length - 1) }));
  }

  /** Chunk-level problems for many versions at once; returns Map<versionId, problem[]>. */
  async chunkProblems(rows) {
    const pairs = new Map();
    for (const row of rows) for (const chunk of VersionInspector.plannedChunks(row)) pairs.set(`${ row.chunk_collection_id }:${ chunk.id }`, [row.chunk_collection_id, chunk.id]);
    const list = [...pairs.values()];
    const metadata = await this.catalog.chunkRows(list);
    const cache = await this.catalog.cacheStates(list, this.options.cacheTable);
    const blobSizes = new Map();
    for (const [key, [collectionId, id]] of pairs) blobSizes.set(key, await this.blobs.size(collectionId, id));
    const envelopes = new Map();
    const result = new Map();
    for (const row of rows) {
      const problems = [];
      for (const chunk of VersionInspector.plannedChunks(row)) {
        const key = `${ row.chunk_collection_id }:${ chunk.id }`;
        const meta = metadata.get(key); const blob = blobSizes.get(key); const cacheState = cache.get(key);
        if (!CHUNK_ID.test(chunk.id)) { problems.push({ class: 'chunk_id_invalid', chunkId: chunk.id }); continue }
        if (!meta) {
          problems.push(blob === undefined
            ? { class: 'chunk_lost', chunkId: chunk.id, detail: 'no chunks row and no blob on disk' }
            : { class: 'chunk_row_missing', chunkId: chunk.id, blobBytes: blob, plainBytes: chunk.size, repairable: blob <= maxEncryptedChunkBytes(chunk.size) });
          continue;
        }
        const size = Number(meta.size); const stored = Number(meta.stored_size);
        if (size !== chunk.size || stored < 0 || stored > maxEncryptedChunkBytes(size)) { problems.push({ class: 'chunk_metadata_invalid', chunkId: chunk.id, size, expectedSize: chunk.size, storedSize: stored }); continue }
        if (blob === undefined) {
          if (cacheState === 'evicted' || cacheState === 'evicting') { if (this.options.strict) problems.push({ class: 'chunk_blob_evicted', chunkId: chunk.id }); continue }
          problems.push({ class: 'chunk_blob_missing', chunkId: chunk.id, cacheState: cacheState ?? null });
          continue;
        }
        if (blob !== stored) { problems.push({ class: 'chunk_blob_size_mismatch', chunkId: chunk.id, blobBytes: blob, storedSize: stored }); continue }
        if (this.options.deep) {
          if (!envelopes.has(key)) envelopes.set(key, await this.blobs.envelopeProblem(row.chunk_collection_id, chunk.id, blob));
          const envelope = envelopes.get(key);
          if (envelope) problems.push({ class: 'chunk_envelope_invalid', chunkId: chunk.id, detail: envelope });
        }
      }
      result.set(row.version_id, problems);
    }
    return result;
  }

  async problemsFor(row, fileId) {
    const rowProblems = VersionInspector.rowProblems(row, fileId);
    if (rowProblems.length) return rowProblems;
    return (await this.chunkProblems([row])).get(row.version_id) ?? [];
  }
}

/** Opt-in repairs. Each runs in its own short transaction and is audited. Nothing is ever deleted. */
class IntegrityRepairer {
  constructor(db, inspector, catalog, output) { this.db = db; this.inspector = inspector; this.catalog = catalog; this.output = output }

  async transaction(work) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release() }
  }

  /** Re-registers `chunks` rows for blobs that are on disk but whose metadata row was never committed. */
  async reregisterChunks(file, problems) {
    const actions = [];
    for (const problem of problems) {
      // Only a blob that is still a well-formed encryption envelope of the right size is re-registered.
      const envelope = await this.inspector.blobs.envelopeProblem(file.chunk_collection_id, problem.chunkId, problem.blobBytes);
      if (envelope) { actions.push({ action: 'skipped-bad-envelope', chunkId: problem.chunkId, detail: envelope }); continue }
      const inserted = await this.transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`stored-namespace:${ file.chunk_collection_id }`]);
        const refs = Number((await client.query(`SELECT count(DISTINCT v.id)::int refs FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
          WHERE v.chunk_collection_id=$1 AND m.chunk_ids ? $2`, [file.chunk_collection_id, problem.chunkId])).rows[0].refs);
        const row = (await client.query(`INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT DO NOTHING RETURNING id`, [file.chunk_collection_id, problem.chunkId, problem.plainBytes, problem.blobBytes, `chunks/${ file.chunk_collection_id }/${ problem.chunkId }`, refs])).rows[0];
        if (row) await this.audit(client, file, 'reregister-chunk', { chunkId: problem.chunkId, size: problem.plainBytes, storedSize: problem.blobBytes, refcount: refs });
        return row ? refs : undefined;
      });
      actions.push({ action: inserted === undefined ? 'chunk-already-registered' : 'reregister-chunk', chunkId: problem.chunkId, refcount: inserted ?? null });
    }
    return actions;
  }

  /** Finds the newest ancestor whose content passes every check. */
  async readableAncestor(file) {
    let current = await this.catalog.version(file.file_id, file.version_id);
    for (let hops = 0; current?.parent_version_id && hops < 1000; hops++) {
      const parent = await this.catalog.version(file.file_id, current.parent_version_id);
      if (!parent) return undefined;
      if (!(await this.inspector.problemsFor(parent, file.file_id)).length) return parent;
      current = parent;
    }
    return undefined;
  }

  /** Adds a new current version that restores the newest readable ancestor (like Trash restore). */
  async rollBack(file, problems) {
    const source = await this.readableAncestor(file);
    if (!source) return [{ action: 'no-readable-ancestor', detail: 'left untouched; content must be recovered from a backup' }];
    const created = await this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`stored-namespace:${ file.collection_id }`]);
      const locked = (await client.query('SELECT current_version_id::text FROM files WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [file.file_id])).rows[0];
      if (locked?.current_version_id !== file.version_id) return undefined;
      const message = `Restored by Files fsck: version ${ file.version_id } is unreadable (${ problems.map(problem => problem.class).join(',') })`;
      const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,restored_from_version_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,base_server_version_id)
        VALUES($1,$2,$3,$4,$5,$6,'user','files-fsck',$7,'files-fsck',$3) RETURNING id::text`,
      [file.file_id, source.chunk_collection_id, file.version_id, source.version_id, source.manifest_hash, source.version_size, message])).rows[0];
      await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id IN (SELECT jsonb_array_elements_text(chunk_ids) FROM manifests WHERE hash=$2)', [source.chunk_collection_id, source.manifest_hash]);
      await client.query('UPDATE files SET current_version_id=$2,size=$3,updated_at=NOW() WHERE id=$1', [file.file_id, version.id, source.version_size]);
      await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'restore')", [file.collection_id, file.file_id, version.id]);
      await this.audit(client, { ...file, version_id: version.id }, 'rollback-to-readable', { brokenVersionId: file.version_id, restoredFromVersionId: source.version_id });
      return version.id;
    });
    return [created
      ? { action: 'rollback-to-readable', newVersionId: created, restoredFromVersionId: source.version_id, brokenVersionKept: file.version_id }
      : { action: 'skipped-file-changed', detail: 'the file got a new version while fsck ran; re-run fsck' }];
  }

  async audit(client, file, step, details) {
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details) VALUES('user','files-fsck','files-fsck',$1,$2,'files-fsck-repair',$3)`,
      [file.file_id, file.version_id, { step, path: file.path, ...details }]);
  }

  async repair(file, problems, options) {
    const lossless = problems.every(problem => problem.class === 'chunk_row_missing' && problem.repairable);
    if (lossless) return this.reregisterChunks(file, problems);
    if (options.rollbackUnrecoverable) return this.rollBack(file, problems);
    return [{ action: 'none', detail: 'not losslessly repairable; re-run with rollbackUnrecoverable to restore the newest readable version' }];
  }
}

/** Pages through every live file with bounded memory and reports problems. */
export class FilesFsck {
  constructor(db, chunkRoot, options, output) {
    this.db = db; this.options = options; this.output = output;
    this.catalog = new FilesCatalog(db);
    this.blobs = new ChunkBlobStore(chunkRoot);
  }

  async run() {
    const started = Date.now();
    this.options.cacheTable = await this.catalog.hasTable('files_chunk_cache');
    const inspector = new VersionInspector(this.catalog, this.blobs, this.options);
    const repairer = this.options.repair ? new IntegrityRepairer(this.db, inspector, this.catalog, this.output) : undefined;
    const summary = { files: 0, problemFiles: 0, byClass: {}, repaired: 0, repairActions: {} };
    let after = '00000000-0000-0000-0000-000000000000';
    const pageSize = Math.max(1, Math.min(5000, Number(this.options.pageSize) || 1000));
    for (;;) {
      const rows = await this.catalog.page(after, pageSize, this.options.collectionId);
      if (!rows.length) break;
      after = rows[rows.length - 1].file_id;
      const problems = new Map(); const checkable = [];
      for (const row of rows) {
        if (!row.current_version_id) { problems.set(row.file_id, [{ class: 'no_current_version' }]); continue }
        const found = VersionInspector.rowProblems(row, row.file_id);
        if (found.length) problems.set(row.file_id, found); else checkable.push(row);
      }
      const chunkProblems = await inspector.chunkProblems(checkable);
      for (const row of checkable) { const found = chunkProblems.get(row.version_id) ?? []; if (found.length) problems.set(row.file_id, found) }
      for (const row of rows) {
        summary.files++;
        const found = problems.get(row.file_id);
        if (!found) continue;
        summary.problemFiles++;
        const classes = [...new Set(found.map(problem => problem.class))];
        for (const name of classes) summary.byClass[name] = (summary.byClass[name] ?? 0) + 1;
        const record = { type: 'problem', fileId: row.file_id, collectionId: row.collection_id, path: row.path, explorerPath: row.explorer_path ?? '',
          versionId: row.current_version_id, size: row.version_size === null ? null : Number(row.version_size), failureClass: classes.join('+'), problems: found };
        this.output.write(record);
        if (repairer && !classes.includes('no_current_version') && !classes.includes('chunk_blob_evicted')) {
          let actions;
          try { actions = await repairer.repair(row, found, this.options) } catch (error) { actions = [{ action: 'repair-failed', error: String(error?.message ?? error).slice(0, 300) }] }
          for (const action of actions) {
            summary.repairActions[action.action] = (summary.repairActions[action.action] ?? 0) + 1;
            this.output.write({ type: 'repair', fileId: row.file_id, path: row.path, versionId: row.current_version_id, ...action });
          }
          if (actions.some(action => action.action === 'reregister-chunk' || action.action === 'rollback-to-readable' || action.action === 'chunk-already-registered')) summary.repaired++;
        }
      }
      if (this.options.progress) this.output.write({ type: 'progress', files: summary.files, problemFiles: summary.problemFiles, elapsedMs: Date.now() - started });
      if (this.options.limit && summary.files >= this.options.limit) break;
    }
    this.output.write({ type: 'summary', mode: this.options.repair ? 'repair' : 'read-only', deep: Boolean(this.options.deep), ...summary, elapsedMs: Date.now() - started });
    return summary;
  }
}

async function main() {
  const options = JSON.parse(process.env.FSCK_OPTS || '{}');
  const output = new JsonlOutput(process.stdout);
  const require = createRequire(join(process.cwd(), 'noop.js'));
  const pg = require('pg');
  const url = process.env.FSCK_DATABASE_URL || process.env.SULLA_FILES_DATABASE_URL;
  if (!url) throw new Error('SULLA_FILES_DATABASE_URL is not set (run inside the sulla_files container)');
  const db = new pg.Pool({ connectionString: url, max: 2, application_name: 'files-fsck', statement_timeout: 120_000 });
  db.on('error', () => undefined);
  try {
    if (!options.repair) {
      // Belt and braces: the session itself refuses writes in read-only mode.
      db.on('connect', client => { client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY').catch(() => undefined) });
    }
    const root = options.chunkRoot || process.env.SULLA_FILES_CHUNK_ROOT || '/var/lib/sulla-files/chunks';
    await new FilesFsck(db, root, options, output).run();
  } finally { await db.end() }
}

if (process.env.FSCK_NO_MAIN !== '1') {
  main().catch(error => { process.stdout.write(`${ JSON.stringify({ type: 'error', error: String(error?.message ?? error) }) }\n`); process.exitCode = 2 });
}
