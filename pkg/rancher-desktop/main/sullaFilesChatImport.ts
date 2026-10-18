import fs from 'node:fs';
import path from 'node:path';

import { dialog, type BrowserWindow } from 'electron';

import { getSullaFilesWatcher } from './sullaFilesWatcher';

import paths from '@pkg/utils/paths';

const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;
const SENSITIVE_PARTS = new Set([
  '.aws', '.azure', '.gnupg', '.keychain', '.password-store', '.ssh', 'gcloud', 'keychains',
  'crypto-wallet', 'private-files-quarantine', 'vault', 'wallet', 'wallets',
]);

export interface ChatFilesReference {
  fileId:          string;
  versionId:       string;
  path:            string;
  name:            string;
  mime:            string;
  size:            number;
  updatedAt:       string;
  createdByType?:  string;
  createdById?:    string;
  collectionId?:   string;
  collectionKind?: string;
  agentRunId?:     string;
}

export interface PartialChatFilesImport {
  references: ChatFilesReference[];
  error:      string;
}

interface FilesCollection {
  id:                   string;
  name?:                string;
  kind?:                string;
  compatibility_state?: string;
}

interface FilesRecord {
  id?:                 unknown;
  current_version_id?: unknown;
  path?:               unknown;
  mime?:               unknown;
  size?:               unknown;
  updated_at?:         unknown;
  created_by_type?:    unknown;
  created_by_id?:      unknown;
}

