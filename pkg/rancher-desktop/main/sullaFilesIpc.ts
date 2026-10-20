import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { app, BrowserWindow, dialog, protocol, shell, webContents, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';

import { getIpcMainProxy } from './ipcMain';
import { readBoundedResponse } from './sullaFilesBoundedResponse';
import { getSullaFilesCaptureService, type ScreenshotMode } from './sullaFilesCapture';
import { importChatFiles, pickAndImportChatFiles, type ChatFilesReference, type PartialChatFilesImport } from './sullaFilesChatImport';
import { FilesApiError, getSullaFilesClient } from './sullaFilesClient';
import { getSullaFilesLinkService, type CreateShareInput } from './sullaFilesLinkService';
import { getSullaFilesRootRegistry, isProtectedTrackedPath } from './sullaFilesRootRegistry';
import { getSullaFilesSourceGateway } from './sullaFilesSourceGateway';
import { getSullaFilesWatcher } from './sullaFilesWatcher';
import { getSullaFilesBackups } from './sullaFilesBackups';
import { getSullaFilesMountManager } from './sullaFilesMountManager';

import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';

import type { FilesRevealResult, FilesOperationRequest, FilesOperationRetry, FilesTrashItem } from '@pkg/pages/files/types';

const console = Logging.background;
const ipcMain = getIpcMainProxy(console);
const RESIDENCY_TRANSFER_TIMEOUT_MS = 30 * 60_000;
const MAX_DIRECT_UPLOAD_BYTES = 64 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const filesClient = getSullaFilesClient();

async function cloudFilesAvailable():Promise<boolean> {
  try {
    const account = await getIntegrationService().getConnectionStatus('sulla-cloud');
    if (!account.connected) return false;

    const { getCloudConnectionStatus } = await import('@pkg/main/cloud/cloudLifecycle');
    const cloud = await getCloudConnectionStatus();

    return cloud.signedIn && cloud.device.registered && !cloud.device.revoked && cloud.channel?.state === 'connected';
  } catch {
    return false;
  }
}

async function json(endpoint:string, init:RequestInit = {}, server = false):Promise<any> {
  return filesClient.json(endpoint, init, { server });
}

function stableUploadIdentity(left:fs.BigIntStats, right:fs.BigIntStats):boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function storedPath(destination:string, name:string):string {
  const normalized = destination.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (normalized.split('/').some(part => part === '.' || part === '..')) throw new Error('Upload destination is not a valid Files folder');
  return [normalized, path.basename(name)].filter(Boolean).join('/');
}

async function readStableUpload(source:string):Promise<Buffer> {
  const selected = await fs.promises.lstat(source, { bigint: true });
  if (!selected.isFile() || selected.isSymbolicLink()) throw new Error('Only regular files can be uploaded');
  if (selected.size > BigInt(MAX_DIRECT_UPLOAD_BYTES)) throw new Error('Files selected in Desktop must be 64 MiB or smaller');
  const file = await fs.promises.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!stableUploadIdentity(selected, before)) throw new Error('Selected file changed before it could be read');
    const chunks:Buffer[] = [];
    let total = 0;
    while (total <= MAX_DIRECT_UPLOAD_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, MAX_DIRECT_UPLOAD_BYTES - total + 1));
      const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_DIRECT_UPLOAD_BYTES) throw new Error('Files selected in Desktop must be 64 MiB or smaller');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, total);
    const [after, pathname] = await Promise.all([file.stat({ bigint: true }), fs.promises.lstat(source, { bigint: true })]);
    if (!stableUploadIdentity(before, after) || !stableUploadIdentity(after, pathname) || bytes.byteLength !== Number(after.size)) {
      throw new Error('Selected file changed while it was being read. Nothing was uploaded.');
    }
    return bytes;
  } finally { await file.close() }
}

async function importPaths(paths:string[], destination = '', progress?:(value:{ current: number; total: number; name: string; percent: number; done: boolean }) => void, collectionId?:string):Promise<number> {
  if (!collectionId || !UUID.test(collectionId)) throw new Error('Choose a Files collection before uploading');
  if (!Array.isArray(paths) || paths.length > 250) throw new Error('Choose no more than 250 files at once');
  let imported = 0;
  for (const [index, source] of paths.entries()) {
    progress?.({ current: index + 1, total: paths.length, name: path.basename(source), percent: 12, done: false });
    const bytes = await readStableUpload(source);
    const target = storedPath(destination, source);
    const response = await filesClient.request(`/v1/files/import?collectionId=${ encodeURIComponent(collectionId) }&path=${ encodeURIComponent(target) }&conflict=keep-both`, {
      method:  'PUT',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) },
      body:    bytes as unknown as BodyInit,
    });
    if (!response.ok) throw new FilesApiError((await response.json().catch(() => ({})) as { error?:string }).error ?? `Files upload failed (${ response.status })`, response.status);
    imported++;
    progress?.({ current: index + 1, total: paths.length, name: path.basename(source), percent: 100, done: index + 1 === paths.length });
  }
  return imported;
}

