// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BrowserWindow, app, clipboard, desktopCapturer, dialog, screen } from 'electron';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { callCaptureStudio, getCaptureStudioRecordingState, isCaptureStudioReady } from '@pkg/main/captureStudioRpc';
import { importChatFiles, type ChatFilesReference } from '@pkg/main/sullaFilesChatImport';
import { getSullaFilesLinkService, SharingUnavailableError, type CreateShareInput, type ShareLink, type ShareMode } from '@pkg/main/sullaFilesLinkService';
import { getSullaFilesWatcher, type RecentSullaFile, type SullaFilesWatcher } from '@pkg/main/sullaFilesWatcher';
import { ScreenRecordingPermission } from '@pkg/utils/screenRecordingPermission';

export type ScreenshotMode = 'area' | 'window' | 'full';
export interface CaptureResult { path:string; relativePath:string; name:string; size:number; kind:'screenshot'|'recording'|'upload'; fileId?:string; reference?:ChatFilesReference }

// Main-process only: the original bytes never travel over IPC.
export interface TrayScreenshot { readonly bytes:Buffer; readonly name:string; capture?:CaptureResult }

interface RecorderResult { recording?:boolean; started?:boolean; stopped?:boolean; setup?:boolean; sessionDir?:string | null; reason?:string }

const SCREENSHOTS = 'Screenshots';
const RECORDINGS = 'Recordings';

function stamp():string {
  const value = new Date();
  const pad = (number:number) => String(number).padStart(2, '0');

  return `${ value.getFullYear() }-${ pad(value.getMonth() + 1) }-${ pad(value.getDate()) } at ${ pad(value.getHours()) }.${ pad(value.getMinutes()) }.${ pad(value.getSeconds()) }`;
}

function safeStreamLabel(value:unknown):string {
  const label = String(value ?? '').normalize('NFKC').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

  return label.slice(0, 64) || 'track';
}

async function waitForFile(relativePath:string):Promise<RecentSullaFile | undefined> {
  await getSullaFilesWatcher().notifyRescan();
  for (let attempt = 0; attempt < 30; attempt++) {
    const file = await getSullaFilesWatcher().findFile(relativePath).catch(() => undefined);
    if (file) return file;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function importedReference(result:ChatFilesReference[] | { references:ChatFilesReference[]; error:string }):ChatFilesReference {
  const reference = Array.isArray(result) ? result[0] : result.references[0];
  if (!reference) throw new Error(Array.isArray(result) ? 'Files did not return the imported capture.' : result.error);
  return reference;
}

function captureResult(reference:ChatFilesReference, kind:CaptureResult['kind']):CaptureResult {
  return { path: reference.path, relativePath: reference.path, name: reference.name, size: reference.size, kind, fileId: reference.fileId, reference };
}

async function withCaptureTemp<T>(extension:string, work:(temporaryPath:string) => Promise<T>):Promise<T> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sulla-capture-'));
  const temporaryPath = path.join(directory, `capture${ extension }`);
  try { return await work(temporaryPath) } finally { await fs.promises.rm(directory, { recursive: true, force: true }) }
}

/** Exit 1 is a user cancel only for interactive area/window capture; for full-screen it is a real failure. */
function runMacScreenshot(args:string[], interactive:boolean):Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn('/usr/sbin/screencapture', args, { stdio: 'ignore' });
    process.once('error', reject);
    process.once('exit', code => {
      if (code === 0) return resolve();
      if (code === 1 && interactive) return reject(Object.assign(new Error('Screenshot cancelled'), { cancelled: true }));
      reject(new Error(`screencapture exited ${ code }`));
    });
  });
}

async function electronScreenshot(target:string, sourceType:'screen'|'window'):Promise<void> {
  const primary = screen.getPrimaryDisplay(); const scale = primary.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: [sourceType], thumbnailSize: { width: Math.round(primary.size.width * scale), height: Math.round(primary.size.height * scale) },
  });
  const source = sources[0]; if (!source || source.thumbnail.isEmpty()) throw new Error('No capturable source available');
  await fs.promises.writeFile(target, source.thumbnail.toPNG());
}

export class SullaFilesCaptureService {
  private readonly recordingImports = new Map<string, Promise<CaptureResult>>();
  constructor(
    private readonly resolveLinks:() => Pick<import('@pkg/main/sullaFilesLinkService').LinkService, 'create'> = getSullaFilesLinkService,
    private readonly readExpiryDays:() => Promise<unknown> = () => SullaSettingsModel.get('sullaFilesCaptureExpiryDays', 30),
    private readonly writeClipboard:(value:string) => void = value => clipboard.writeText(value),
    private readonly importFiles:typeof importChatFiles = importChatFiles,
  ) {}