function isWithin(root:string, candidate:string):boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${ path.sep }`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertImportableSource(source:string):void {
  const absolute = path.resolve(source);
  const protectedRoots = [
    paths.appHome,
    paths.altAppHome,
    paths.sullaConfig,
    path.join(paths.sullaHome, 'integrations'),
    path.join(paths.sullaHome, 'private-files-quarantine'),
  ];
  if (protectedRoots.some(root => root && isWithin(root, absolute))) throw new Error('That protected application file cannot be imported.');

  const parts = absolute.split(path.sep).filter(Boolean).map(part => part.toLocaleLowerCase());
  if (parts.some(part => SENSITIVE_PARTS.has(part) || part.includes('wallet') || part.includes('vault'))) throw new Error('That protected source cannot be imported.');
  const leaf = parts.at(-1) ?? '';
  if (leaf === '.env' || leaf.startsWith('.env.') || leaf === 'master.key' || /\.(?:key|pem|p12|pfx|seed|wallet)$/i.test(leaf)) {
    throw new Error('That protected source cannot be imported.');
  }
}

function mimeFor(name:string):string {
  const extension = path.extname(name).toLocaleLowerCase();
  return ({
    '.avif': 'image/avif',
    '.csv':  'text/csv',
    '.gif':  'image/gif',
    '.html': 'text/html',
    '.jpeg': 'image/jpeg',
    '.jpg':  'image/jpeg',
    '.json': 'application/json',
    '.md':   'text/markdown',
    '.mov':  'video/quicktime',
    '.mp3':  'audio/mpeg',
    '.mp4':  'video/mp4',
    '.pdf':  'application/pdf',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.txt':  'text/plain',
    '.wav':  'audio/wav',
    '.webm': 'video/webm',
    '.webp': 'image/webp',
    '.yaml': 'application/yaml',
    '.yml':  'application/yaml',
    '.zip':  'application/zip',
  } as Record<string, string>)[extension] ?? 'application/octet-stream';
}

async function responseJson<T>(endpoint:string, init:RequestInit = {}):Promise<T> {
  const response = await getSullaFilesWatcher().requestFiles(endpoint, init);
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(error.error || `Files import failed (${ response.status })`);
  }
  return await response.json() as T;
}

interface PreparedSource {
  handle:  fs.promises.FileHandle;
  name:    string;
  size:    number;
  mtimeMs: number;
  dev:     number;
  ino:     number;
}

interface PathIdentity {
  path: string;
  dev:  number;
  ino:  number;
}

async function pathAncestry(source:string):Promise<PathIdentity[]> {
  const identities:PathIdentity[] = [];
  let current = path.parse(source).root;
  for (const part of source.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await fs.promises.lstat(current);
    identities.push({ path: current, dev: info.dev, ino: info.ino });
  }
  return identities;
}

async function assertSameAncestry(identities:PathIdentity[]):Promise<void> {
  for (const identity of identities) {
    const current = await fs.promises.lstat(identity.path);
    if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('The selected source path changed while Files was opening it.');
  }
}

async function prepareSource(source:string):Promise<PreparedSource> {
  assertImportableSource(source);
  let resolved:string;
  try {
    resolved = await fs.promises.realpath(source);
  } catch {
    throw new Error('The selected source is no longer available.');
  }
  assertImportableSource(resolved);
  let before:fs.Stats;
  let handle:fs.promises.FileHandle | undefined;
  try {
    const ancestry = await pathAncestry(resolved);
    before = await fs.promises.lstat(resolved);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    handle = await fs.promises.open(resolved, flags);
    await assertSameAncestry(ancestry);
  } catch {
    await handle?.close().catch(() => undefined);
    throw new Error('The selected source could not be opened safely.');
  }
  try {
    const info = await handle.stat();
    if (!before.isFile() || !info.isFile() || before.dev !== info.dev || before.ino !== info.ino) throw new Error('The selected source changed before Files could open it.');
    if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_IMPORT_BYTES) throw new Error('This file is too large to import into Files.');
    return { handle, name: path.basename(resolved), size: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function matchesPreparedSource(source:PreparedSource, info:fs.Stats):boolean {
  return info.isFile() && info.dev === source.dev && info.ino === source.ino && info.size === source.size && info.mtimeMs === source.mtimeMs;
}

async function uploadPreparedSource(source:PreparedSource, endpoint:string, mime:string):Promise<{ response: Response; sourceChanged: boolean }> {
  if (!matchesPreparedSource(source, await source.handle.stat())) throw new Error('The source changed while Files was importing it. Try again.');
  // requestFilesStream can retry once after unlocking. A fresh positional stream per
  // iterator makes the same body safe to send again without buffering the file.
  const body = {
    async * [Symbol.asyncIterator]() {
      const stream = source.handle.createReadStream({ autoClose: false, start: 0, end: source.size ? source.size - 1 : undefined });
      for await (const chunk of stream) yield chunk;
    },
  } as unknown as BodyInit;
  const init = {
    method:  'PUT',
    headers: { 'content-type': mime, 'content-length': String(source.size) },
    body,
    duplex:  'half',
  } as RequestInit & { duplex: 'half' };
  // Large native imports need a transfer deadline, not the metadata request timeout.
  const response = await getSullaFilesWatcher().requestFilesStream(endpoint, init, AbortSignal.timeout(30 * 60_000));
  const sourceChanged = !matchesPreparedSource(source, await source.handle.stat());
  return { response, sourceChanged };
}

function availablePath(name:string, reserved:Set<string>):string {
  const safeName = path.basename(name).replaceAll('/', '_').replaceAll('\\', '_');
  if (!safeName || safeName === '.' || safeName === '..') throw new Error('The selected file has an invalid name.');
  const extension = path.extname(safeName);
  const stem = extension ? safeName.slice(0, -extension.length) : safeName;
  for (let index = 0; ; index++) {
    const candidate = index ? `${ stem } (${ index })${ extension }` : safeName;
    if (!reserved.has(candidate)) { reserved.add(candidate); return candidate }
  }
}

function durableReference(file:FilesRecord, collection:FilesCollection, expectedPath:string, expectedBytes:number):ChatFilesReference {
  const fileId = typeof file.id === 'string' ? file.id : '';
  const versionId = typeof file.current_version_id === 'string' ? file.current_version_id : '';
  const committedPath = typeof file.path === 'string' ? file.path : '';
  const size = Number(file.size);
  if (!fileId || !versionId || committedPath !== expectedPath || size !== expectedBytes) throw new Error('Files did not confirm the imported file version.');
  return {
    fileId,
    versionId,
    path:           committedPath,
    name:           path.basename(committedPath),
    mime:           typeof file.mime === 'string' && file.mime ? file.mime : mimeFor(committedPath),
    size,
    updatedAt:      typeof file.updated_at === 'string' ? file.updated_at : new Date().toISOString(),
    createdByType:  typeof file.created_by_type === 'string' ? file.created_by_type : undefined,
    createdById:    typeof file.created_by_id === 'string' ? file.created_by_id : undefined,
    collectionId:   collection.id,
    collectionKind: collection.kind,
  };
}

export async function importChatFiles(filePaths:string[]):Promise<ChatFilesReference[] | PartialChatFilesImport> {
  if (!Array.isArray(filePaths) || filePaths.some(source => typeof source !== 'string' || !source)) throw new Error('Files import requires selected file paths.');
  if (!filePaths.length) return [];
  if (filePaths.length > 100) throw new Error('Choose 100 files or fewer at a time.');

  // Validate every source before committing the first item. This
  // keeps protected, changed, oversized, or non-file selections out of Files
  // and never modifies the source files.
  const sources:PreparedSource[] = [];
  try {
    for (const source of filePaths) sources.push(await prepareSource(source));

    const collections = await responseJson<FilesCollection[]>('/v1/collections');
    const collection = collections.find(item => item.name === 'Files' && item.compatibility_state !== 'legacy') ??
      collections.find(item => item.kind === 'knowledge' && item.compatibility_state !== 'legacy');
    if (!collection?.id) throw new Error('The authenticated Files collection is unavailable.');

    const [active, trash] = await Promise.all([
      responseJson<FilesRecord[]>(`/v1/files?collectionId=${ encodeURIComponent(collection.id) }&path=&trash=false`),
      responseJson<FilesRecord[]>(`/v1/files?collectionId=${ encodeURIComponent(collection.id) }&path=&trash=true`),
    ]);
    const reserved = new Set([...active, ...trash].flatMap(file => typeof file.path === 'string' ? [file.path] : []));
    const references:ChatFilesReference[] = [];
    for (const source of sources) {
      try {
        let uploaded = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const targetPath = availablePath(source.name, reserved);
          const mime = mimeFor(targetPath);
          const { response, sourceChanged } = await uploadPreparedSource(source, `/v1/files/import?collectionId=${ encodeURIComponent(collection.id) }&path=${ encodeURIComponent(targetPath) }`, mime);
          if (response.status === 409) {
            await response.arrayBuffer();
            if (sourceChanged) throw new Error('The source changed while Files was importing it. Try again.');
            continue;
          }
          if (!response.ok) {
            const body = await response.json().catch(() => ({})) as { error?: string };
            throw new Error(body.error || `Files import failed (${ response.status })`);
          }
          const file = await response.json() as FilesRecord;
          references.push(durableReference(file, collection, targetPath, source.size));
          uploaded = true;
          if (sourceChanged) {
            return { references, error: 'The source changed during import. The committed Files version is attached; review it before sending.' };
          }
          break;
        }
        if (!uploaded) throw new Error('Files could not reserve a unique destination name.');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Files import failed.';
        if (references.length) return { references, error: `${ message } The files already listed were imported and are ready to attach.` };
        throw error;
      }
    }
    return references;
  } finally {
    await Promise.all(sources.map(source => source.handle.close().catch(() => undefined)));
  }
}

export async function pickAndImportChatFiles(owner?:BrowserWindow):Promise<ChatFilesReference[] | PartialChatFilesImport> {
  const options = { title: 'Upload to Sulla Files', properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[] };
  const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  if (picked.canceled) return [];
  return importChatFiles(picked.filePaths);
}
