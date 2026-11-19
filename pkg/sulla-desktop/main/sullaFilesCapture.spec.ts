// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

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
import { SullaFilesCaptureService } from './sullaFilesCapture';

const capture = { path: '/tmp/screenshot.png', relativePath: 'Screenshots/screenshot.png', name: 'screenshot.png', size: 1, kind: 'screenshot' as const, fileId: 'file-1' };
const createdLink = { id: 'share-1', url: 'https://share.example/1' } as ShareLink;

describe('SullaFilesCaptureService share recovery', () => {
  // risk: capture sharing — a Cloud copy 404 must not silently change the user's residency choice.
  it('offers an explicit live-only retry, then creates it only after the caller retries without the copy', async() => {
    const create = vi.fn().mockRejectedValueOnce(new CloudShareContentNotFoundError('Cloud copy missing')).mockResolvedValueOnce(createdLink);
    const clipboard = vi.fn();
    const service = new SullaFilesCaptureService(() => ({ create }), async() => 30, clipboard);

    const recovery = await service.share(capture, { mode: 'view', keepAvailable: true });

    expect(recovery).toMatchObject({ retryWithoutCloudCopy: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ keepAvailable: true });

    const retried = await service.share(capture, { mode: 'view', keepAvailable: false });

    expect(retried).toMatchObject({ url: createdLink.url, message: 'Link copied' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).toMatchObject({ keepAvailable: false });
    expect(clipboard).toHaveBeenCalledWith(createdLink.url);
  });

  // risk: capture sharing — unrelated failures must not be presented as safe residency downgrades.
  it('does not offer the live-only retry for unrelated share failures', async() => {
    const create = vi.fn().mockRejectedValue(new Error('Files is offline'));
    const service = new SullaFilesCaptureService(() => ({ create }), async() => 30, vi.fn());

    await expect(service.share(capture, { mode: 'view', keepAvailable: true })).rejects.toThrow('Files is offline');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