  recordingState():boolean { return getCaptureStudioRecordingState() }

  async screenshot(mode:ScreenshotMode):Promise<CaptureResult> {
    return this.withScreenshot(mode, async namedPath => captureResult(importedReference(await this.importFiles([namedPath], SCREENSHOTS)), 'screenshot'));
  }

  trayScreenshot(mode:ScreenshotMode, destinations:SullaFilesCapturePathClipboardService):Promise<TrayScreenshot> {
    return this.withScreenshot(mode, async namedPath => this.prepareTrayScreenshot(path.basename(namedPath), await fs.promises.readFile(namedPath), destinations, namedPath));
  }

  async prepareTrayScreenshot(name:string, bytes:Buffer, destinations:SullaFilesCapturePathClipboardService, source?:string):Promise<TrayScreenshot> {
    const screenshot:TrayScreenshot = { name, bytes };
    if (await destinations.filesRoot()) await this.importTrayScreenshot(screenshot, source);
    return screenshot;
  }

  async importTrayScreenshot(screenshot:TrayScreenshot, source?:string):Promise<CaptureResult> {
    if (screenshot.capture) return screenshot.capture;
    if (source) {
      screenshot.capture = captureResult(importedReference(await this.importFiles([source], SCREENSHOTS)), 'screenshot');
    } else {
      screenshot.capture = await withCaptureTemp('.png', async temporaryPath => {
        const namedPath = path.join(path.dirname(temporaryPath), screenshot.name);
        await fs.promises.writeFile(namedPath, screenshot.bytes, { flag: 'wx', mode: 0o600 });
        return captureResult(importedReference(await this.importFiles([namedPath], SCREENSHOTS)), 'screenshot');
      });
    }
    return screenshot.capture;
  }

  private withScreenshot<T>(mode:ScreenshotMode, work:(namedPath:string) => Promise<T>):Promise<T> {
    return withCaptureTemp('.png', async temporaryPath => {
      if (process.platform === 'darwin') {
        const blocked = new ScreenRecordingPermission().blockedReason();
        if (blocked) throw new Error(blocked);
        const args = mode === 'full' ? ['-x', '-o', '-t', 'png', temporaryPath] : mode === 'window' ? ['-iW', '-o', '-t', 'png', temporaryPath] : ['-i', '-o', '-t', 'png', temporaryPath];
        await runMacScreenshot(args, mode !== 'full');
      } else {
        await electronScreenshot(temporaryPath, mode === 'window' ? 'window' : 'screen');
      }
      const namedPath = path.join(path.dirname(temporaryPath), `Screenshot ${ stamp() }.png`);
      await fs.promises.rename(temporaryPath, namedPath);
      return work(namedPath);
    });
  }

  async toggleRecording(input:{ mic:boolean; camera:boolean }, options:{ setup?:boolean } = {}):Promise<{ recording:boolean; setup?:boolean; capture?:CaptureResult; error?:string }> {
    let status:RecorderResult = { recording: false };
    if (isCaptureStudioReady()) {
      try { status = await callCaptureStudio<RecorderResult>('recorder.status', {}, { timeoutMs: 5_000 }) } catch { status = { recording: false } }
    }
    if (!status.recording) {
      const command = options.setup ? 'recorder.setup' : 'recorder.start';
      const result = await callCaptureStudio<RecorderResult>(command, { screen: true, mic: input.mic, camera: input.camera }, { timeoutMs: 30_000 });

      return { recording: Boolean(result.recording ?? result.started), setup: result.setup, error: result.reason };
    }
    const stopped = await callCaptureStudio<RecorderResult>('recorder.stop', {}, { timeoutMs: 30_000 });
    if (!stopped.stopped || !stopped.sessionDir) return { recording: false, error: stopped.reason ?? 'Recording did not stop cleanly' };

    return { recording: false, capture: await this.saveRecording(stopped.sessionDir) };
  }

  saveRecording(sessionDir:string):Promise<CaptureResult> {
    const existing = this.recordingImports.get(sessionDir);
    if (existing) return existing;
    const importing = this.importRecording(sessionDir);
    this.recordingImports.set(sessionDir, importing);
    importing.catch(() => this.recordingImports.delete(sessionDir));
    return importing;
  }

