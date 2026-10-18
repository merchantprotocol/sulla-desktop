/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const showOpenDialog = jest.fn<any>();
const callCaptureStudio = jest.fn<any>();
const watcher = {
  folder:       '',
  findFile:     jest.fn<any>(),
  notifyRescan: jest.fn<any>(),
};

jest.unstable_mockModule('electron', () => ({
  BrowserWindow:   jest.fn(),
  app:             { getAppPath: jest.fn() },
  clipboard:       { writeText: jest.fn() },
  desktopCapturer: { getSources: jest.fn() },
  dialog:          { showOpenDialog },
  screen:          { getPrimaryDisplay: jest.fn() },
}));
jest.unstable_mockModule('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: jest.fn() } }));
jest.unstable_mockModule('@pkg/main/captureStudioRpc', () => ({ callCaptureStudio }));
jest.unstable_mockModule('@pkg/main/sullaFilesLinkService', () => ({
  SharingUnavailableError:   class SharingUnavailableError extends Error {},
  getSullaFilesLinkService: jest.fn(),
}));
jest.unstable_mockModule('@pkg/main/sullaFilesWatcher', () => ({ getSullaFilesWatcher: () => watcher }));

const { SullaFilesCaptureService } = await import('../sullaFilesCapture');

describe('SullaFilesCaptureService output containment', () => {
  let fixture:string;
  let root:string;
  let outside:string;

  beforeEach(async() => {
    fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sulla-files-capture-'));
    root = path.join(fixture, 'files');
    outside = path.join(fixture, 'outside');
    await Promise.all([fs.promises.mkdir(root), fs.promises.mkdir(outside)]);
    watcher.folder = root;
    watcher.findFile.mockResolvedValue({ id: 'synthetic-file' });
    watcher.notifyRescan.mockResolvedValue(undefined);
    showOpenDialog.mockReset();
    callCaptureStudio.mockReset();
  });

  afterEach(async() => {
    await fs.promises.rm(fixture, { recursive: true, force: true });
  });

  it('rejects a preexisting capture-directory symlink without writing outside Files', async() => {
    const source = path.join(fixture, 'fixture.txt');
    await fs.promises.writeFile(source, 'synthetic fixture');
    await fs.promises.symlink(outside, path.join(root, 'Uploads'), 'dir');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [source] });

    await expect(new SullaFilesCaptureService().upload()).rejects.toThrow('must be a real directory inside Sulla Files');
    await expect(fs.promises.readdir(outside)).resolves.toEqual([]);
  });

  it('commits an upload without overwriting an existing destination', async() => {
    const source = path.join(fixture, 'fixture.txt');
    const uploads = path.join(root, 'Uploads');
    await fs.promises.mkdir(uploads);
    await fs.promises.writeFile(source, 'new synthetic content');
    await fs.promises.writeFile(path.join(uploads, 'fixture.txt'), 'existing content');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [source] });

    const result = await new SullaFilesCaptureService().upload();

    expect(result?.name).toBe('fixture (1).txt');
    await expect(fs.promises.readFile(path.join(uploads, 'fixture.txt'), 'utf8')).resolves.toBe('existing content');
    await expect(fs.promises.readFile(path.join(uploads, 'fixture (1).txt'), 'utf8')).resolves.toBe('new synthetic content');
    expect((await fs.promises.stat(path.join(uploads, 'fixture (1).txt'))).mode & 0o777).toBe(0o600);
  });

  it('normalizes manifest-derived stream labels and keeps recording outputs contained', async() => {
    const session = path.join(fixture, 'synthetic-session');
    await fs.promises.mkdir(session);
    await fs.promises.writeFile(path.join(session, 'screen.webm'), 'screen');
    await fs.promises.writeFile(path.join(session, 'secondary.webm'), 'secondary');
    await fs.promises.writeFile(path.join(session, 'manifest.json'), JSON.stringify({
      streams: [
        { type: 'screen', filename: 'screen.webm', bytes: 6 },
        { type: '../../../escaped', filename: 'secondary.webm', bytes: 9 },
      ],
    }));
    callCaptureStudio
      .mockResolvedValueOnce({ started: true })
      .mockResolvedValueOnce({ stopped: true, sessionDir: session });
    const service = new SullaFilesCaptureService();
    await service.toggleRecording({ mic: false, camera: false });

    const result = await service.toggleRecording({ mic: false, camera: false });

    expect(result.capture?.path.startsWith(`${ path.join(root, 'Recordings') }${ path.sep }`)).toBe(true);
    const outputs = await fs.promises.readdir(path.join(root, 'Recordings'));
    expect(outputs.some(name => name.includes('escaped'))).toBe(true);
    expect(outputs.every(name => !name.includes('..') && !name.includes('/'))).toBe(true);
    await expect(fs.promises.readdir(outside)).resolves.toEqual([]);
  });
});
