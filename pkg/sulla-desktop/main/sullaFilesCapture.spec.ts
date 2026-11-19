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