  private async importRecording(sessionDir:string):Promise<CaptureResult> {
    const raw = JSON.parse(await fs.promises.readFile(path.join(sessionDir, 'manifest.json'), 'utf8'));
    const streams:any[] = raw.streams ?? []; const primary = streams.find(stream => stream.type === 'screen') ?? streams.find(stream => stream.type === 'camera');
    if (!primary) throw new Error('Capture Studio recording contains no video track');
    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sulla-recording-'));
    try {
      const stem = `Recording ${ stamp() }`; const outputs:string[] = []; const copied:any[] = [];
      for (const [index, stream] of [primary, ...streams.filter(stream => stream !== primary && Number(stream.bytes) > 0)].entries()) {
        const suffix = index ? `-${ safeStreamLabel(stream.type) }` : '';
        const output = path.join(temporaryDirectory, `${ stem }${ suffix }${ path.extname(stream.filename) || '.webm' }`);
        await fs.promises.copyFile(path.join(sessionDir, path.basename(stream.filename)), output, fs.constants.COPYFILE_EXCL);
        outputs.push(output); copied.push({ ...stream, filename:path.basename(output) });
      }
      const manifest = path.join(temporaryDirectory, `${ stem }.capture.json`);
      await fs.promises.writeFile(manifest, JSON.stringify({ ...raw, streams: copied }, null, 2), { flag:'wx', mode:0o600 });
      const imported = await importChatFiles([...outputs, manifest], RECORDINGS);
      return captureResult(importedReference(imported), 'recording');
    } finally { await fs.promises.rm(temporaryDirectory, { recursive:true, force:true }) }
  }

  async upload():Promise<CaptureResult | undefined> {
    const picked = await dialog.showOpenDialog({ title: 'Upload & copy link', properties: ['openFile'] });
    if (picked.canceled || !picked.filePaths[0]) return undefined;
    return captureResult(importedReference(await importChatFiles([picked.filePaths[0]], 'Uploads')), 'upload');
  }

  async share(capture:CaptureResult, options:{ mode:ShareMode }):Promise<{ url?:string; unavailable?:boolean; message:string }> {
    const file = capture.fileId ? { id: capture.fileId } : await waitForFile(capture.relativePath);
    if (!file?.id) return { message: 'Saved to Files. Waiting for the container to finish versioning before sharing.' };
    const expiryDays = Number(await this.readExpiryDays());
    const expiresAt = expiryDays > 0 ? new Date(Date.now() + expiryDays * 86_400_000).toISOString() : undefined;
    try {
      // Captures are shared live from this desktop. The popup has no residency
      // opt-in, so never request the optional Cloud content copy here.
      const input:CreateShareInput = { fileId: file.id, mode: options.mode, keepAvailable: false, expiresAt, capture: capture.kind !== 'upload', captureMetadata: { kind: capture.kind, sourcePath: capture.relativePath } };
      const link:ShareLink = await this.resolveLinks().create(input);
      this.writeClipboard(link.url);

      return { url: link.url, message: 'Link copied' };
    } catch (error) {
      if (error instanceof SharingUnavailableError) return { unavailable: true, message: 'Sharing comes online when links ship. The file is safely saved in Sulla Files.' };
      throw error;
    }
  }
}

/** Resolves the real local Files copy or writes the private original on explicit screenshot save. */
export class SullaFilesCapturePathClipboardService {
  constructor(
    private readonly resolveFilesRoot:() => Promise<string> | string,
    private readonly writeClipboard:(value:string) => void,
    private readonly resolveDownloads:() => string = () => app.getPath('downloads'),
  ) {}