interface FileReference {
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

function reference(file:any, collection?:any):FileReference {
  return {
    fileId:         String(file.id),
    versionId:      String(file.current_version_id ?? ''),
    path:           String(file.path),
    name:           path.basename(String(file.path)),
    mime:           String(file.mime || 'application/octet-stream'),
    size:           Number(file.size ?? 0),
    updatedAt:      String(file.updated_at ?? new Date(0).toISOString()),
    createdByType:  file.created_by_type ?? file.version_created_by_type,
    createdById:    file.created_by_id ?? file.version_created_by_id,
    collectionId:   collection?.id ?? file.collection_id,
    collectionKind: collection?.kind,
    agentRunId:     collection?.agent_run_id,
  };
}

async function collectionsWithFiles():Promise<{ collection: any; files: any[] }[]> {
  const collections = await json('/v1/collections') as any[];
  return Promise.all(collections.map(async collection => ({
    collection,
    files: await json(`/v1/files?collectionId=${ encodeURIComponent(collection.id) }&path=&trash=false`) as any[],
  })));
}

async function findReferenceByPath(relativePath:string, collectionId?:string):Promise<FileReference | undefined> {
  const matches:FileReference[] = [];
  for (const item of await collectionsWithFiles()) {
    if (collectionId && item.collection.id !== collectionId) continue;
    const file = item.files.find(candidate => candidate.path === relativePath);
    if (file) matches.push(reference(file, item.collection));
  }
  if (matches.length > 1) throw new Error(`More than one collection contains ${ relativePath }; choose it from Files instead.`);
  return matches[0];
}

function pathWithin(root:string, candidate:string):boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));

  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${ path.sep }`));
}

interface OpenedFileCopy {
  root:string;
  target:string;
  rootInfo:fs.Stats;
  info:fs.Stats;
}

const openedFileCopies = new Map<string, OpenedFileCopy>();
const copyKey = (fileId:string, versionId:string):string => JSON.stringify([fileId, versionId]);

interface OriginalRevealTarget {
  rootId:string;
  collectionId:string;
  relativePath:string;
  fileId:string;
  versionId:string;
  revision:string;
  hash:string;
  size:number;
  mtimeMs:number;
}

type OriginalRevealAttestation =
  | { status:'attested'; token:string; expiresAt:number; target:OriginalRevealTarget }
  | { status:'unavailable'; code:'no-current-original' };

async function nativeJson<T>(endpoint:string, body:unknown):Promise<T> {
  const response = await getSullaFilesWatcher().requestNativeFiles(endpoint, { method: 'POST', body: JSON.stringify(body) });
  if (!response.ok) {
    const result = await response.clone().json().catch(() => ({})) as { error?:unknown; code?:unknown };
    const error = new FilesApiError(typeof result.error === 'string' && result.error ? result.error : `Files request failed (${ response.status })`, response.status);

    if (typeof result.code === 'string') Object.assign(error, { code: result.code });
    throw error;
  }

  return response.json() as Promise<T>;
}

function originalTarget(value:unknown, input:{ fileId:string; versionId?:string }):OriginalRevealTarget {
  if (!value || typeof value !== 'object') throw new Error('Files returned an invalid original reveal target.');
  const target = value as Record<string, unknown>;
  const strings = ['rootId', 'collectionId', 'relativePath', 'fileId', 'versionId', 'revision', 'hash'] as const;
  if (strings.some(key => typeof target[key] !== 'string' || !target[key] || (target[key] as string).length > 4096) ||
      target.fileId !== input.fileId || (input.versionId !== undefined && target.versionId !== input.versionId) ||
      !Number.isSafeInteger(target.size) || Number(target.size) < 0 || !Number.isSafeInteger(target.mtimeMs) ||
      !/^[0-9]+$/.test(String(target.revision)) || !/^[0-9a-f]{64}$/.test(String(target.hash))) throw new Error('Files returned an invalid original reveal target.');
  const relativePath = String(target.relativePath);
  if (path.posix.isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.includes('\0') ||
      relativePath.split('/').some(part => !part || part === '.' || part === '..' || part === '.sulla-trash' || part === '.sulla-operation-recovery')) {
    throw new Error('Files returned an unsafe original path.');
  }

  return target as unknown as OriginalRevealTarget;
}

function sameOriginalTarget(left:OriginalRevealTarget, right:OriginalRevealTarget):boolean {
  return left.rootId === right.rootId && left.collectionId === right.collectionId && left.relativePath === right.relativePath &&
    left.fileId === right.fileId && left.versionId === right.versionId && left.revision === right.revision &&
    left.hash === right.hash && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

interface VerifiedOriginalTarget {
  candidate:string;
  rootDev:bigint;
  rootIno:bigint;
  fileDev:bigint;
  fileIno:bigint;
}

async function resolveOriginalPath(target:OriginalRevealTarget):Promise<{ candidate:string; rootDev:bigint; rootIno:bigint }> {
  const root = await getSullaFilesRootRegistry().rootForCollection(target.collectionId);
  if (!root || root.id !== target.rootId) throw new Error('The tracked original is no longer attached to this Files collection.');
  if (isProtectedTrackedPath(root.path)) throw new Error('Files cannot reveal originals from a protected local folder.');
  const rootInfo = await fs.promises.lstat(root.path, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('The tracked original root is not a safe local folder.');
  const canonicalRoot = await fs.promises.realpath(root.path);
  if (isProtectedTrackedPath(canonicalRoot)) throw new Error('Files cannot reveal originals from a protected local folder.');
  const canonicalRootInfo = await fs.promises.lstat(canonicalRoot, { bigint: true });
  if (!canonicalRootInfo.isDirectory() || canonicalRootInfo.isSymbolicLink() ||
      canonicalRootInfo.dev !== rootInfo.dev || canonicalRootInfo.ino !== rootInfo.ino) throw new Error('The tracked original root changed while it was being verified.');
  const parent = path.join(canonicalRoot, ...target.relativePath.split('/').slice(0, -1));
  const candidate = path.join(canonicalRoot, ...target.relativePath.split('/'));
  if (!pathWithin(canonicalRoot, candidate) || candidate === canonicalRoot ||
      await fs.promises.realpath(parent) !== parent || await fs.promises.realpath(candidate) !== candidate) {
    throw new Error('The tracked original path is no longer safe.');
  }

  return { candidate, rootDev: rootInfo.dev, rootIno: rootInfo.ino };
}

async function verifyOriginalTarget(target:OriginalRevealTarget):Promise<VerifiedOriginalTarget> {
  const resolved = await resolveOriginalPath(target);
  const { candidate } = resolved;
  const linkInfo = await fs.promises.lstat(candidate, { bigint: true });
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new Error('The tracked original is no longer a regular file.');
  const handle = await fs.promises.open(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== linkInfo.dev || before.ino !== linkInfo.ino ||
        Number(before.size) !== target.size || Number(before.mtimeMs) !== target.mtimeMs) throw new Error('The tracked original changed before it could be revealed.');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        hash.digest('hex') !== target.hash) throw new Error('The tracked original changed before it could be revealed.');
  } finally { await handle.close() }

  return { ...resolved, fileDev: linkInfo.dev, fileIno: linkInfo.ino };
}

async function recheckOriginalTarget(target:OriginalRevealTarget, verified:VerifiedOriginalTarget):Promise<string> {
  const resolved = await resolveOriginalPath(target);
  if (resolved.candidate !== verified.candidate || resolved.rootDev !== verified.rootDev || resolved.rootIno !== verified.rootIno) {
    throw new Error('The tracked original root changed before it could be revealed.');
  }
  const handle = await fs.promises.open(resolved.candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat({ bigint: true });
    if (!current.isFile() || current.dev !== verified.fileDev || current.ino !== verified.fileIno ||
        Number(current.size) !== target.size || Number(current.mtimeMs) !== target.mtimeMs) {
      throw new Error('The tracked original changed before it could be revealed.');
    }
  } finally { await handle.close() }

  return resolved.candidate;
}

async function authorizedReference(input:{ fileId:string; versionId?:string }):Promise<{ file:any; versionId:string }> {
  if (!input || typeof input.fileId !== 'string' || !input.fileId || input.fileId.length > 256 ||
      (input.versionId !== undefined && (typeof input.versionId !== 'string' || !input.versionId || input.versionId.length > 256))) {
    throw new Error('Choose a valid Files reference.');
  }
  const file = await json(`/v1/files/${ encodeURIComponent(input.fileId) }`);
  const versionId = input.versionId || file.current_version_id;
  if (typeof versionId !== 'string' || !versionId) throw new Error('This file has no readable version.');
  const versions = await json(`/v1/files/${ encodeURIComponent(input.fileId) }/history`) as any[];
  if (!versions.some(version => version.id === versionId && !version.deleted)) throw new Error('That file version is no longer available.');

  return { file, versionId };
}

async function materializeReference(input:{ fileId:string; versionId?:string }):Promise<string> {
  const { file, versionId } = await authorizedReference(input);
  const cacheParent = await fs.promises.realpath(paths.cache);
  const cacheRoot = path.join(cacheParent, 'files-open');
  await fs.promises.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const rootInfo = await fs.promises.lstat(cacheRoot);
  if (!rootInfo.isDirectory() || await fs.promises.realpath(cacheRoot) !== cacheRoot) throw new Error('Files open cache is not a safe local folder.');
  const safeName = path.basename(String(file.path || 'file')).replace(/[^a-zA-Z0-9._ -]/g, '_');
  const safeId = createHash('sha256').update(copyKey(input.fileId, versionId)).digest('hex');
  const target = path.join(cacheRoot, `${ safeId }-${ safeName }`);
  const temp = `${ target }.partial-${ process.pid }-${ randomUUID() }`;
  let ownsTemp = false;
  const response = await filesClient.stream(`/v1/files/${ encodeURIComponent(input.fileId) }/preview?versionId=${ encodeURIComponent(versionId) }`);
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Files content failed (${ response.status })`) }
  if (!response.body) throw new Error('Files content response was empty');
  try {
    const handle = await fs.promises.open(temp, 'wx', 0o600); ownsTemp = true;
    await pipeline(Readable.fromWeb(response.body as any), handle.createWriteStream());
    await fs.promises.rename(temp, target);
    ownsTemp = false;
  } catch (error) { await response.body.cancel().catch(() => undefined); if (ownsTemp) await fs.promises.rm(temp, { force: true }); throw error }
  const copy = { root: cacheRoot, target, rootInfo, info: await fs.promises.lstat(target) };
  if (!validOpenedCopy(copy)) throw new Error('The local Files copy changed before it could be opened.');
  const key = copyKey(input.fileId, versionId);
  openedFileCopies.delete(key);
  openedFileCopies.set(key, copy);
  if (openedFileCopies.size > 256) openedFileCopies.delete(openedFileCopies.keys().next().value!);
  return target;
}

