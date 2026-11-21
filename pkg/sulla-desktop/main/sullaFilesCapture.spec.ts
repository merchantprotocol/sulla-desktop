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

  // risk: data loss — the root can disappear while either import is underway.
  it('retains the original across capture- and save-time destination ENOENT races', async() => fixture(async directory => {
    const files = path.join(directory, 'Files');
    const downloads = path.join(directory, 'Downloads');
    await fs.mkdir(files);
    await fs.mkdir(downloads);
    const clipboard = vi.fn();
    const destinations = new SullaFilesCapturePathClipboardService(() => files, clipboard, () => downloads);
    const loseFiles = vi.fn(async() => {
      await fs.rmdir(files);
      await fs.stat(path.join(files, name)); // Native ENOENT naming the missing destination.
      throw new Error('Expected the root to be gone');
    });
    const service = new SullaFilesCaptureService(undefined, undefined, clipboard, loseFiles);

    const pending = await service.prepareTrayScreenshot(name, bytes, destinations);
    expect(pending.capture).toBeUndefined();
    expect(clipboard).not.toHaveBeenCalled();
    await fs.mkdir(files);

    const destination = path.join(downloads, name);
    await expect(destinations.saveScreenshot(pending, vi.fn(), () => true, () => service.importTrayScreenshot(pending))).resolves.toBe(destination);
    expect(loseFiles).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(destination)).toEqual(bytes);
    expect(clipboard.mock.calls).toEqual([[destination]]);
  }));

  // risk: masking a real import failure — an unrelated API or source error is not a missing Files mount.
  it.each(['api', 'source'])('propagates a %s error even if Files also disappears', async(kind) => fixture(async directory => {
    const files = path.join(directory, 'Files');
    await fs.mkdir(files);
    const clipboard = vi.fn();
    const destinations = new SullaFilesCapturePathClipboardService(() => files, clipboard);
    const failure = kind === 'api' ? new Error('Files import failed (500)') :
      Object.assign(new Error('capture source missing'), { code: 'ENOENT', path: path.join(directory, 'capture.png') });
    const service = new SullaFilesCaptureService(undefined, undefined, clipboard, async() => {
      await fs.rmdir(files);
      throw failure;
    });

    await expect(service.prepareTrayScreenshot(name, bytes, destinations)).rejects.toBe(failure);
    expect(clipboard).not.toHaveBeenCalled();
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
