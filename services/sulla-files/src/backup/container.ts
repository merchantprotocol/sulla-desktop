import { createHash } from 'node:crypto';
import { lstat, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const MAGIC = Buffer.from('SULLA-FILES-BACKUP\n', 'ascii');
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const COPY_BYTES = 1024 * 1024;
export const MAX_SCHEMA_EVIDENCE_BYTES = 4 * 1024 * 1024;

export type BackupEntryType = 'postgres-rows' | 'schema-evidence' | 'encrypted-chunk';

export interface BackupEntry {
  path:   string;
  type:   BackupEntryType;
  size:   number;
  sha256: string;
}

export interface BackupManifest {
  format:            'sulla-files-coherent-backup';
  version:           1;
  createdAt:         string;
  postgresVersion:   string;
  snapshotId:        string;
  migrations:        string[];
  tables:            unknown[];
  excludedTableData: Record<string, string>;
  entries:           BackupEntry[];
}

export interface BackupObject extends BackupEntry { sourcePath: string }

async function writeAll(handle:Awaited<ReturnType<typeof open>>, value:Buffer, position:number):Promise<void> {
  let written = 0;
  while (written < value.length) {
    const result = await handle.write(value, written, value.length - written, position + written);
    if (!result.bytesWritten) throw new Error('Backup destination stopped accepting bytes');
    written += result.bytesWritten;
  }
}

function safeEntry(entry:BackupEntry):void {
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Backup entry has an invalid size');
  if (entry.type === 'schema-evidence' && entry.size > MAX_SCHEMA_EVIDENCE_BYTES) throw new Error('Backup schema evidence exceeds the safe size limit');
  if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Backup entry has an invalid digest');
  const valid = entry.type === 'postgres-rows'
    ? entry.path === 'database/rows.jsonl'
    : entry.type === 'schema-evidence'
      ? entry.path === 'schema/evidence.json'
      : /^chunks\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(entry.path);
  if (!valid || entry.path.includes('..') || entry.path.startsWith('/')) throw new Error(`Unsafe backup entry path: ${ entry.path }`);
}

export async function sha256File(path:string):Promise<{ size: number; sha256: string }> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Backup source is not a regular file: ${ basename(path) }`);
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
  let offset = 0;
  try {
    const buffer = Buffer.allocUnsafe(COPY_BYTES);
    while (offset < info.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
      if (!bytesRead) throw new Error('Backup source changed while hashing');
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('Backup source changed while hashing');
    return { size: info.size, sha256: hash.digest('hex') };
  } finally { await handle.close() }
}

async function copyExact(sourcePath:string, output:Awaited<ReturnType<typeof open>>, outputOffset:number, expected:BackupEntry):Promise<number> {
  const source = await open(sourcePath, 'r');
  const hash = createHash('sha256');
  let readOffset = 0;
  try {
    const buffer = Buffer.allocUnsafe(COPY_BYTES);
    while (readOffset < expected.size) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, expected.size - readOffset), readOffset);
      if (!bytesRead) throw new Error(`Backup source was truncated: ${ expected.path }`);
      const value = buffer.subarray(0, bytesRead); hash.update(value);
      await writeAll(output, value, outputOffset + readOffset); readOffset += bytesRead;
    }
    if ((await source.stat()).size !== expected.size || hash.digest('hex') !== expected.sha256) {
      throw new Error(`Backup source changed during snapshot: ${ expected.path }`);
    }
    return outputOffset + readOffset;
  } finally { await source.close() }
}

export async function writeContainer(destination:string, manifest:BackupManifest, objects:BackupObject[]):Promise<void> {
  if (objects.length !== manifest.entries.length) throw new Error('Backup inventory mismatch');
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    safeEntry(entry);
    if (seen.has(entry.path)) throw new Error(`Duplicate backup entry: ${ entry.path }`);
    seen.add(entry.path);
  }
  const encoded = Buffer.from(JSON.stringify(manifest));
  if (encoded.length > MAX_MANIFEST_BYTES) throw new Error('Backup manifest is too large');
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(destination), `.${ basename(destination) }.tmp-${ process.pid }-${ Date.now() }`);
  const output = await open(temporary, 'wx', 0o600);
  try {
    const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(encoded.length));
    await writeAll(output, MAGIC, 0);
    await writeAll(output, length, MAGIC.length);
    await writeAll(output, encoded, MAGIC.length + length.length);
    let offset = MAGIC.length + length.length + encoded.length;
    for (let index = 0; index < objects.length; index++) {
      if (objects[index].path !== manifest.entries[index].path) throw new Error('Backup object ordering mismatch');
      offset = await copyExact(objects[index].sourcePath, output, offset, objects[index]);
    }
    await output.sync(); await output.close(); await rename(temporary, destination);
  } catch (error) {
    await output.close().catch(() => undefined); await rm(temporary, { force: true }); throw error;
  }
}

function parseManifest(value:unknown):BackupManifest {
  if (!value || typeof value !== 'object') throw new Error('Backup manifest is invalid');
  const manifest = value as Partial<BackupManifest>;
  if (manifest.format !== 'sulla-files-coherent-backup' || manifest.version !== 1) throw new Error('Unsupported backup format version');
  if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.migrations) || !Array.isArray(manifest.tables)) throw new Error('Backup manifest inventories are invalid');
  if (typeof manifest.createdAt !== 'string' || typeof manifest.postgresVersion !== 'string' || typeof manifest.snapshotId !== 'string') {
    throw new Error('Backup snapshot metadata is invalid');
  }
  if (!manifest.excludedTableData || typeof manifest.excludedTableData !== 'object') throw new Error('Backup exclusion inventory is invalid');
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    safeEntry(entry);
    if (seen.has(entry.path)) throw new Error(`Duplicate backup entry: ${ entry.path }`); seen.add(entry.path);
  }
  if (!seen.has('database/rows.jsonl') || !seen.has('schema/evidence.json')) throw new Error('Backup is missing required objects');
  return manifest as BackupManifest;
}

export interface ExtractedBackup { manifest: BackupManifest; root: string; path(entry:string):string; cleanup():Promise<void> }

export async function validateAndExtractContainer(archive:string, targetRoot:string):Promise<ExtractedBackup> {
  const archiveInfo = await lstat(archive);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) throw new Error('Backup archive must be a regular file');
  const input = await open(archive, 'r');
  try {
    const prefix = Buffer.alloc(MAGIC.length + 8);
    if ((await input.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('Not a Sulla Files backup');
    }
    const manifestBytes = Number(prefix.readBigUInt64BE(MAGIC.length));
    if (!Number.isSafeInteger(manifestBytes) || manifestBytes <= 0 || manifestBytes > MAX_MANIFEST_BYTES) throw new Error('Backup manifest length is invalid');
    const encoded = Buffer.alloc(manifestBytes);
    if ((await input.read(encoded, 0, encoded.length, prefix.length)).bytesRead !== encoded.length) throw new Error('Backup manifest is truncated');
    let decoded:unknown;
    try { decoded = JSON.parse(encoded.toString('utf8')) } catch { throw new Error('Backup manifest is not valid JSON') }
    const manifest = parseManifest(decoded);
    const schema = manifest.entries.find(entry => entry.path === 'schema/evidence.json');
    if (!schema || schema.size > MAX_SCHEMA_EVIDENCE_BYTES) throw new Error('Backup schema evidence exceeds the safe size limit');
    const expectedSize = prefix.length + manifestBytes + manifest.entries.reduce((total, entry) => total + entry.size, 0);
    if (expectedSize !== archiveInfo.size) throw new Error('Backup archive size does not match its inventory');
    await mkdir(targetRoot, { recursive: false, mode: 0o700 });
    let offset = prefix.length + manifestBytes;
    for (const entry of manifest.entries) {
      const destination = join(targetRoot, ...entry.path.split('/'));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const output = await open(destination, 'wx', 0o600);
      const hash = createHash('sha256');
      let copied = 0;
      try {
        const buffer = Buffer.allocUnsafe(COPY_BYTES);
        while (copied < entry.size) {
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, entry.size - copied), offset + copied);
          if (!bytesRead) throw new Error(`Backup entry is truncated: ${ entry.path }`);
          const value = buffer.subarray(0, bytesRead); hash.update(value); await writeAll(output, value, copied); copied += bytesRead;
        }
        await output.sync();
      } finally { await output.close() }
      if (hash.digest('hex') !== entry.sha256) throw new Error(`Backup entry digest mismatch: ${ entry.path }`);
      offset += entry.size;
    }
    return { manifest, root: targetRoot, path: entry => join(targetRoot, ...entry.split('/')), cleanup: () => rm(targetRoot, { recursive: true, force: true }) };
  } catch (error) {
    await rm(targetRoot, { recursive: true, force: true }).catch(() => undefined); throw error;
  } finally { await input.close() }
}