async function openReference(input:{ fileId:string; versionId?:string }):Promise<void> {
  const error = await shell.openPath(await materializeReference(input));
  if (error) throw new Error(error);
}

const runFile = promisify(execFile);
const recentAppsPath = () => path.join(app.getPath('userData'), 'files-open-with.json');
async function recentApplications():Promise<Record<string, string[]>> {
  try { const value = JSON.parse(await fs.promises.readFile(recentAppsPath(), 'utf8')); return value && typeof value === 'object' ? value : {} } catch { return {} }
}
async function saveRecentApplications(value:Record<string, string[]>):Promise<void> {
  const target = recentAppsPath(); const temp = `${ target }.${ process.pid }.tmp`;
  await fs.promises.mkdir(path.dirname(target), { recursive:true }); await fs.promises.writeFile(temp, JSON.stringify(value), { mode:0o600 }); await fs.promises.rename(temp, target);
}
function fileExtension(name:string):string { return path.extname(name).toLowerCase() || '<none>' }
async function openWithApplication(event:IpcMainInvokeEvent, input:{ fileId:string; versionId?:string; application?:string }):Promise<{ application?:string; recentApplications:string[] }> {
  const { file } = await authorizedReference(input); const extension = fileExtension(String(file.path || 'file'));
  let application = input.application;
  if (!application) {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options:OpenDialogOptions = { title:'Open with application', defaultPath:'/Applications', properties:['openFile'], filters:[{ name:'Applications', extensions:['app'] }] };
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return { recentApplications:(await recentApplications())[extension] ?? [] };
    application = picked.filePaths[0];
  }
  if (process.platform !== 'darwin' || !application.endsWith('.app')) throw new Error('Open with is currently available for macOS applications.');
  const applicationInfo = await fs.promises.lstat(application);
  if (!path.isAbsolute(application) || !applicationInfo.isDirectory() || applicationInfo.isSymbolicLink()) throw new Error('Choose a valid macOS application.');
  const target = await materializeReference(input);
  await runFile('/usr/bin/open', ['-a', application, target]);
  const settings = await recentApplications(); settings[extension] = [application, ...(settings[extension] ?? []).filter(item => item !== application)].slice(0, 5); await saveRecentApplications(settings);
  return { application, recentApplications:settings[extension] };
}

function validOpenedCopy(copy:OpenedFileCopy):boolean {
  try {
    const root = fs.lstatSync(copy.root); const info = fs.lstatSync(copy.target);

    return root.isDirectory() && root.dev === copy.rootInfo.dev && root.ino === copy.rootInfo.ino &&
      fs.realpathSync(copy.root) === copy.root && path.dirname(copy.target) === copy.root &&
      info.isFile() && info.nlink === 1 && fs.realpathSync(copy.target) === copy.target &&
      info.dev === copy.info.dev && info.ino === copy.info.ino && info.size === copy.info.size &&
      info.mtimeMs === copy.info.mtimeMs && info.ctimeMs === copy.info.ctimeMs;
  } catch { return false }
}

