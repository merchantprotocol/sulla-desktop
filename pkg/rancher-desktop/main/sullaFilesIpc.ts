import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { BrowserWindow, dialog, protocol, shell } from 'electron';

import { getIpcMainProxy } from './ipcMain';
import { getSullaFilesCaptureService, type ScreenshotMode } from './sullaFilesCapture';
import { pickAndImportChatFiles } from './sullaFilesChatImport';
import { getSullaFilesClient } from './sullaFilesClient';
import { createDirectoryWithinRoot } from './sullaFilesDirectory';
import { getSullaFilesLinkService, type CreateShareInput } from './sullaFilesLinkService';
import { getSullaFilesWatcher } from './sullaFilesWatcher';

import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';

const console = Logging.background;
const ipcMain = getIpcMainProxy(console);
const RESIDENCY_TRANSFER_TIMEOUT_MS = 30 * 60_000;
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

function safeTarget(root:string, name:string):string {
  const target = path.resolve(root, path.basename(name));
  if (!target.startsWith(`${ root }${ path.sep }`)) throw new Error('Upload path escapes the Sulla Files folder');

  return target;
}

async function availableTarget(root:string, name:string):Promise<string> {
  const original = safeTarget(root, name); const extension = path.extname(original); const stem = extension ? original.slice(0, -extension.length) : original;
  for (let index = 0; ; index++) {
    const candidate = index ? `${ stem } (${ index })${ extension }` : original;
    try { await fs.promises.access(candidate) } catch { return candidate }
  }
}

async function uploadDestination(root:string, relativePath:string):Promise<string> {
  if (path.isAbsolute(relativePath)) throw new Error('Upload destination must be inside the Sulla Files folder');
  const target = path.resolve(root, relativePath || '.');
  const [realRoot, realTarget] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(target)]);
  if (realTarget !== realRoot && !realTarget.startsWith(`${ realRoot }${ path.sep }`)) throw new Error('Upload destination escapes the Sulla Files folder');
  if (!(await fs.promises.lstat(target)).isDirectory()) throw new Error('Upload destination is not a folder');

  return realTarget;
}

async function importPaths(paths:string[], destination = '', progress?:(value:{ current:number; total:number; name:string; percent:number; done:boolean }) => void):Promise<number> {
  const watcher = getSullaFilesWatcher(); const targetRoot = await uploadDestination(watcher.folder, destination); let imported = 0;
  for (const [index, source] of paths.entries()) {
    const info = await fs.promises.stat(source);
    if (!info.isFile()) continue;
    progress?.({ current: index + 1, total: paths.length, name: path.basename(source), percent: 12, done: false });
    await fs.promises.copyFile(source, await availableTarget(targetRoot, source), fs.constants.COPYFILE_EXCL);
    imported++;
    progress?.({ current: index + 1, total: paths.length, name: path.basename(source), percent: 100, done: index + 1 === paths.length });
  }
  if (imported) await watcher.notifyRescan();

  return imported;
}

