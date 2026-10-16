import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, dialog, shell } from 'electron';

import { getIpcMainProxy } from './ipcMain';
import { getSullaFilesWatcher } from './sullaFilesWatcher';

import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMain = getIpcMainProxy(console);

async function json(endpoint:string, init:RequestInit = {}):Promise<any> {
  const response = await getSullaFilesWatcher().requestFiles(endpoint, { ...init, headers: { 'content-type': 'application/json', ...(init.headers as any) } });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? `Files request failed (${ response.status })`) }

  return response.status === 204 ? undefined : response.json();
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

async function importPaths(paths:string[], progress?:(value:{ current:number; total:number; name:string; percent:number; done:boolean }) => void):Promise<number> {
  const watcher = getSullaFilesWatcher(); let imported = 0;
  for (const [index, source] of paths.entries()) {
    const info = await fs.promises.stat(source);
    if (!info.isFile()) continue;
    progress?.({ current: index + 1, total: paths.length, name: path.basename(source), percent: 12, done: false });
    await fs.promises.copyFile(source, await availableTarget(watcher.folder, source), fs.constants.COPYFILE_EXCL);
    imported++;
    progress?.({ current: index + 1, total: paths.length, name: path.basename(source), percent: 100, done: index + 1 === paths.length });
  }
  if (imported) await watcher.notifyRescan();

  return imported;
}

export function initSullaFilesIpc():void {
  ipcMain.handle('sulla-files:collections', () => json('/v1/collections'));
  ipcMain.handle('sulla-files:list', (_event, input:{ collectionId:string; path?:string; trash?:boolean }) => json(`/v1/files?collectionId=${ encodeURIComponent(input.collectionId) }&path=${ encodeURIComponent(input.path ?? '') }&trash=${ input.trash === true }`));
  ipcMain.handle('sulla-files:metadata', (_event, input:{ fileId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }`));
  ipcMain.handle('sulla-files:history', (_event, input:{ fileId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/history`));
  ipcMain.handle('sulla-files:preview', async(_event, input:{ fileId:string; versionId?:string; thumbnail?:boolean }) => {
    const route = input.thumbnail ? 'thumbnail' : 'preview'; const query = input.versionId ? `?versionId=${ encodeURIComponent(input.versionId) }` : ''; const response = await getSullaFilesWatcher().requestFiles(`/v1/files/${ encodeURIComponent(input.fileId) }/${ route }${ query }`);
    if (!response.ok) throw new Error(`Files preview failed (${ response.status })`);

    return { mime: response.headers.get('content-type') ?? 'application/octet-stream', data: new Uint8Array(await response.arrayBuffer()) };
  });
  ipcMain.handle('sulla-files:upload', (_event, input:{ collectionId:string; path:string; mime?:string; data:Uint8Array }) => json(`/v1/files/upload?collectionId=${ encodeURIComponent(input.collectionId) }&path=${ encodeURIComponent(input.path) }`, { method: 'PUT', headers: { 'content-type': input.mime ?? 'application/octet-stream' }, body: Buffer.from(input.data) }));
  ipcMain.handle('sulla-files:trash', (_event, input:{ fileId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }`, { method: 'DELETE' }));
  ipcMain.handle('sulla-files:trash-list', (_event, input:{ collectionId:string }) => json(`/v1/trash?collectionId=${ encodeURIComponent(input.collectionId) }`));
  ipcMain.handle('sulla-files:trash-restore', (_event, input:{ fileId:string }) => json(`/v1/trash/${ encodeURIComponent(input.fileId) }/restore`, { method: 'POST', body: '{}' }));
  ipcMain.handle('sulla-files:restore-version', (_event, input:{ fileId:string; versionId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/restore`, { method: 'POST', body: JSON.stringify({ versionId: input.versionId }) }));
  ipcMain.handle('files-ui:status', () => getSullaFilesWatcher().status());
  ipcMain.handle('files-ui:set-paused', (_event, paused:boolean) => getSullaFilesWatcher().setPaused(paused));
  ipcMain.handle('files-ui:open-folder', () => getSullaFilesWatcher().openFolder());
  ipcMain.handle('files-ui:create-folder', async(_event, relativePath:string) => {
    const root = getSullaFilesWatcher().folder; const target = path.resolve(root, relativePath);
    if (!target.startsWith(`${ root }${ path.sep }`)) throw new Error('Folder path escapes ~/sulla/Files');
    await fs.promises.mkdir(target, { recursive: false });
    await getSullaFilesWatcher().notifyRescan();
  });
  ipcMain.handle('files-ui:open-file', async(_event, relativePath:string) => {
    const root = getSullaFilesWatcher().folder; const target = path.resolve(root, relativePath);
    if (!target.startsWith(`${ root }${ path.sep }`)) throw new Error('File path escapes ~/sulla/Files');
    const error = await shell.openPath(target); if (error) throw new Error(error);
  });
  ipcMain.handle('files-ui:pick-upload', async(event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const picked = owner
      ? await dialog.showOpenDialog(owner, { title: 'Upload to Sulla Files', properties: ['openFile', 'multiSelections'] })
      : await dialog.showOpenDialog({ title: 'Upload to Sulla Files', properties: ['openFile', 'multiSelections'] });
    if (picked.canceled) return 0;

    return importPaths(picked.filePaths, progress => event.sender.send('files-ui:upload-progress', progress));
  });
  ipcMain.handle('files-ui:upload-paths', (event, paths:string[]) => importPaths(paths, progress => event.sender.send('files-ui:upload-progress', progress)));
}