async function revealMaterializedCopy(input:{ fileId:string; versionId?:string }):Promise<FilesRevealResult> {
  const { versionId } = await authorizedReference(input);
  const key = copyKey(input.fileId, versionId);
  const copy = openedFileCopies.get(key);
  if (!copy) return { status: 'unavailable', code: 'no-local-copy', reason: 'No verified local copy is available. Open this version first, then reveal its downloaded copy. An original host file is not available through this action.' };
  // Re-authorize content, including collection access and draft visibility, even for cached copies.
  const response = await filesClient.stream(`/v1/files/${ encodeURIComponent(input.fileId) }/preview?versionId=${ encodeURIComponent(versionId) }`, { method: 'HEAD' });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Files content authorization failed (${ response.status })`);
  // Keep the final filesystem validation and native call in the same turn.
  if (!validOpenedCopy(copy)) {
    openedFileCopies.delete(key);
    return { status: 'unavailable', code: 'local-copy-changed', reason: 'The local copy was moved, changed, or removed. Open this version again before revealing its downloaded copy.' };
  }
  shell.showItemInFolder(copy.target);

  return { status: 'revealed', target: 'materialized-copy', fileId: input.fileId, versionId };
}

async function revealReference(input:{ fileId:string; versionId?:string }):Promise<FilesRevealResult> {
  // The service authorizes the visible version and vouches for a current
  // watched original before main ever resolves a host path.
  const attestation = await nativeJson<OriginalRevealAttestation>('/v1/original-reveal/attest', input);
  if (!attestation || typeof attestation !== 'object') throw new Error('Files returned an invalid original reveal attestation.');
  if (attestation.status === 'unavailable') {
    if (attestation.code !== 'no-current-original') throw new Error('Files returned an invalid original reveal result.');
    return revealMaterializedCopy(input);
  }
  if (attestation.status !== 'attested' || typeof attestation.token !== 'string' || !attestation.token || attestation.token.length > 200 ||
      !Number.isSafeInteger(attestation.expiresAt) || attestation.expiresAt <= Date.now()) throw new Error('Files returned an invalid original reveal attestation.');
  const attested = originalTarget(attestation.target, input);
  const verified = await verifyOriginalTarget(attested).catch(() => {
    // Native filesystem errors contain absolute paths; keep those in main.
    throw new Error('The tracked original is unavailable, unsafe, or changed. Refresh Files and try again.');
  });
  if (attestation.expiresAt <= Date.now()) throw new Error('Original reveal authorization expired while verifying the file. Try again.');
  const redeemed = await nativeJson<{ status:'redeemed'; target:unknown }>('/v1/original-reveal/redeem', { token: attestation.token });
  if (redeemed.status !== 'redeemed') throw new Error('Files returned an invalid original reveal redemption.');
  const current = originalTarget(redeemed.target, input);
  if (!sameOriginalTarget(attested, current)) throw new Error('The tracked original changed before it could be revealed.');
  const finalCandidate = await recheckOriginalTarget(current, verified).catch(() => {
    throw new Error('The tracked original changed or became unavailable before it could be revealed.');
  });
  // Electron accepts only a string path, not our verified descriptor. A
  // same-user filesystem writer can still race the close and native shell call.
  shell.showItemInFolder(finalCandidate);

  return { status: 'revealed', target: 'tracked-original', fileId: input.fileId, versionId: current.versionId };
}

async function downloadReference(event:Electron.IpcMainInvokeEvent, input:{ fileId:string; versionId?:string; name:string }):Promise<boolean> {
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const picked = owner ? await dialog.showSaveDialog(owner, { defaultPath: path.basename(input.name) }) : await dialog.showSaveDialog({ defaultPath: path.basename(input.name) });
  if (picked.canceled || !picked.filePath) return false;
  const query = input.versionId ? `?versionId=${ encodeURIComponent(input.versionId) }` : '';
  const response = await filesClient.stream(`/v1/files/${ encodeURIComponent(input.fileId) }/download${ query }`);
  if (!response.ok || !response.body) throw new Error(`Files download failed (${ response.status })`);
  const temp = `${ picked.filePath }.sulla-partial-${ process.pid }-${ randomUUID() }`;
  let ownsTemp = false;
  try {
    const handle = await fs.promises.open(temp, 'wx', 0o600); ownsTemp = true;
    await pipeline(Readable.fromWeb(response.body as any), handle.createWriteStream());
    await fs.promises.rename(temp, picked.filePath);
    ownsTemp = false;
  } catch (error) { if (ownsTemp) await fs.promises.rm(temp, { force: true }); throw error }
  return true;
}

async function downloadReferences(event:Electron.IpcMainInvokeEvent, items:{ fileId: string; name: string; versionId?: string }[]):Promise<{ count: number; error?: string }> {
  if (!Array.isArray(items) || !items.length || items.length > 250 || items.some(item => !item.fileId || !item.name || path.basename(item.name) !== item.name)) throw new Error('Choose between 1 and 250 valid files to download.');
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const picked = owner ? await dialog.showOpenDialog(owner, { title: 'Download selected Files', properties: ['openDirectory', 'createDirectory'] }) : await dialog.showOpenDialog({ title: 'Download selected Files', properties: ['openDirectory', 'createDirectory'] });
  if (picked.canceled || !picked.filePaths[0]) return { count: 0 };
  const directory = picked.filePaths[0]; const names = items.map(item => path.basename(item.name));
  if (new Set(names).size !== names.length) throw new Error('Two selected files have the same name. Move them into separate folders before downloading together.');
  for (const name of names) if (await fs.promises.lstat(path.join(directory, name)).then(() => true, () => false)) throw new Error(`${ name } already exists in the selected folder. Nothing was downloaded.`);
  const created:string[] = [];
  try {
    for (const [index, item] of items.entries()) {
      const response = await filesClient.stream(`/v1/files/${ encodeURIComponent(item.fileId) }/download${ item.versionId ? `?versionId=${ encodeURIComponent(item.versionId) }` : '' }`);
      if (!response.ok || !response.body) throw new Error(`Files download failed (${ response.status })`);
      const target = path.join(directory, names[index]); const temp = path.join(directory, `.sulla-partial-${ process.pid }-${ randomUUID() }`);
      const handle = await fs.promises.open(temp, 'wx', 0o600);
      try { await pipeline(Readable.fromWeb(response.body as any), handle.createWriteStream()); await fs.promises.link(temp, target); created.push(target) } catch (error) { await response.body.cancel().catch(() => undefined); await handle.close().catch(() => undefined); throw error } finally { await fs.promises.rm(temp, { force: true }) }
    }
    return { count: created.length };
  } catch (error) { return { count: created.length, error: `${ created.length } file${ created.length === 1 ? '' : 's' } downloaded before the remaining download failed: ${ error instanceof Error ? error.message : String(error) }` } }
}

const mediaCapabilities = new Map<string, { fileId: string; versionId?: string; expiresAt: number }>();
function mediaCapability(input:{ fileId: string; versionId?: string }):string {
  const now = Date.now();
  for (const [token, capability] of mediaCapabilities) if (capability.expiresAt <= now) mediaCapabilities.delete(token);
  const token = randomUUID();
  mediaCapabilities.set(token, { ...input, expiresAt: now + 4 * 60 * 60_000 });
  return `sulla-files-media://content/${ token }`;
}

function passiveMedia(mime:string):boolean {
  return /^(?:video\/|audio\/)/i.test(mime) || /^(?:image\/(?:avif|gif|jpeg|png|webp)|application\/pdf)(?:;|$)/i.test(mime);
}

function initFilesMediaProtocol():void {
  if (protocol.isProtocolHandled('sulla-files-media')) return;
  protocol.handle('sulla-files-media', async(request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'content' || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
    const capability = mediaCapabilities.get(parts[0]);
    if (!capability || capability.expiresAt <= Date.now()) { mediaCapabilities.delete(parts[0]); return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } }) }
    const endpoint = `/v1/files/${ encodeURIComponent(capability.fileId) }/preview${ capability.versionId ? `?versionId=${ encodeURIComponent(capability.versionId) }` : '' }`;
    const upstream = await filesClient.stream(endpoint, { method: request.method, headers: request.headers.get('range') ? { range: request.headers.get('range')! } : undefined }, request.signal);
    const mime = upstream.headers.get('content-type') ?? '';
    if (upstream.ok && !passiveMedia(mime)) { await upstream.body?.cancel(); return new Response(null, { status: 415, headers: { 'cache-control': 'no-store' } }) }
    const headers = new Headers(upstream.headers);
    headers.set('cache-control', 'private, no-store');
    headers.set('x-content-type-options', 'nosniff');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  });
}

