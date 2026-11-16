// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sullaFilesWatcher', () => ({ getSullaFilesWatcher: vi.fn() }));

import { SullaFilesIpcDownloadService } from './SullaFilesIpcDownloadService';
import { SullaFilesIpcApi } from './SullaFilesIpcSupport';

const event = { sender: {} } as any;

describe('SullaFilesIpcDownloadService', () => {
  let directory:string;

  beforeEach(async() => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-files-download-')) });
  afterEach(async() => { await fs.rm(directory, { recursive: true, force: true }) });

  function harness(options:{ statuses?:Record<string, number>; canceled?:boolean; platform?:NodeJS.Platform } = {}) {
    const client = {
      stream: vi.fn(async(endpoint:string) => {
        const fileId = decodeURIComponent(endpoint.split('/')[3]);
        const status = options.statuses?.[fileId] ?? 200;
        return new Response(status === 200 ? `content of ${ fileId }` : null, { status });
      }),
    };
    const desktop = {
      ownerWindow:    vi.fn(() => undefined),
      showOpenDialog: vi.fn(async() => ({ canceled: options.canceled === true, filePaths: options.canceled ? [] : [directory] })),
      showSaveDialog: vi.fn(async() => ({ canceled: options.canceled === true, filePath: options.canceled ? undefined : path.join(directory, 'saved.txt') })),
      userDataPath:   () => directory,
    };
    const copies = { authorize: vi.fn(async() => ({ file: { path: 'Docs/a.txt' }, versionId: 'v1' })), materialize: vi.fn(async() => path.join(directory, 'copy.txt')) };
    const runFile = vi.fn(async() => undefined);
    const service = new SullaFilesIpcDownloadService(new SullaFilesIpcApi(client as any), desktop as any, copies, runFile, () => options.platform ?? 'darwin');

    return { service, client, desktop, copies, runFile };
  }

  it('rejects an invalid selection before asking for a folder', async() => {
    // risk: input validation — path separators in names or oversized batches must not reach the filesystem.
    const { service, desktop } = harness();
    await expect(service.downloadReferences(event, [{ fileId: 'f1', name: '../evil.txt' }])).rejects.toThrow('Choose between 1 and 250 valid files to download.');
    await expect(service.downloadReferences(event, [])).rejects.toThrow('Choose between 1 and 250 valid files to download.');
    await expect(service.downloadReferences(event, Array.from({ length: 251 }, (_, index) => ({ fileId: `f${ index }`, name: `f${ index }.txt` })))).rejects.toThrow('Choose between 1 and 250 valid files to download.');
    expect(desktop.showOpenDialog).not.toHaveBeenCalled();
  });

  it('refuses duplicate names and never overwrites an existing file', async() => {
    // risk: data loss — a batch download must not clobber files already in the chosen folder.
    const { service, client } = harness();
    await expect(service.downloadReferences(event, [{ fileId: 'f1', name: 'a.txt' }, { fileId: 'f2', name: 'a.txt' }])).rejects.toThrow('Two selected files have the same name.');
    await fs.writeFile(path.join(directory, 'a.txt'), 'mine');
    await expect(service.downloadReferences(event, [{ fileId: 'f1', name: 'a.txt' }])).rejects.toThrow('a.txt already exists in the selected folder. Nothing was downloaded.');
    expect(await fs.readFile(path.join(directory, 'a.txt'), 'utf8')).toBe('mine');
    expect(client.stream).not.toHaveBeenCalled();
  });

  it('reports a partial batch with the count already written and leaves no partial files', async() => {
    // risk: error path — a mid-batch failure must report what landed and not leave temp files.
    const { service } = harness({ statuses: { f2: 500 } });
    const result = await service.downloadReferences(event, [{ fileId: 'f1', name: 'one.txt' }, { fileId: 'f2', name: 'two.txt' }]);
    expect(result).toEqual({ count: 1, error: '1 file downloaded before the remaining download failed: Files download failed (500)' });
    expect(await fs.readFile(path.join(directory, 'one.txt'), 'utf8')).toBe('content of f1');
    expect((await fs.readdir(directory)).sort()).toEqual(['one.txt']);
  });

  it('returns zero when the folder picker is cancelled', async() => {
    // risk: behaviour — cancelling must not download anything.
    const { service, client } = harness({ canceled: true });
    await expect(service.downloadReferences(event, [{ fileId: 'f1', name: 'one.txt' }])).resolves.toEqual({ count: 0 });
    expect(client.stream).not.toHaveBeenCalled();
  });

  it('saves a single file to the chosen path with the requested version', async() => {
    // risk: data integrity — the exact version's bytes land at the picked path.
    const { service, client } = harness();
    await expect(service.downloadReference(event, { fileId: 'f1', versionId: 'v 2', name: 'Docs/a.txt' })).resolves.toBe(true);
    expect(client.stream).toHaveBeenCalledWith('/v1/files/f1/download?versionId=v%202');
    expect(await fs.readFile(path.join(directory, 'saved.txt'), 'utf8')).toBe('content of f1');
  });

  it('refuses open-with outside macOS without launching anything', async() => {
    // risk: irreversible side effect — /usr/bin/open must only run for a validated macOS app.
    const { service, runFile, copies } = harness({ platform: 'linux' });
    await expect(service.openWithApplication(event, { fileId: 'f1', application: '/Applications/Preview.app' })).rejects.toThrow('Open with is currently available for macOS applications.');
    expect(copies.materialize).not.toHaveBeenCalled();
    expect(runFile).not.toHaveBeenCalled();
  });

  it('opens with a validated app and records it first in the recent list for that extension', async() => {
    // risk: data integrity — recent-app history is per extension, deduplicated and capped at 5.
    const app = path.join(directory, 'Viewer.app');
    await fs.mkdir(app);
    const { service, runFile } = harness();
    const result = await service.openWithApplication(event, { fileId: 'f1', application: app });
    expect(runFile).toHaveBeenCalledWith('/usr/bin/open', ['-a', app, path.join(directory, 'copy.txt')]);
    expect(result).toEqual({ application: app, recentApplications: [app] });
    expect((await service.recentApplications())['.txt']).toEqual([app]);
  });
});
