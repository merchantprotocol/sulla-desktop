import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, app, clipboard, desktopCapturer, dialog, screen } from 'electron';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { callCaptureStudio } from '@pkg/main/captureStudioRpc';
import { createDirectoryWithinRoot } from '@pkg/main/sullaFilesDirectory';
import { getSullaFilesLinkService, SharingUnavailableError, type ShareMode } from '@pkg/main/sullaFilesLinkService';
import { getSullaFilesWatcher, type RecentSullaFile } from '@pkg/main/sullaFilesWatcher';

export type ScreenshotMode = 'area' | 'window' | 'full';
export interface CaptureResult { path:string; relativePath:string; name:string; size:number; kind:'screenshot'|'recording'|'upload'; fileId?:string }

interface RecorderResult { started?:boolean; stopped?:boolean; sessionDir?:string | null; reason?:string }

const SCREENSHOTS = 'Screenshots';
const RECORDINGS = 'Recordings';

function stamp():string {
  const value = new Date();
  const pad = (number:number) => String(number).padStart(2, '0');

  return `${ value.getFullYear() }-${ pad(value.getMonth() + 1) }-${ pad(value.getDate()) } at ${ pad(value.getHours()) }.${ pad(value.getMinutes()) }.${ pad(value.getSeconds()) }`;
}

function inside(root:string, candidate:string):boolean {
  const relative = path.relative(root, candidate);

  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${ path.sep }`));
}

async function captureDirectory(relativePath:string):Promise<string> {
  const root = getSullaFilesWatcher().folder;
  const realRoot = await fs.promises.realpath(root);
  const target = path.join(root, relativePath);
  try {
    await createDirectoryWithinRoot(root, relativePath);
  } catch (error:any) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const [targetInfo, resolved] = await Promise.all([fs.promises.lstat(target), fs.promises.realpath(target)]);
  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory() || !inside(realRoot, resolved)) {
    throw new Error(`The ${ relativePath } capture folder must be a real directory inside Sulla Files.`);
  }

  return resolved;
}

async function commitUniqueFile(dir:string, filename:string, write:(temporaryPath:string) => Promise<void>):Promise<string> {
  const extension = path.extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  const temporaryPath = path.join(dir, `.sulla-capture-${ randomUUID() }.partial`);
  try {
    await write(temporaryPath);
    const info = await fs.promises.lstat(temporaryPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Capture output was not a regular file.');
    await fs.promises.chmod(temporaryPath, 0o600);
    for (let index = 0; ; index++) {
      const candidate = path.join(dir, index ? `${ stem } (${ index })${ extension }` : filename);
      try {
        // link() is an atomic no-overwrite commit on the same filesystem.
        await fs.promises.link(temporaryPath, candidate);
        return candidate;
      } catch (error:any) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
  } finally {
    await fs.promises.rm(temporaryPath, { force: true });
  }
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
  private recording = false;

  async screenshot(mode:ScreenshotMode):Promise<CaptureResult> {
    const root = await captureDirectory(SCREENSHOTS);
    const target = await commitUniqueFile(root, `Screenshot ${ stamp() }.png`, async temporaryPath => {
      if (process.platform === 'darwin') {
        const args = mode === 'full' ? ['-x', '-o', '-t', 'png', temporaryPath] : mode === 'window' ? ['-iW', '-o', '-t', 'png', temporaryPath] : ['-i', '-o', '-t', 'png', temporaryPath];
        await runMacScreenshot(args);
      } else {
        await electronScreenshot(temporaryPath, mode === 'window' ? 'window' : 'screen');
      }
    });
    const info = await fs.promises.stat(target); const relativePath = path.relative(getSullaFilesWatcher().folder, target).split(path.sep).join('/');
    const file = await waitForFile(relativePath);

    return { path: target, relativePath, name: path.basename(target), size: info.size, kind: 'screenshot', fileId: file?.id };
  }

  async toggleRecording(input:{ mic:boolean; camera:boolean }):Promise<{ recording:boolean; capture?:CaptureResult; error?:string }> {
    if (!this.recording) {
      const result = await callCaptureStudio<RecorderResult>('recorder.start', { screen: true, mic: input.mic, camera: input.camera }, { timeoutMs: 30_000 });
      this.recording = Boolean(result.started);

      return { recording: this.recording, error: result.reason };
    }
    const stopped = await callCaptureStudio<RecorderResult>('recorder.stop', {}, { timeoutMs: 30_000 });
    this.recording = false;
    if (!stopped.stopped || !stopped.sessionDir) return { recording: false, error: stopped.reason ?? 'Recording did not stop cleanly' };

    return { recording: false, capture: await this.saveRecording(stopped.sessionDir) };
  }

  private async saveRecording(sessionDir:string):Promise<CaptureResult> {
    const destination = await captureDirectory(RECORDINGS);
    const raw = JSON.parse(await fs.promises.readFile(path.join(sessionDir, 'manifest.json'), 'utf8'));
    const streams:any[] = raw.streams ?? []; const primary = streams.find(stream => stream.type === 'screen') ?? streams.find(stream => stream.type === 'camera');
    if (!primary) throw new Error('Capture Studio recording contains no video track');
    const stem = `Recording ${ stamp() }`; const primaryExtension = path.extname(primary.filename) || '.webm';
    const target = await commitUniqueFile(destination, `${ stem }${ primaryExtension }`, temporaryPath => fs.promises.copyFile(path.join(sessionDir, path.basename(primary.filename)), temporaryPath, fs.constants.COPYFILE_EXCL));
    const chosenStem = path.basename(target, path.extname(target));
    const copied:any[] = [{ ...primary, filename: path.basename(target) }];
    for (const stream of streams.filter(stream => stream !== primary && Number(stream.bytes) > 0)) {
      const suffix = safeStreamLabel(stream.type);
      const output = await commitUniqueFile(destination, `${ chosenStem }-${ suffix }${ path.extname(stream.filename) || '.webm' }`, temporaryPath => fs.promises.copyFile(path.join(sessionDir, path.basename(stream.filename)), temporaryPath, fs.constants.COPYFILE_EXCL));
      copied.push({ ...stream, filename: path.basename(output) });
    }
    await commitUniqueFile(destination, `${ chosenStem }.capture.json`, temporaryPath => fs.promises.writeFile(temporaryPath, JSON.stringify({ ...raw, streams: copied }, null, 2), { flag: 'wx', mode: 0o600 }));
    const info = await fs.promises.stat(target); const relativePath = path.relative(getSullaFilesWatcher().folder, target).split(path.sep).join('/');
    const file = await waitForFile(relativePath);

    return { path: target, relativePath, name: path.basename(target), size: info.size, kind: 'recording', fileId: file?.id };
  }

  async upload():Promise<CaptureResult | undefined> {
    const picked = await dialog.showOpenDialog({ title: 'Upload & copy link', properties: ['openFile'] });
    if (picked.canceled || !picked.filePaths[0]) return undefined;
    const source = picked.filePaths[0]; const uploads = await captureDirectory('Uploads');
    const target = await commitUniqueFile(uploads, path.basename(source), temporaryPath => fs.promises.copyFile(source, temporaryPath, fs.constants.COPYFILE_EXCL));
    const info = await fs.promises.stat(target); const relativePath = path.relative(getSullaFilesWatcher().folder, target).split(path.sep).join('/');
    const file = await waitForFile(relativePath);

    return { path: target, relativePath, name: path.basename(target), size: info.size, kind: 'upload', fileId: file?.id };
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
