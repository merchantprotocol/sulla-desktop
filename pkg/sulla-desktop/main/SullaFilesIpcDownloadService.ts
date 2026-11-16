// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import type { IpcMainInvokeEvent, OpenDialogOptions } from 'electron';
import type { SullaFilesIpcOpenedCopyService } from './SullaFilesIpcOpenedCopyService';
import type { SullaFilesIpcApi, SullaFilesIpcDesktop } from './SullaFilesIpcSupport';

export type SullaFilesRunFile = (file:string, args:string[]) => Promise<unknown>;

/** Exports Files content to Finder and opens it with a chosen macOS application. */
export class SullaFilesIpcDownloadService {
  constructor(
    private readonly api:SullaFilesIpcApi,
    private readonly desktop:Pick<SullaFilesIpcDesktop, 'ownerWindow' | 'showOpenDialog' | 'showSaveDialog' | 'userDataPath'>,
    private readonly copies:Pick<SullaFilesIpcOpenedCopyService, 'authorize' | 'materialize'>,
    private readonly runFile:SullaFilesRunFile = promisify(execFile),
    private readonly platform:() => NodeJS.Platform = () => process.platform,
  ) {}

  fileExtension(name:string):string { return path.extname(name).toLowerCase() || '<none>' }

  private recentAppsPath():string { return path.join(this.desktop.userDataPath(), 'files-open-with.json') }

  async recentApplications():Promise<Record<string, string[]>> {
    try { const value = JSON.parse(await fs.promises.readFile(this.recentAppsPath(), 'utf8')); return value && typeof value === 'object' ? value : {} } catch { return {} }
  }

  private async saveRecentApplications(value:Record<string, string[]>):Promise<void> {
    const target = this.recentAppsPath(); const temp = `${ target }.${ process.pid }.tmp`;
    await fs.promises.mkdir(path.dirname(target), { recursive:true }); await fs.promises.writeFile(temp, JSON.stringify(value), { mode:0o600 }); await fs.promises.rename(temp, target);
  }

  async openWithApplication(event:IpcMainInvokeEvent, input:{ fileId:string; versionId?:string; application?:string }):Promise<{ application?:string; recentApplications:string[] }> {
    const { file } = await this.copies.authorize(input); const extension = this.fileExtension(String(file.path || 'file'));
    let application = input.application;
    if (!application) {
      const owner = this.desktop.ownerWindow(event.sender);
      const options:OpenDialogOptions = { title:'Open with application', defaultPath:'/Applications', properties:['openFile'], filters:[{ name:'Applications', extensions:['app'] }] };
      const picked = await this.desktop.showOpenDialog(owner, options);
      if (picked.canceled || !picked.filePaths[0]) return { recentApplications:(await this.recentApplications())[extension] ?? [] };
      application = picked.filePaths[0];
    }
    if (this.platform() !== 'darwin' || !application.endsWith('.app')) throw new Error('Open with is currently available for macOS applications.');
    const applicationInfo = await fs.promises.lstat(application);
    if (!path.isAbsolute(application) || !applicationInfo.isDirectory() || applicationInfo.isSymbolicLink()) throw new Error('Choose a valid macOS application.');
    const target = await this.copies.materialize(input);
    await this.runFile('/usr/bin/open', ['-a', application, target]);
    const settings = await this.recentApplications(); settings[extension] = [application, ...(settings[extension] ?? []).filter(item => item !== application)].slice(0, 5); await this.saveRecentApplications(settings);
    return { application, recentApplications:settings[extension] };
  }

  async downloadReference(event:IpcMainInvokeEvent, input:{ fileId:string; versionId?:string; name:string }):Promise<boolean> {
    const owner = this.desktop.ownerWindow(event.sender);
    const picked = await this.desktop.showSaveDialog(owner, { defaultPath: path.basename(input.name) });
    if (picked.canceled || !picked.filePath) return false;
    const query = input.versionId ? `?versionId=${ encodeURIComponent(input.versionId) }` : '';
    const response = await this.api.client.stream(`/v1/files/${ encodeURIComponent(input.fileId) }/download${ query }`);
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

  async downloadReferences(event:IpcMainInvokeEvent, items:{ fileId: string; name: string; versionId?: string }[]):Promise<{ count: number; error?: string }> {
    if (!Array.isArray(items) || !items.length || items.length > 250 || items.some(item => !item.fileId || !item.name || path.basename(item.name) !== item.name)) throw new Error('Choose between 1 and 250 valid files to download.');
    const owner = this.desktop.ownerWindow(event.sender);
    const picked = await this.desktop.showOpenDialog(owner, { title: 'Download selected Files', properties: ['openDirectory', 'createDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return { count: 0 };
    const directory = picked.filePaths[0]; const names = items.map(item => path.basename(item.name));
    if (new Set(names).size !== names.length) throw new Error('Two selected files have the same name. Move them into separate folders before downloading together.');
    for (const name of names) if (await fs.promises.lstat(path.join(directory, name)).then(() => true, () => false)) throw new Error(`${ name } already exists in the selected folder. Nothing was downloaded.`);
    const created:string[] = [];
    try {
      for (const [index, item] of items.entries()) {
        const response = await this.api.client.stream(`/v1/files/${ encodeURIComponent(item.fileId) }/download${ item.versionId ? `?versionId=${ encodeURIComponent(item.versionId) }` : '' }`);
        if (!response.ok || !response.body) throw new Error(`Files download failed (${ response.status })`);
        const target = path.join(directory, names[index]); const temp = path.join(directory, `.sulla-partial-${ process.pid }-${ randomUUID() }`);
        const handle = await fs.promises.open(temp, 'wx', 0o600);
        try { await pipeline(Readable.fromWeb(response.body as any), handle.createWriteStream()); await fs.promises.link(temp, target); created.push(target) } catch (error) { await response.body.cancel().catch(() => undefined); await handle.close().catch(() => undefined); throw error } finally { await fs.promises.rm(temp, { force: true }) }
      }
      return { count: created.length };
    } catch (error) { return { count: created.length, error: `${ created.length } file${ created.length === 1 ? '' : 's' } downloaded before the remaining download failed: ${ error instanceof Error ? error.message : String(error) }` } }
  }
}