  private async existingDirectory(directory:string):Promise<string | undefined> {
    try {
      const absolute = await fs.promises.realpath(directory);
      if (!(await fs.promises.stat(absolute)).isDirectory()) throw new Error('The capture destination is not a directory');
      return absolute;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async filesRoot():Promise<string | undefined> {
    return this.existingDirectory(await this.resolveFilesRoot());
  }

  private async resolveFile(root:string, relativePath:string):Promise<string> {
    if (typeof relativePath !== 'string' || !relativePath) throw new Error('A Files path is required');
    const requested = path.resolve(root, relativePath);
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (requested === root || !requested.startsWith(prefix)) throw new Error('The requested item is outside Sulla Files');
    const absolute = await fs.promises.realpath(requested);
    if (absolute === root || !absolute.startsWith(prefix)) throw new Error('The requested item resolves outside Sulla Files');
    if (!(await fs.promises.stat(absolute)).isFile()) throw new Error('The requested Files item is not a file');
    return absolute;
  }

  async copy(relativePath:string, isCurrent:() => boolean = () => true):Promise<string | undefined> {
    const root = await this.filesRoot();
    if (!root) throw new Error('The local Sulla Files folder is missing');
    const absolute = await this.resolveFile(root, relativePath);
    if (!isCurrent()) return undefined;
    this.writeClipboard(absolute);
    return absolute;
  }

  async saveScreenshot(
    screenshot:TrayScreenshot,
    choosePath:(name:string) => Promise<string | undefined>,
    isCurrent:() => boolean = () => true,
    importScreenshot?:() => Promise<CaptureResult>,
  ):Promise<string | undefined> {
    if (!isCurrent()) return undefined;
    const root = await this.filesRoot();
    if (!isCurrent()) return undefined;
    if (root) {
      const capture = screenshot.capture ?? await importScreenshot?.();
      if (!capture) throw new Error('The screenshot has not been imported into Sulla Files');
      let absolute:string | undefined;
      try {
        absolute = await this.resolveFile(root, capture.relativePath);
      } catch (error) {
        // A missing item in an existing root is not permission to save elsewhere.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || await this.filesRoot()) throw error;
      }
      if (absolute) {
        if (!isCurrent()) return undefined;
        this.writeClipboard(absolute);
        return absolute;
      }
    }
    if (!isCurrent()) return undefined;
    const downloadsPath = this.resolveDownloads();
    const downloads = await this.existingDirectory(downloadsPath);
    let absolute:string | undefined;
    if (downloads) {
      let disappeared = false;
      const extension = path.extname(screenshot.name);
      const stem = path.basename(screenshot.name, extension);
      for (let index = 0; index < 1_000 && isCurrent(); index++) {
        const filename = index ? `${ stem } (${ index })${ extension }` : stem + extension;
        const candidate = path.join(downloads, filename);
        try {
          if (!await this.writeExclusive(candidate, screenshot.bytes, isCurrent)) return undefined;
          absolute = candidate;
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') continue;
          if (code === 'ENOENT' && !await this.existingDirectory(downloadsPath)) {
            disappeared = true;
            break;
          }
          throw error;
        }
      }
      if (!absolute && !disappeared && isCurrent()) throw new Error('Could not find an unused screenshot name in Downloads');
    }
    if (!absolute && isCurrent()) {
      const selected = await choosePath(screenshot.name);
      if (!selected || !isCurrent()) return undefined;
      // The dialog can offer replacement, but capture save never overwrites.
      if (!await this.writeExclusive(selected, screenshot.bytes, isCurrent)) return undefined;
      absolute = selected;
    }
    if (!absolute || !isCurrent()) return undefined;
    this.writeClipboard(absolute);
    return absolute;
  }

  private async writeExclusive(target:string, bytes:Buffer, isCurrent:() => boolean):Promise<boolean> {
    const handle = await fs.promises.open(target, 'wx', 0o600);
    let committed = false;
    try {
      if (isCurrent()) {
        await handle.writeFile(bytes);
        committed = true;
      }
    } finally {
      try { await handle.close() } finally {
        if (!committed) await fs.promises.unlink(target);
      }
    }
    return committed;
  }
}

export class SullaFilesCaptureServiceProvider {
  private captureService?:SullaFilesCaptureService;
  resolve():SullaFilesCaptureService { return this.captureService ??= new SullaFilesCaptureService(); }
}
export const sullaFilesCaptureServiceProvider = new SullaFilesCaptureServiceProvider();
export function getSullaFilesCaptureService():SullaFilesCaptureService { return sullaFilesCaptureServiceProvider.resolve() }

export class SullaFilesScreenshotMarkupService {
  private markupWindow?:BrowserWindow;
  constructor(private readonly resolveWatcher:() => Pick<SullaFilesWatcher, 'notifyRescan'> = getSullaFilesWatcher) {}
  open(filePath:string):void {
    if (this.markupWindow && !this.markupWindow.isDestroyed()) this.markupWindow.destroy();
    this.markupWindow = new BrowserWindow({
      width: 1100, height: 760, title: 'Mark up screenshot', backgroundColor: '#f4f7fb',
      webPreferences: { contextIsolation: false, nodeIntegration: true },
    });
    this.markupWindow.loadFile(path.join(app.getAppPath(), 'dist', 'app', 'trayPanel', 'markup.html'), { query: { file: filePath } });
    this.markupWindow.on('closed', () => { this.markupWindow = undefined; this.resolveWatcher().notifyRescan().catch(() => undefined) });
  }
}
export class SullaFilesScreenshotMarkupServiceProvider {
  private service?:SullaFilesScreenshotMarkupService;
  resolve():SullaFilesScreenshotMarkupService { return this.service ??= new SullaFilesScreenshotMarkupService(); }
}
export const sullaFilesScreenshotMarkupServiceProvider = new SullaFilesScreenshotMarkupServiceProvider();
export function openScreenshotMarkup(filePath:string):void { sullaFilesScreenshotMarkupServiceProvider.resolve().open(filePath) }