interface FileReference {
  fileId: string;
  versionId: string;
  path: string;
  name: string;
  mime: string;
  size: number;
  updatedAt: string;
  createdByType?: string;
  createdById?: string;
  collectionId?: string;
  collectionKind?: string;
  agentRunId?: string;
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

async function collectionsWithFiles():Promise<{ collection:any; files:any[] }[]> {
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

async function openReference(input:{ fileId:string; versionId?:string }):Promise<void> {
  const file = await json(`/v1/files/${ encodeURIComponent(input.fileId) }`);
  const versionId = input.versionId || file.current_version_id;
  if (!versionId) throw new Error('This file has no readable version.');
  const versions = await json(`/v1/files/${ encodeURIComponent(input.fileId) }/history`) as any[];
  if (!versions.some(version => version.id === versionId)) throw new Error('That file version is no longer available.');
  const response = await filesClient.stream(`/v1/files/${ encodeURIComponent(input.fileId) }/preview?versionId=${ encodeURIComponent(versionId) }`);
  if (!response.ok) throw new Error(`Files content failed (${ response.status })`);
  const cacheRoot = path.join(paths.cache, 'files-open');
  await fs.promises.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const safeId = `${ input.fileId }-${ versionId }`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeName = path.basename(String(file.path || 'file')).replace(/[^a-zA-Z0-9._ -]/g, '_');
  const target = path.join(cacheRoot, `${ safeId }-${ safeName }`);
  const temp = `${ target }.partial-${ process.pid }-${ randomUUID() }`;
  let ownsTemp = false;
  if (!response.body) throw new Error('Files content response was empty');
  try {
    const handle = await fs.promises.open(temp, 'wx', 0o600); ownsTemp = true;
    await pipeline(Readable.fromWeb(response.body as any), handle.createWriteStream());
    await fs.promises.rename(temp, target);
    ownsTemp = false;
  } catch (error) { if (ownsTemp) await fs.promises.rm(temp, { force: true }); throw error }
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
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

async function downloadReferences(event:Electron.IpcMainInvokeEvent, items:{ fileId:string; name:string; versionId?:string }[]):Promise<{ count:number; error?:string }> {
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

const mediaCapabilities = new Map<string, { fileId:string; versionId?:string; expiresAt:number }>();
function mediaCapability(input:{ fileId:string; versionId?:string }):string {
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
  try { initFilesMediaProtocol() } catch (error) { console.error('Files media protocol failed to initialize:', error) }
  ipcMain.handle('sulla-files:collections', () => json('/v1/collections'));
  ipcMain.handle('sulla-files:list', (_event, input:{ collectionId:string; path?:string; trash?:boolean }) => json(`/v1/files?collectionId=${ encodeURIComponent(input.collectionId) }&path=${ encodeURIComponent(input.path ?? '') }&trash=${ input.trash === true }`));
  ipcMain.handle('sulla-files:search', (_event, input:{ query:string; collectionId?:string }) => json('/v1/search', { method: 'POST', body: JSON.stringify(input) }));
  ipcMain.handle('sulla-files:stars', (_event, input:{ collectionId:string }) => json(`/v1/stars?collectionId=${ encodeURIComponent(input.collectionId) }`));
  ipcMain.handle('sulla-files:set-star', (_event, input:{ starred:boolean; collectionId:string; fileId?:string; folderPath?:string }) => json('/v1/stars', { method: input.starred ? 'PUT' : 'DELETE', body: JSON.stringify(input) }));
  ipcMain.handle('sulla-files:operate', (_event, input:{ action:'move' | 'copy'; collectionId:string; items:{ fileId?:string; folderPath?:string; targetPath:string }[] }) => json('/v1/file-operations', { method: 'POST', body: JSON.stringify(input) }));
  ipcMain.handle('sulla-files:metadata', (_event, input:{ fileId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }`));
  ipcMain.handle('sulla-files:history', (_event, input:{ fileId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/history`));
  ipcMain.handle('sulla-files:preview', async(_event, input:{ fileId:string; versionId?:string; thumbnail?:boolean }) => {
    const route = input.thumbnail ? 'thumbnail' : 'preview'; const query = input.versionId ? `?versionId=${ encodeURIComponent(input.versionId) }` : ''; const response = await filesClient.request(`/v1/files/${ encodeURIComponent(input.fileId) }/${ route }${ query }`);
    if (!response.ok) throw new Error(`Files preview failed (${ response.status })`);

    return { mime: response.headers.get('content-type') ?? 'application/octet-stream', data: new Uint8Array(await response.arrayBuffer()) };
  });
  ipcMain.handle('sulla-files:upload', (_event, input:{ collectionId:string; path:string; mime?:string; data:Uint8Array }) => json(`/v1/files/upload?collectionId=${ encodeURIComponent(input.collectionId) }&path=${ encodeURIComponent(input.path) }`, { method: 'PUT', headers: { 'content-type': input.mime ?? 'application/octet-stream' }, body: Buffer.from(input.data) }));
  ipcMain.handle('sulla-files:trash', (_event, input:{ fileId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }`, { method: 'DELETE' }));
  ipcMain.handle('sulla-files:trash-list', (_event, input:{ collectionId:string }) => json(`/v1/trash?collectionId=${ encodeURIComponent(input.collectionId) }`));
  ipcMain.handle('sulla-files:trash-restore', (_event, input:{ fileId:string }) => json(`/v1/trash/${ encodeURIComponent(input.fileId) }/restore`, { method: 'POST', body: '{}' }));
  ipcMain.handle('sulla-files:restore-version', (_event, input:{ fileId:string; versionId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/restore`, { method: 'POST', body: JSON.stringify({ versionId: input.versionId }) }));
  ipcMain.handle('sulla-files:shares', (_event, input:{ collectionId:string }) => json(`/v1/collections/${ encodeURIComponent(input.collectionId) }/shares`, {}, true));
  ipcMain.handle('sulla-files:share', (_event, input:{ collectionId:string; folderPath:string; principalType:'user' | 'group'; principalId:string; role:'view' | 'edit' }) => json(`/v1/collections/${ encodeURIComponent(input.collectionId) }/shares`, { method: 'POST', body: JSON.stringify(input) }, true));
  ipcMain.handle('sulla-files:unshare', (_event, input:{ collectionId:string; folderPath:string; principalType:'user' | 'group'; principalId:string }) => json(`/v1/collections/${ encodeURIComponent(input.collectionId) }/shares`, { method: 'DELETE', body: JSON.stringify(input) }, true));
  ipcMain.handle('sulla-files:file-shares', (_event, input:{ fileId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/shares`, {}, true));
  ipcMain.handle('sulla-files:share-file', (_event, input:{ fileId:string; principalType:'user' | 'group'; principalId:string; role:'view' | 'edit' }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/shares`, { method: 'POST', body: JSON.stringify(input) }, true));
  ipcMain.handle('sulla-files:update-file-share', (_event, input:{ fileId:string; shareId:string; role:'view' | 'edit' }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/shares/${ encodeURIComponent(input.shareId) }`, { method: 'PATCH', body: JSON.stringify({ role: input.role }) }, true));
  ipcMain.handle('sulla-files:unshare-file', (_event, input:{ fileId:string; shareId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/shares/${ encodeURIComponent(input.shareId) }`, { method: 'DELETE' }, true));
  ipcMain.handle('sulla-files:members', (_event, input:{ orgId:string }) => json(`/v1/orgs/${ encodeURIComponent(input.orgId) }/members`, {}, true));
  ipcMain.handle('sulla-files:keep', (_event, input:{ fileId:string; collectionId:string; path?:string }) => json(`/v1/agent-files/${ encodeURIComponent(input.fileId) }/keep`, { method: 'POST', body: JSON.stringify({ collectionId: input.collectionId, path: input.path }) }));
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
      orgSharing:  status.serverConfigured && status.state !== 'error',
      publicLinks: cloudAvailable && status.state !== 'error',
      onlineOnly,
      keepOnComputer: onlineOnly,
      authenticatedRemote: onlineOnly,
      verifiedRecovery: onlineOnly,
      onlineOnlyReason: onlineOnly ? '' : onlineOnlyReason || 'Online-only recovery is not fully configured.',
    };
  });
  ipcMain.handle('files-ui:residency-status', (_event, input:{ fileId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/residency`));
  ipcMain.handle('files-ui:set-residency', (_event, input:{ fileId:string; desiredState:'local' | 'online-only' }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/residency`, { method: 'POST', body: JSON.stringify({ desiredState: input.desiredState }), signal: AbortSignal.timeout(RESIDENCY_TRANSFER_TIMEOUT_MS) }));
  ipcMain.handle('files-ui:recent-references', async(_event, limit = 5) => {
    const groups = await collectionsWithFiles();
    return groups.flatMap(item => item.files.map(file => reference(file, item.collection)))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, Math.max(1, Math.min(Number(limit), 20)));
  });
  ipcMain.handle('files-ui:pick-reference', async(event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options = { title: 'Attach from Sulla Files', defaultPath: getSullaFilesWatcher().folder, properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[] };
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (picked.canceled) return [];
    const root = getSullaFilesWatcher().folder;
    const collections = await json('/v1/collections') as any[];
    const watchedCollection = collections.find(collection => collection.name === 'Files');
    if (!watchedCollection) throw new Error('The local Files collection is unavailable.');
    const refs:FileReference[] = [];
    for (const selected of picked.filePaths) {
      const [realRoot, resolved] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(selected)]);
      if (!resolved.startsWith(`${ realRoot }${ path.sep }`)) throw new Error('Choose a file inside ~/sulla/files');
      if (!(await fs.promises.stat(resolved)).isFile()) throw new Error('Choose a regular file from Sulla Files.');
      const relativePath = path.relative(realRoot, resolved).split(path.sep).join('/');
      const found = await findReferenceByPath(relativePath, watchedCollection.id);
      if (!found) throw new Error(`${ path.basename(selected) } is still being indexed. Try again after sync finishes.`);
      refs.push(found);
    }
    return refs;
  });
  ipcMain.handle('files-ui:reference-content', async(_event, input:{ fileId:string; versionId?:string }) => {
    const query = input.versionId ? `?versionId=${ encodeURIComponent(input.versionId) }` : '';
    const response = await filesClient.request(`/v1/files/${ encodeURIComponent(input.fileId) }/preview${ query }`);
    if (!response.ok) throw new Error(`Files content failed (${ response.status })`);
    return { mime: response.headers.get('content-type') ?? 'application/octet-stream', data: new Uint8Array(await response.arrayBuffer()) };
  });
  ipcMain.handle('files-ui:chat-inventory', async(_event, input:{ runIds:string[]; threadId:string }) => {
    const response = await filesClient.request('/v1/agent-files/query', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Chat Files inventory failed (${ response.status })`);
    const files = await response.json() as any[];
    return files.map(file => reference(file, { id: file.collection_id, kind: file.collection_kind, agent_run_id: file.agent_run_id }));
  });
  ipcMain.handle('files-ui:capture-screenshot', (_event, mode:ScreenshotMode = 'area') => getSullaFilesCaptureService().screenshot(mode));
  ipcMain.handle('files-ui:toggle-recording', (_event, input:{ mic:boolean; camera:boolean }) => getSullaFilesCaptureService().toggleRecording(input));
  ipcMain.handle('files-ui:create-link', (_event, input:CreateShareInput) => getSullaFilesLinkService().create(input));
  ipcMain.handle('files-ui:list-links', () => getSullaFilesLinkService().list());
  ipcMain.handle('files-ui:revoke-link', (_event, id:string) => getSullaFilesLinkService().revoke(id));
  ipcMain.handle('files-ui:update-link', (_event, input:{ id:string; options:Partial<CreateShareInput> }) => getSullaFilesLinkService().update(input.id, input.options));
  ipcMain.handle('files-ui:set-link-keep', (_event, input:{ id:string; enabled:boolean }) => getSullaFilesLinkService().update(input.id, { keepAvailable: input.enabled }));
  ipcMain.handle('files-ui:restore-link', (_event, input:{ id:string; password?:string }) => getSullaFilesLinkService().restore(input.id, input.password));
  ipcMain.handle('files-ui:link-activity', (_event, id?:string) => getSullaFilesLinkService().activity(id));
  ipcMain.handle('files-ui:status', () => getSullaFilesWatcher().status());
  ipcMain.handle('files-ui:set-paused', (_event, paused:boolean) => getSullaFilesWatcher().setPaused(paused));
  ipcMain.handle('files-ui:open-folder', () => getSullaFilesWatcher().openFolder());
  ipcMain.handle('files-ui:create-folder', async(_event, relativePath:string) => {
    await createDirectoryWithinRoot(getSullaFilesWatcher().folder, relativePath);
    await getSullaFilesWatcher().notifyRescan();
  });
  ipcMain.handle('files-ui:open-file', (_event, input:{ fileId:string; versionId?:string }) => openReference(input));
  ipcMain.handle('files-ui:download-file', (event, input:{ fileId:string; versionId?:string; name:string }) => downloadReference(event, input));
  ipcMain.handle('files-ui:download-files', (event, input:{ fileId:string; versionId?:string; name:string }[]) => downloadReferences(event, input));
  ipcMain.handle('files-ui:media-url', async(event, input:{ fileId:string; versionId?:string }) => {
    const senderUrl = event.senderFrame?.url;
    if (!senderUrl || new URL(senderUrl).protocol !== 'app:') throw new Error('Files media URLs are only available to the Sulla application');
    await json(`/v1/files/${ encodeURIComponent(input.fileId) }`);
    return mediaCapability(input);
  });
  ipcMain.handle('files-ui:pick-upload', async(event, destination = '') => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const picked = owner
      ? await dialog.showOpenDialog(owner, { title: 'Upload to Sulla Files', properties: ['openFile', 'multiSelections'] })
      : await dialog.showOpenDialog({ title: 'Upload to Sulla Files', properties: ['openFile', 'multiSelections'] });
    if (picked.canceled) return 0;

    return importPaths(picked.filePaths, destination, progress => event.sender.send('files-ui:upload-progress', progress));
  });
  ipcMain.handle('files-ui:pick-upload-references', async(event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    return pickAndImportChatFiles(owner);
  });
  ipcMain.handle('files-ui:upload-paths', (event, input:{ paths:string[]; destination?:string }) => importPaths(input.paths, input.destination, progress => event.sender.send('files-ui:upload-progress', progress)));
}