export function initSullaFilesIpc():void {
  ipcMain.handle('sulla-files:folders', (_event, input:{ collectionId:string; details?:boolean }) => json(`/v1/folders?collectionId=${ encodeURIComponent(input.collectionId) }${ input.details ? '&details=true' : '' }`));
  ipcMain.handle('sulla-files:operation-capabilities', (_event, input:{ collectionId:string }) => json(`/v1/database-file-operations/capabilities?collectionId=${ encodeURIComponent(input.collectionId) }`));
  ipcMain.handle('sulla-files:folder-operation-state', (_event, input:{ collectionId:string; path:string }) => filesClient.folderOperationState(input.collectionId, input.path));
  ipcMain.handle('sulla-files:operation-submit', (_event, input:FilesOperationRequest) => json('/v1/database-file-operations', { method: 'POST', body: JSON.stringify(input) }));
  ipcMain.handle('sulla-files:operation-status', (_event, input:{ operationId:string }) => json(`/v1/database-file-operations/${ encodeURIComponent(input.operationId) }`));
  ipcMain.handle('sulla-files:operation-cancel', (_event, input:{ operationId:string }) => json(`/v1/database-file-operations/${ encodeURIComponent(input.operationId) }/cancel`, { method: 'POST', body: '{}' }));
  ipcMain.handle('sulla-files:operation-retry', (_event, input:{ operationId:string; request:FilesOperationRetry }) => json(`/v1/database-file-operations/${ encodeURIComponent(input.operationId) }/retry`, { method: 'POST', body: JSON.stringify(input.request) }));
  ipcMain.handle('sulla-files:operation-undo', (_event, input:{ operationId:string }) => json(`/v1/database-file-operations/${ encodeURIComponent(input.operationId) }/undo`, { method: 'POST', body: '{}' }));
  try { initFilesMediaProtocol() } catch (error) { console.error('Files media protocol failed to initialize:', error) }
  const mountManager = getSullaFilesMountManager();
  mountManager.on('changed', status => {
    for (const contents of webContents.getAllWebContents()) contents.send('files-ui:native-runtime-changed', status);
  });
  ipcMain.handle('files-ui:native-runtime', () => mountManager.status());
  ipcMain.handle('sulla-files:collections', () => json('/v1/collections'));
  ipcMain.handle('sulla-files:list', (_event, input:{ collectionId: string; path?: string; trash?: boolean }) => json(`/v1/files?collectionId=${ encodeURIComponent(input.collectionId) }&path=${ encodeURIComponent(input.path ?? '') }&trash=${ input.trash === true }`));
  ipcMain.handle('sulla-files:create-empty-file', (_event,input:{collectionId:string;path:string}) => json('/v1/files/empty',{method:'POST',body:JSON.stringify(input)}));
  ipcMain.handle('sulla-files:search', (_event, input:{ query: string; collectionId?: string }) => json('/v1/search', { method: 'POST', body: JSON.stringify(input) }));
  ipcMain.handle('sulla-files:reindex', (_event, input:{ fileId: string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/reindex`, { method: 'POST' }));
  ipcMain.handle('sulla-files:stars', (_event, input:{ collectionId: string }) => json(`/v1/stars?collectionId=${ encodeURIComponent(input.collectionId) }`));
  ipcMain.handle('sulla-files:set-star', (_event, input:{ starred: boolean; collectionId: string; fileId?: string; folderPath?: string }) => json('/v1/stars', { method: input.starred ? 'PUT' : 'DELETE', body: JSON.stringify(input) }));
  ipcMain.handle('sulla-files:operate', (_event, input:{ action: 'move' | 'copy'; collectionId: string; items: { fileId?: string; folderPath?: string; targetPath: string }[] }) => json('/v1/file-operations', { method: 'POST', body: JSON.stringify(input) }));
  ipcMain.handle('sulla-files:metadata', (_event, input:{ fileId: string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }`));
  ipcMain.handle('sulla-files:history', (_event, input:{ fileId: string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/history`));
  ipcMain.handle('sulla-files:preview', async(_event, input:{ fileId: string; versionId?: string; thumbnail?: boolean }) => {
    const route = input.thumbnail ? 'thumbnail' : 'preview'; const query = input.versionId ? `?versionId=${ encodeURIComponent(input.versionId) }` : ''; const response = await filesClient.request(`/v1/files/${ encodeURIComponent(input.fileId) }/${ route }${ query }`);
    if (!response.ok) throw new Error(`Files preview failed (${ response.status })`);

    return { mime: response.headers.get('content-type') ?? 'application/octet-stream', data: new Uint8Array(await response.arrayBuffer()) };
  });
  ipcMain.handle('sulla-files:upload', (_event, input:{ collectionId:string; path:string; mime?:string; data:Uint8Array }) => json(`/v1/files/upload?collectionId=${ encodeURIComponent(input.collectionId) }&path=${ encodeURIComponent(input.path) }`, { method: 'PUT', headers: { 'content-type': input.mime ?? 'application/octet-stream' }, body: Buffer.from(input.data) }));
  ipcMain.handle('sulla-files:trash', (_event, input:{ fileId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }`, { method: 'DELETE' }));
  ipcMain.handle('sulla-files:trash-list', (_event, input:{ collectionId:string }) => json(`/v1/trash?collectionId=${ encodeURIComponent(input.collectionId) }`));
  ipcMain.handle('sulla-files:trash-restore', (_event, input:{ id:string; kind:FilesTrashItem['kind']; expectedRevision:string; currentTombstone:{ id:string; receiptId?:string } }) =>
    json(`/v1/trash/${ encodeURIComponent(input.id) }/restore`, { method: 'POST', body: JSON.stringify({ kind: input.kind, expectedRevision: input.expectedRevision, currentTombstone: input.currentTombstone }) }));
  ipcMain.handle('sulla-files:trash-purge', (_event, input:{ id:string; kind?:'folder'; expectedRevision:string; currentTombstone:{ id:string; kind?:'receipt'; receiptId?:string }; invalidateUndo?:true }) =>
    json(`/v1/trash/${ encodeURIComponent(input.id) }/purge`, { method: 'DELETE', body: JSON.stringify({ ...(input.kind ? { kind: input.kind } : {}), expectedRevision: input.expectedRevision, currentTombstone: input.currentTombstone, ...(input.invalidateUndo ? { invalidateUndo: true } : {}) }) }));
  ipcMain.handle('sulla-files:restore-version', (_event, input:{ fileId:string; versionId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/restore`, { method: 'POST', body: JSON.stringify({ versionId: input.versionId }) }));
  ipcMain.handle('sulla-files:lifecycle', (_event, input:{ fileId:string; settings:Record<string, unknown> }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/lifecycle`, { method: 'PATCH', body: JSON.stringify(input.settings) }));
  ipcMain.handle('sulla-files:checkout', (_event, input:{ fileId:string; force?:boolean }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/checkout`, { method: input.force ? 'DELETE' : 'POST', body: input.force ? JSON.stringify({ force: true }) : undefined }));
  ipcMain.handle('sulla-files:checkin', (_event, input:{ fileId:string; versionId:string; kind:'major'|'minor'; comment:string; publish:boolean }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/checkin`, { method: 'POST', body: JSON.stringify({ versionId: input.versionId, kind: input.kind, comment: input.comment, publish: input.publish }) }));
  ipcMain.handle('sulla-files:publish', (_event, input:{ fileId:string; versionId:string; expectedDraftVersionId?:string|null; comment?:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/publish`, { method: 'POST', body: JSON.stringify({ versionId: input.versionId, expectedDraftVersionId: input.expectedDraftVersionId, comment: input.comment }) }));
  ipcMain.handle('sulla-files:retention', (_event, input:{ fileId:string; policy:Record<string, unknown> }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/retention`, { method: 'PATCH', body: JSON.stringify(input.policy) }));
  ipcMain.handle('sulla-files:record-lock', (_event, input:{ fileId:string; status:'ordinary'|'policy' }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/record-lock`, { method: 'POST', body: JSON.stringify({ kind: input.status }) }));
  ipcMain.handle('sulla-files:record-unlock', (_event, input:{ fileId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/record-lock`, { method: 'DELETE' }));
  ipcMain.handle('sulla-files:disposal-review', (_event, input:{ fileId:string; decision:'approve'|'reject'|'extend'; extendedUntil?:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/disposal-review`, { method: 'POST', body: JSON.stringify({ decision: input.decision, extendedUntil: input.extendedUntil }) }));
  ipcMain.handle('sulla-files:shares', (_event, input:{ collectionId:string }) => json(`/v1/collections/${ encodeURIComponent(input.collectionId) }/shares`, {}, true));
  ipcMain.handle('sulla-files:share', (_event, input:{ collectionId:string; folderPath:string; principalType:'user' | 'group'; principalId:string; role:'view' | 'edit' }) => json(`/v1/collections/${ encodeURIComponent(input.collectionId) }/shares`, { method: 'POST', body: JSON.stringify(input) }, true));
  ipcMain.handle('sulla-files:unshare', (_event, input:{ collectionId:string; folderPath:string; principalType:'user' | 'group'; principalId:string }) => json(`/v1/collections/${ encodeURIComponent(input.collectionId) }/shares`, { method: 'DELETE', body: JSON.stringify(input) }, true));
  ipcMain.handle('sulla-files:file-shares', (_event, input:{ fileId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/shares`, {}, true));
  ipcMain.handle('sulla-files:share-file', (_event, input:{ fileId:string; principalType:'user' | 'group'; principalId:string; role:'view' | 'edit' }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/shares`, { method: 'POST', body: JSON.stringify(input) }, true));
  ipcMain.handle('sulla-files:update-file-share', (_event, input:{ fileId:string; shareId:string; role:'view' | 'edit' }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/shares/${ encodeURIComponent(input.shareId) }`, { method: 'PATCH', body: JSON.stringify({ role: input.role }) }, true));
  ipcMain.handle('sulla-files:unshare-file', (_event, input:{ fileId:string; shareId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/shares/${ encodeURIComponent(input.shareId) }`, { method: 'DELETE' }, true));
  ipcMain.handle('sulla-files:members', (_event, input:{ orgId:string }) => json(`/v1/orgs/${ encodeURIComponent(input.orgId) }/members`, {}, true));
  ipcMain.handle('sulla-files:keep', (_event, input:{ fileId:string; collectionId:string; path?:string }) => json(`/v1/agent-files/${ encodeURIComponent(input.fileId) }/keep`, { method: 'POST', body: JSON.stringify({ collectionId: input.collectionId, path: input.path }) }));
  ipcMain.handle('sulla-files:keep-conflict-copies', (_event, input:{ fileId:string; currentVersionId:string; sourceFileId:string; sourceVersionId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/conflicts/keep-both`, { method: 'POST', body: JSON.stringify(input) }));
  ipcMain.handle('files-ui:capabilities', async() => {
    const [status, cloudAvailable, residencyResult] = await Promise.all([
      getSullaFilesWatcher().status(),
      cloudFilesAvailable(),
      json('/v1/residency-capabilities')
        .then((residency:Record<string, unknown>) => ({ residency, reason: '' }))
        .catch((error) => ({ residency: undefined, reason: error instanceof Error ? error.message : 'Online-only residency is unavailable.' })),
    ]);
    const { residency, reason: onlineOnlyReason } = residencyResult;
    const onlineOnly = residency?.onlineOnly === true && residency.keepOnComputer === true &&
      residency.authenticatedRemote === true && residency.verifiedRecovery === true;

    return {
      orgSharing:          status.serverConfigured && status.state !== 'error',
      publicLinks:         cloudAvailable && status.state !== 'error',
      onlineOnly,
      keepOnComputer:      onlineOnly,
      authenticatedRemote: onlineOnly,
      verifiedRecovery:    onlineOnly,
      onlineOnlyReason:    onlineOnly ? '' : onlineOnlyReason || 'Online-only recovery is not fully configured.',
    };
  });
  ipcMain.handle('files-ui:residency-status', (_event, input:{ fileId: string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/residency`));
  ipcMain.handle('files-ui:set-residency', (_event, input:{ fileId: string; desiredState: 'local' | 'online-only' }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/residency`, { method: 'POST', body: JSON.stringify({ desiredState: input.desiredState }), signal: AbortSignal.timeout(RESIDENCY_TRANSFER_TIMEOUT_MS) }));
  ipcMain.handle('files-ui:recent-references', async(_event, limit = 5) => {
    const groups = await collectionsWithFiles();
    return groups.flatMap(item => item.files.map(file => reference(file, item.collection)))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, Math.max(1, Math.min(Number(limit), 20)));
  });
  ipcMain.handle('files-ui:pick-reference', async(event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const roots = (await getSullaFilesRootRegistry().list()).filter(root => root.activation === 'active' && root.collectionId);
    const options:Electron.OpenDialogOptions = {
      title:       'Attach from Sulla Files',
      properties:  ['openFile', 'multiSelections'],
    };
    const defaultRoot = roots.find(root => root.id === 'default')?.path;
    if (defaultRoot) options.defaultPath = defaultRoot;
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (picked.canceled) return [];

    const references:ChatFilesReference[] = [];
    const importPaths:string[] = [];
    for (const selected of picked.filePaths) {
      const resolved = await fs.promises.realpath(selected);
      const info = await fs.promises.stat(resolved);
      if (!info.isFile()) continue;
      const root = roots.find(candidate => pathWithin(candidate.path, resolved));
      const existing = root ? await findReferenceByPath(path.relative(root.path, resolved), root.collectionId) : undefined;
      if (existing?.versionId) references.push(existing);
      else importPaths.push(resolved);
    }
    if (!importPaths.length) return references;
    const imported = await importChatFiles(importPaths);
    if (Array.isArray(imported)) return [...references, ...imported];

    return { references: [...references, ...imported.references], error: imported.error } satisfies PartialChatFilesImport;
  });
  ipcMain.handle('files-ui:chat-inventory', async(_event, input:{ runIds:string[]; threadId:string }) => {
    try {
      const files = await filesClient.json<any[]>('/v1/agent-files/query', { method: 'POST', body: JSON.stringify(input) });

      return files.map(file => reference(file, {
        id: file.collection_id, kind: file.collection_kind, agent_run_id: file.agent_run_id,
      }));
    } catch (error) {
      const status = error instanceof FilesApiError ? error.status : 'request-failed';

      console.warn(`[SullaFiles] Chat inventory is temporarily unavailable (status=${ status })`);
      return [];
    }
  });
  ipcMain.handle('files-ui:reference-content', async(_event, input:{ fileId:string; versionId?:string }) => {
    const query = input.versionId ? `?versionId=${ encodeURIComponent(input.versionId) }` : '';
    const response = await filesClient.request(`/v1/files/${ encodeURIComponent(input.fileId) }/preview${ query }`);
    if (!response.ok) throw new Error(`Files content failed (${ response.status })`);
    return { mime: response.headers.get('content-type') ?? 'application/octet-stream', data: new Uint8Array(await response.arrayBuffer()) };
  });
  ipcMain.handle('files-ui:capture-screenshot', async(_event, mode:ScreenshotMode = 'area') => {
    const capture = await getSullaFilesCaptureService().screenshot(mode);
    const primaryRoot = (await getSullaFilesRootRegistry().list()).find(root => root.id === 'default' && root.activation === 'active' && root.collectionId);
    const file = primaryRoot ? await findReferenceByPath(capture.relativePath, primaryRoot.collectionId) : undefined;
    if (!file?.versionId) throw new Error('The screenshot was saved to Files, but its durable version is not ready yet. Try again in a moment.');

    return { reference: file };
  });
  ipcMain.handle('files-ui:toggle-recording', (_event, input:{ mic: boolean; camera: boolean }) => getSullaFilesCaptureService().toggleRecording(input));
  ipcMain.handle('files-ui:create-link', (_event, input:CreateShareInput) => getSullaFilesLinkService().create(input));
  ipcMain.handle('files-ui:list-links', () => getSullaFilesLinkService().list());
  ipcMain.handle('files-ui:revoke-link', (_event, id:string) => getSullaFilesLinkService().revoke(id));
  ipcMain.handle('files-ui:update-link', (_event, input:{ id: string; options: Partial<CreateShareInput> }) => getSullaFilesLinkService().update(input.id, input.options));
  ipcMain.handle('files-ui:set-link-keep', (_event, input:{ id: string; enabled: boolean }) => getSullaFilesLinkService().update(input.id, { keepAvailable: input.enabled }));
  ipcMain.handle('files-ui:restore-link', (_event, input:{ id: string; password?: string }) => getSullaFilesLinkService().restore(input.id, input.password));
  ipcMain.handle('files-ui:link-activity', (_event, id?:string) => getSullaFilesLinkService().activity(id));
  ipcMain.handle('files-ui:status', () => getSullaFilesWatcher().status());
  ipcMain.handle('files-preferences:list-roots', () => getSullaFilesRootRegistry().list());
  ipcMain.handle('files-preferences:add-root', event => getSullaFilesRootRegistry().add(BrowserWindow.fromWebContents(event.sender) ?? undefined));
  ipcMain.handle('files-preferences:update-root', (_event, input:{ id: string; syncMode?: 'local' | 'server'; paused?: boolean; exclusions?: string[] }) => {
    const { id, ...updates } = input;
    return getSullaFilesRootRegistry().update(id, updates);
  });
  ipcMain.handle('files-preferences:remove-root', (_event, id:string) => getSullaFilesRootRegistry().remove(id));
  ipcMain.handle('files-backups:list', () => filesClient.backupJson('/v1/local/backups'));
  ipcMain.handle('files-backups:add', (_event,input:{kind:'local'|'nas'|'s3';label:string;config:Record<string,unknown>}) => filesClient.backupJson('/v1/local/backups/destinations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}));
  ipcMain.handle('files-backups:remove',(_event,id:string)=>getSullaFilesBackups().remove(id));
  ipcMain.handle('files-backups:run', (_event,id:string) => filesClient.backupJson(`/v1/local/backups/${ encodeURIComponent(id) }/run`,{method:'POST'}));
  ipcMain.handle('files-ui:set-paused', (_event, paused:boolean) => getSullaFilesWatcher().setPaused(paused));
  ipcMain.handle('files-ui:open-folder', () => {
    throw new Error('Files are stored securely in Sulla. Download a file or selected files to export copies to Finder.');
  });
  ipcMain.handle('files-ui:create-folder', async(_event, input:string | { collectionId?: string; path: string }) => {
    const relativePath = typeof input === 'string' ? input : input.path;
    const collectionId = typeof input === 'string' ? undefined : input.collectionId;
    if (!collectionId || !UUID.test(collectionId)) throw new Error('Choose a Files collection before creating a folder');
    await json('/v1/folders', { method: 'POST', body: JSON.stringify({ collectionId, path: relativePath }) });
  });
  ipcMain.handle('files-ui:update-folder-description', async(_event,input:{folderId:string;description:string;namingHint?:string}) => {
    if (!UUID.test(input.folderId)) throw new Error('Choose a valid Files folder');
    await json(`/v1/folders/${encodeURIComponent(input.folderId)}/description`,{method:'PATCH',body:JSON.stringify({description:input.description,namingHint:input.namingHint})});
  });
  ipcMain.handle('files-ui:delete-folder', async(_event, input:{ collectionId:string; path:string }) => {
    if (!UUID.test(input.collectionId)) throw new Error('Choose a Files collection before removing a folder');
    await json(`/v1/folders?collectionId=${ encodeURIComponent(input.collectionId) }&path=${ encodeURIComponent(input.path) }`, { method: 'DELETE' });
  });
  ipcMain.handle('files-ui:open-file', (_event, input:{ fileId:string; versionId?:string }) => openReference(input));
  ipcMain.handle('files-ui:open-default', (_event, input:{ fileId:string; versionId?:string }) => openReference(input));
  ipcMain.handle('files-ui:open-with', (event, input:{ fileId:string; versionId?:string; application?:string }) => openWithApplication(event, input));
  ipcMain.handle('files-ui:recent-apps', async(_event, input:{ name:string }) => (await recentApplications())[fileExtension(input.name)] ?? []);
  ipcMain.handle('files-ui:reveal-file', (_event, input:{ fileId:string; versionId?:string }) => revealReference(input));
  ipcMain.handle('files-ui:download-file', (event, input:{ fileId:string; versionId?:string; name:string }) => downloadReference(event, input));
  ipcMain.handle('files-ui:download-files', (event, input:{ fileId:string; versionId?:string; name:string }[]) => downloadReferences(event, input));
  ipcMain.handle('files-ui:media-url', async(event, input:{ fileId:string; versionId?:string }) => {
    const senderUrl = event.senderFrame?.url;
    if (!senderUrl || new URL(senderUrl).protocol !== 'app:') throw new Error('Files media URLs are only available to the Sulla application');
    await json(`/v1/files/${ encodeURIComponent(input.fileId) }`);
    return mediaCapability(input);
  });
  ipcMain.handle('files-ui:pick-upload', async(event, input:string | { collectionId?: string; destination?: string } = '') => {
    const destination = typeof input === 'string' ? input : input.destination ?? '';
    const collectionId = typeof input === 'string' ? undefined : input.collectionId;
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const picked = owner
      ? await dialog.showOpenDialog(owner, { title: 'Upload to Sulla Files', properties: ['openFile', 'multiSelections'] })
      : await dialog.showOpenDialog({ title: 'Upload to Sulla Files', properties: ['openFile', 'multiSelections'] });
    if (picked.canceled) return 0;

    return importPaths(picked.filePaths, destination, progress => event.sender.send('files-ui:upload-progress', progress), collectionId);
  });
  ipcMain.handle('files-ui:pick-upload-references', async(event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    return pickAndImportChatFiles(owner);
  });
  ipcMain.handle('files-experiment:pick-native-source', async(event) => {
    if (!mountManager.status().ready) throw new Error('Native Files runtime is not ready');
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options:Electron.OpenDialogOptions = {
      title:                   'Choose one synthetic file for the Files source experiment',
      properties:              ['openFile'],
      securityScopedBookmarks: process.platform === 'darwin' && process.mas,
    };
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return undefined;
    await getSullaFilesWatcher().prepareNativeSourceSession();
    if (process.mas && !picked.bookmarks?.[0]) throw new Error('The Mac App Store build did not return the required security-scoped file grant');
    const release = picked.bookmarks?.[0] ? app.startAccessingSecurityScopedResource(picked.bookmarks[0]) as () => void : undefined;
    const gateway = getSullaFilesSourceGateway();
    const handle = await gateway.registerExactFile(picked.filePaths[0], release);
    try {
      const snapshot = await gateway.read(handle);
      const operationId = randomUUID();
      const file = await getSullaFilesWatcher().ingestNativeSource({
        operationId,
        handle,
        sourceRevision: snapshot.revision,
        contentHash:    snapshot.contentHash,
        name:           path.basename(picked.filePaths[0]),
        bytes:          snapshot.bytes,
      });
      return {
        handle,
        operationId,
        sourceRevision: snapshot.revision,
        contentHash:    snapshot.contentHash,
        fileId:         file.id,
        versionId:      file.current_version_id,
        path:           file.path,
      };
    } catch (error) {
      gateway.revoke(handle);
      throw error;
    }
  });
  ipcMain.handle('files-experiment:list-native-sources', async() => {
    if (!mountManager.status().ready) return [];
    return (await getSullaFilesWatcher().listNativeSources()).map(({ handle: _handle, versionId: _versionId, path: _path, sourceRevision: _sourceRevision, sourceHash: _sourceHash, ...source }) => source);
  });
  ipcMain.handle('files-experiment:recover-native-source', async(event, fileId:string) => {
    if (!mountManager.status().ready || !UUID.test(fileId)) throw new Error('Native Files recovery input is invalid');
    const source = (await getSullaFilesWatcher().listNativeSources()).find(item => item.fileId === fileId);
    if (source?.state !== 'reselect-required') throw new Error('Native Files source does not require reselection');
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options:Electron.OpenDialogOptions = { title: `Reselect ${ source.name }`, properties: ['openFile'], securityScopedBookmarks: process.platform === 'darwin' && process.mas };
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return undefined;
    await getSullaFilesWatcher().prepareNativeSourceSession();
    if (process.mas && !picked.bookmarks?.[0]) throw new Error('The Mac App Store build did not return the required security-scoped file grant');
    const release = picked.bookmarks?.[0] ? app.startAccessingSecurityScopedResource(picked.bookmarks[0]) as () => void : undefined;
    const gateway = getSullaFilesSourceGateway();
    const handle = await gateway.registerExactFile(picked.filePaths[0], release);
    try {
      const snapshot = await gateway.read(handle);
      const recovered = await getSullaFilesWatcher().reselectInterruptedNativePublication({
        fileId:         source.fileId,
        previousHandle: source.handle,
        handle,
        sourceRevision: snapshot.revision,
        sourceHash:     snapshot.contentHash,
      });
      if (recovered) {
        gateway.revoke(source.handle);
        return { fileId: source.fileId, versionId: source.versionId };
      }
      const result = await getSullaFilesWatcher().ingestNativeSource({
        operationId:    randomUUID(),
        handle,
        sourceRevision: snapshot.revision,
        contentHash:    snapshot.contentHash,
        name:           source.name,
        bytes:          snapshot.bytes,
        fileId:         source.fileId,
        baseVersionId:  source.versionId,
        filesPath:      source.path,
      });
      gateway.revoke(source.handle);
      return { fileId: result.id, versionId: result.current_version_id };
    } catch (error) { gateway.revoke(handle); throw error }
  });
  ipcMain.handle('files-experiment:revoke-native-source', (_event, handle:string) => {
    if (!mountManager.status().ready || !/^[A-Za-z0-9_-]{43}$/.exec(handle)) throw new Error('Native Files source handle is invalid');
    getSullaFilesSourceGateway().revoke(handle);
  });
  ipcMain.handle('files-experiment:publish-native-source', async(_event, input:{ handle: string; sourceRevision: string; fileId: string; versionId: string }) => {
    if (!mountManager.status().ready) throw new Error('Native Files runtime is not ready');
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.handle) || !/^[a-f0-9]{64}$/i.test(input.sourceRevision) ||
        !UUID.test(input.fileId) || !UUID.test(input.versionId)) throw new Error('Native Files publication input is invalid');
    const response = await filesClient.stream(`/v1/files/${ encodeURIComponent(input.fileId) }/download?versionId=${ encodeURIComponent(input.versionId) }`);
    const bytes = await readBoundedResponse(response);
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const operationId = randomUUID();
    const watcher = getSullaFilesWatcher();
    await watcher.planNativePublication({
      operationId,
      handle:         input.handle,
      sourceRevision: input.sourceRevision,
      contentHash,
      fileId:         input.fileId,
      baseVersionId:  input.versionId,
    });
    try {
      const before = await getSullaFilesSourceGateway().read(input.handle);
      if (before.revision !== input.sourceRevision) throw new Error('Native source changed before publication');
      const result = await getSullaFilesSourceGateway().write(input.handle, input.sourceRevision, bytes);
      if (result.contentHash !== contentHash) throw new Error('Native source publication returned an unexpected content hash');
      await watcher.finishNativePublication(operationId, {
        nextSourceRevision:      result.revision,
        originalSourceRevision: input.sourceRevision,
        originalSourceHash:     before.contentHash,
        currentSourceHash:      contentHash,
        filesBaseVersionId:     input.versionId,
        currentFilesVersionId:  input.versionId,
      });
      return { operationId, sourceRevision: result.revision, contentHash: result.contentHash };
    } catch (error) {
      await watcher.finishNativePublication(operationId, { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      throw error;
    }
  });
  ipcMain.handle('files-ui:upload-paths', (event, input:{ paths: string[]; destination?: string; collectionId?: string }) => importPaths(input.paths, input.destination, progress => event.sender.send('files-ui:upload-progress', progress), input.collectionId));
}
