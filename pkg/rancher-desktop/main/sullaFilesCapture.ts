import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BrowserWindow, app, clipboard, desktopCapturer, dialog, screen } from 'electron';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { callCaptureStudio, getCaptureStudioRecordingState, isCaptureStudioReady } from '@pkg/main/captureStudioRpc';
import { importChatFiles, type ChatFilesReference } from '@pkg/main/sullaFilesChatImport';
import { getSullaFilesLinkService, SharingUnavailableError, type ShareMode } from '@pkg/main/sullaFilesLinkService';
import { getSullaFilesWatcher, type RecentSullaFile } from '@pkg/main/sullaFilesWatcher';

export type ScreenshotMode = 'area' | 'window' | 'full';
export interface CaptureResult { path:string; relativePath:string; name:string; size:number; kind:'screenshot'|'recording'|'upload'; fileId?:string; reference?:ChatFilesReference }

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

function runMacScreenshot(args:string[]):Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn('/usr/sbin/screencapture', args, { stdio: 'ignore' });
    process.once('error', reject);
    process.once('exit', code => code === 0 ? resolve() : reject(Object.assign(new Error(code === 1 ? 'Screenshot cancelled' : `screencapture exited ${ code }`), { cancelled: code === 1 })));
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
  recordingState():boolean { return getCaptureStudioRecordingState() }

  async screenshot(mode:ScreenshotMode):Promise<CaptureResult> {
    return withCaptureTemp('.png', async temporaryPath => {
      if (process.platform === 'darwin') {
        const args = mode === 'full' ? ['-x', '-o', '-t', 'png', temporaryPath] : mode === 'window' ? ['-iW', '-o', '-t', 'png', temporaryPath] : ['-i', '-o', '-t', 'png', temporaryPath];
        await runMacScreenshot(args);
      } else {
        await electronScreenshot(temporaryPath, mode === 'window' ? 'window' : 'screen');
      }
      const namedPath = path.join(path.dirname(temporaryPath), `Screenshot ${ stamp() }.png`);
      await fs.promises.rename(temporaryPath, namedPath);
      return captureResult(importedReference(await importChatFiles([namedPath], SCREENSHOTS)), 'screenshot');
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

  async share(capture:CaptureResult, options:{ mode:ShareMode; keepAvailable:boolean }):Promise<{ url?:string; unavailable?:boolean; message:string }> {
    const file = capture.fileId ? { id: capture.fileId } : await waitForFile(capture.relativePath);
    if (!file?.id) return { message: 'Saved to Files. Waiting for the container to finish versioning before sharing.' };
    const expiryDays = Number(await SullaSettingsModel.get('sullaFilesCaptureExpiryDays', 30));
    const expiresAt = expiryDays > 0 ? new Date(Date.now() + expiryDays * 86_400_000).toISOString() : undefined;
    try {
      const link = await getSullaFilesLinkService().create({ fileId: file.id, mode: options.mode, keepAvailable: options.keepAvailable, expiresAt, capture: capture.kind !== 'upload', captureMetadata: { kind: capture.kind, sourcePath: capture.relativePath } });
      clipboard.writeText(link.url);

      return { url: link.url, message: 'Link copied' };
    } catch (error) {
      if (error instanceof SharingUnavailableError) return { unavailable: true, message: 'Sharing comes online when links ship. The file is safely saved in Sulla Files.' };
      throw error;
    }
  }
}

let captureService:SullaFilesCaptureService | undefined;
export function getSullaFilesCaptureService():SullaFilesCaptureService { captureService ??= new SullaFilesCaptureService(); return captureService }

let markupWindow:BrowserWindow | undefined;
export function openScreenshotMarkup(filePath:string):void {
  if (markupWindow && !markupWindow.isDestroyed()) markupWindow.destroy();
  markupWindow = new BrowserWindow({
    width: 1100, height: 760, title: 'Mark up screenshot', backgroundColor: '#f4f7fb',
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  markupWindow.loadFile(path.join(app.getAppPath(), 'dist', 'app', 'trayPanel', 'markup.html'), { query: { file: filePath } });
  markupWindow.on('closed', () => { markupWindow = undefined; getSullaFilesWatcher().notifyRescan().catch(() => undefined) });
}
