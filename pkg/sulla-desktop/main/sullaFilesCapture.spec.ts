// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp', getPath: () => '/tmp', isPackaged: false },
  BrowserWindow: class {},
  clipboard: { writeText: vi.fn() },
  desktopCapturer: { getSources: vi.fn() },
  dialog: {},
  screen: { getPrimaryDisplay: vi.fn() },
}));

import { ChatFilesImporter } from './ChatFilesImporter';
import { ChatFilesSourceGuard } from './ChatFilesSourceGuard';
import { CloudShareContentNotFoundError, type ShareLink } from './sullaFilesLinkService';
import { SullaFilesCapturePathClipboardService, SullaFilesCaptureService } from './sullaFilesCapture';

const capture = { path: '/tmp/screenshot.png', relativePath: 'Screenshots/screenshot.png', name: 'screenshot.png', size: 1, kind: 'screenshot' as const, fileId: 'file-1' };
const createdLink = { id: 'share-1', url: 'https://share.example/1' } as ShareLink;

describe('SullaFilesCaptureService share behavior', () => {
  // risk: public-link correctness — choosing Share online must create the public Files link and copy its URL immediately without a residency opt-in.
  it('creates a live-only Files share and copies the returned URL', async() => {
    const create = vi.fn().mockResolvedValue(createdLink);
    const clipboard = vi.fn();
    const service = new SullaFilesCaptureService(() => ({ create }), async() => 30, clipboard);

    await expect(service.share(capture, { mode: 'view' })).resolves.toMatchObject({ url: createdLink.url, message: 'Link copied' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ fileId: 'file-1', mode: 'view', keepAvailable: false, capture: true });
    expect(clipboard).toHaveBeenCalledTimes(1);
    expect(clipboard).toHaveBeenCalledWith(createdLink.url);
  });

  // risk: sharing failure — the precise optional Cloud-content 404 must remain an error, never silently change the requested share behavior.
  it('surfaces the optional Cloud-content 404 rather than offering a residency downgrade', async() => {
    const create = vi.fn().mockRejectedValue(new CloudShareContentNotFoundError('Sulla Cloud could not store the optional copy.'));
    const clipboard = vi.fn();
    const service = new SullaFilesCaptureService(() => ({ create }), async() => 30, clipboard);

    await expect(service.share(capture, { mode: 'view' })).rejects.toBeInstanceOf(CloudShareContentNotFoundError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(clipboard).not.toHaveBeenCalled();
  });
});

describe('SullaFilesCapturePathClipboardService', () => {
  // risk: data exposure — Save to Files must copy the actual absolute file path inside Files, not a relative or attacker-controlled path.
  it('copies the absolute Files path including filename and refuses paths outside Files', async() => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-capture-path-'));
    const filesRoot = path.join(directory, 'Files');
    const relativePath = 'Screenshots/screenshot.png';
    const expectedAbsolute = path.join(filesRoot, relativePath);
    await fs.mkdir(path.dirname(expectedAbsolute), { recursive: true });
    await fs.writeFile(expectedAbsolute, 'capture');
    const clipboard = vi.fn();
    const service = new SullaFilesCapturePathClipboardService(() => filesRoot, clipboard);

    try {
      await expect(service.copy(relativePath)).resolves.toBe(expectedAbsolute);
      expect(clipboard).toHaveBeenCalledTimes(1);
      expect(clipboard).toHaveBeenCalledWith(expectedAbsolute);
      await expect(service.copy('../../outside.txt')).rejects.toThrow('outside Sulla Files');
      expect(clipboard).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe('tray screenshot Save to Files', () => {
  async function fixture(run:(directory:string) => Promise<void>) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-save-spec-'));
    try { await run(await fs.realpath(directory)) } finally { await fs.rm(directory, { recursive: true, force: true }) }
  }

  const bytes = Buffer.from([0, 127, 255, 42]);
  const name = 'Screenshot.png';

  // risk: data integrity — a vanished Files root must not lose the original or overwrite a same-named download.
  it('retains original bytes when capture starts without Files, then exclusively writes concurrent duplicate save names', async() => fixture(async directory => {
    const files = path.join(directory, 'Files');
    const downloads = path.join(directory, 'Downloads');
    await fs.mkdir(downloads);
    await fs.writeFile(path.join(downloads, name), 'existing');
    const clipboard = vi.fn();
    const choose = vi.fn();
    const importer = vi.fn();
    const destinations = new SullaFilesCapturePathClipboardService(() => files, clipboard, () => downloads);
    const service = new SullaFilesCaptureService(undefined, undefined, clipboard, importer);
    const pending = await service.prepareTrayScreenshot(name, bytes, destinations);
    expect(importer).not.toHaveBeenCalled();
    expect(clipboard).not.toHaveBeenCalled();
    expect(await fs.readdir(downloads)).toEqual([name]);

    const saved = await Promise.all([1, 2].map(() => destinations.saveScreenshot(pending, choose)));
    expect(new Set(saved).size).toBe(2);
    for (const file of saved) expect(await fs.readFile(file!)).toEqual(bytes);
    expect(await fs.readFile(path.join(downloads, name), 'utf8')).toBe('existing');
    expect(clipboard.mock.calls.map(([file]) => file).sort()).toEqual(saved.sort());
    expect(choose).not.toHaveBeenCalled();
  }));

  // risk: data integrity — a capture already imported into Files must copy that path while available; if the root disappears, retry with original bytes.
  it('prefers Files, then preserves a cancelled native save for retry when both roots disappear', async() => fixture(async directory => {
    const files = path.join(directory, 'Files');
    const downloads = path.join(directory, 'missing-downloads');
    await fs.mkdir(path.join(files, 'Screenshots'), { recursive: true });
    const relativePath = `Screenshots/${ name }`;
    const absolute = path.join(files, relativePath);
    const selected = path.join(directory, 'chosen.png');
    await fs.writeFile(absolute, bytes);
    const clipboard = vi.fn();
    const occupied = path.join(directory, 'existing.png');
    await fs.writeFile(occupied, 'keep');
    const choose = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(occupied).mockResolvedValueOnce(selected);
    const destinations = new SullaFilesCapturePathClipboardService(() => files, clipboard, () => downloads);
    const service = new SullaFilesCaptureService(undefined, undefined, clipboard, async() => [{
      fileId: 'f1', versionId: 'v1', path: relativePath, name, mime: 'image/png', size: bytes.length, updatedAt: '',
    }]);
    const pending = await service.prepareTrayScreenshot(name, bytes, destinations);

    expect(await destinations.saveScreenshot(pending, choose)).toBe(absolute);
    expect(choose).not.toHaveBeenCalled();
    await fs.rename(files, path.join(directory, 'detached'));
    expect(await destinations.saveScreenshot(pending, choose)).toBeUndefined();
    await expect(destinations.saveScreenshot(pending, choose)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(occupied, 'utf8')).toBe('keep');
    expect(clipboard.mock.calls).toEqual([[absolute]]);
    expect(await destinations.saveScreenshot(pending, choose)).toBe(selected);
    expect(await fs.readFile(selected)).toEqual(bytes);
    expect(clipboard.mock.calls).toEqual([[absolute], [selected]]);
  }));

  const importedPath = `Screenshots/${ name }`;

  // Only the HTTP boundary is synthetic. The host directory disappears independently
  // of the response, after the real importer has opened and streamed the source.
  function racingImporter(files:string, response:() => Response) {
    const stream = vi.fn(async(endpoint:string, init:RequestInit = {}) => {
      expect(init.method).toBe('PUT');
      const url = new URL(endpoint, 'https://files.example');
      expect(url.pathname).toBe('/v1/files/import');
      expect(url.searchParams.get('path')).toBe(importedPath);
      const chunks:Buffer[] = [];
      for await (const chunk of init.body as unknown as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(bytes);
      await fs.rmdir(files);
      return response();
    });
    const importer = new ChatFilesImporter({
      json: async<T>() => [{ id: 'local-files', name: 'Files', kind: 'knowledge' }] as T,
      request: async() => Response.json([]),
      stream,
    }, new ChatFilesSourceGuard(() => []), { showOpenDialog: async() => ({ canceled: true, filePaths: [] }) });
    return { importFiles: importer.import.bind(importer), stream };
  }

  // risk: data loss — a durable import can succeed even though its local copy cannot be resolved.
  it.each(['capture', 'save'])('uses the private original when Files disappears during successful %s import', async(phase) => fixture(async directory => {
    const files = path.join(directory, 'Files');
    const downloads = path.join(directory, 'Downloads');
    await fs.mkdir(downloads);
    if (phase === 'capture') await fs.mkdir(files);
    const { importFiles, stream } = racingImporter(files, () => Response.json({
      id: 'f1', current_version_id: 'v1', path: importedPath, size: bytes.length,
    }, { status: 201 }));
    const clipboard = vi.fn();
    const choose = vi.fn();
    const destinations = new SullaFilesCapturePathClipboardService(() => files, clipboard, () => downloads);
    const service = new SullaFilesCaptureService(undefined, undefined, clipboard, importFiles);

    const pending = await service.prepareTrayScreenshot(name, bytes, destinations);
    expect(clipboard).not.toHaveBeenCalled();
    expect(await fs.readdir(downloads)).toEqual([]);
    if (phase === 'save') {
      expect(stream).not.toHaveBeenCalled();
      await fs.mkdir(files);
    } else {
      expect(pending.capture?.fileId).toBe('f1');
    }

    const saved = path.join(downloads, name);
    await expect(destinations.saveScreenshot(pending, choose, () => true, () => service.importTrayScreenshot(pending))).resolves.toBe(saved);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(pending.capture?.reference?.versionId).toBe('v1');
    expect(await fs.readFile(saved)).toEqual(bytes);
    expect(clipboard.mock.calls).toEqual([[saved]]);
    expect(choose).not.toHaveBeenCalled();
  }));

  // risk: masking an import failure — no path copy or local write may hide a real API rejection.
  it.each([
    { status: 401, error: 'unauthorized', body: { error: 'unauthorized' } },
    { status: 503, error: 'Files is locked; secure bootstrap is required', body: { code: 'FILES_LOCKED', error: 'Files is locked; secure bootstrap is required' } },
    { status: 500, error: "ENOENT: no such file or directory, open '/var/lib/sulla-files/chunks/synthetic'", body: { error: "ENOENT: no such file or directory, open '/var/lib/sulla-files/chunks/synthetic'" } },
  ])('keeps HTTP $status visible in capture and save even when the local root disappears', async({ status, error, body }) => fixture(async directory => {
    const files = path.join(directory, 'Files');
    const downloads = path.join(directory, 'Downloads');
    await fs.mkdir(files);
    await fs.mkdir(downloads);
    const { importFiles, stream } = racingImporter(files, () => Response.json(body, { status }));
    const clipboard = vi.fn();
    const choose = vi.fn();
    const destinations = new SullaFilesCapturePathClipboardService(() => files, clipboard, () => downloads);
    const service = new SullaFilesCaptureService(undefined, undefined, clipboard, importFiles);

    await expect(service.prepareTrayScreenshot(name, bytes, destinations)).rejects.toThrow(error);
    const pending = await service.prepareTrayScreenshot(name, bytes, destinations);
    await fs.mkdir(files);
    await expect(destinations.saveScreenshot(pending, choose, () => true, () => service.importTrayScreenshot(pending))).rejects.toThrow(error);
    expect(stream).toHaveBeenCalledTimes(2);
    expect(await fs.readdir(downloads)).toEqual([]);
    expect(clipboard).not.toHaveBeenCalled();
    expect(choose).not.toHaveBeenCalled();
  }));

  // risk: unintended file writes — a missing item under an available root or stale ownership must not create a copy elsewhere.
  it('does not fall back for a missing Files item or write after a native dialog loses its capture', async() => fixture(async directory => {
    const files = path.join(directory, 'Files');
    await fs.mkdir(files);
    const selected = path.join(directory, 'stale.png');
    const clipboard = vi.fn();
    const destinations = new SullaFilesCapturePathClipboardService(() => files, clipboard, () => path.join(directory, 'absent'));
    const pending = { bytes, name, capture };
    const choose = vi.fn();
    await expect(destinations.saveScreenshot(pending, choose)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(choose).not.toHaveBeenCalled();

    await fs.rmdir(files);
    let current = true;
    await expect(destinations.saveScreenshot(pending, async() => {
      current = false;
      return selected;
    }, () => current)).resolves.toBeUndefined();
    await expect(fs.stat(selected)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(clipboard).not.toHaveBeenCalled();
  }));
});
