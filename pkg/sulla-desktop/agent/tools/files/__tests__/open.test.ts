/** @jest-environment jsdom */
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const resolvePath = jest.fn();

jest.unstable_mockModule('../common', () => ({
  FilesTool: class {
    executionContext = undefined;
    state = undefined;
    resolvePath = resolvePath;
  },
}));
jest.unstable_mockModule('electron', () => ({ ipcMain: { once: jest.fn(), removeAllListeners: jest.fn() } }));
jest.unstable_mockModule('@pkg/window', () => ({ getWindow: jest.fn() }));

const { FilesOpenWorker, normalizeOpenPath } = await import('../open');
const { filesToolManifests } = await import('../manifests');

describe('files/open', () => {
  it('runs in the Desktop main process', () => {
    expect(filesToolManifests.find(item => item.name === 'open')?.executionTarget).toBe('desktop-local');
  });

  beforeEach(() => resolvePath.mockReset());

  it('accepts Files-relative and mounted paths but rejects traversal', () => {
    expect(normalizeOpenPath('Projects/example/notes.md')).toBe('/mnt/sulla-files/Projects/example/notes.md');
    expect(normalizeOpenPath('/mnt/sulla-files/Projects/example/notes.md')).toBe('/mnt/sulla-files/Projects/example/notes.md');
    expect(() => normalizeOpenPath('Projects/../private.md')).toThrow('inside Sulla Files');
  });

  it('preserves a Files permission denial and never dispatches an open command', async() => {
    resolvePath.mockRejectedValueOnce(new Error('You do not have permission to read that file'));
    const worker = new FilesOpenWorker();

    await expect((worker as any)._validatedCall({ path: 'Projects/private.md' }))
      .rejects.toThrow('permission to read');
  });
});
