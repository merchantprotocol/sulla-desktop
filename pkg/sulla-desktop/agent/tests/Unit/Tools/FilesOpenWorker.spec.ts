// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  listener: undefined as any,
  message: undefined as any,
  window: undefined as any,
}));

vi.mock('electron', () => ({
  ipcMain: {
    once: vi.fn((_channel: string, listener: typeof state.listener) => { state.listener = listener; }),
    removeAllListeners: vi.fn(),
  },
}));

vi.mock('@pkg/window', () => ({ getWindow: () => state.window }));

import { FilesOpenWorker } from '../../../tools/files/open';

class ResolvedFileOpenWorker extends FilesOpenWorker {
  protected override async resolvePath() {
    return { collectionId: 'collection-1', fileId: 'file-1', folderPath: 'Projects/sulla-desktop/qa-two-device/editor-repro', kind: 'file' as const };
  }
  execute(input: unknown) { return this._validatedCall(input); }
}

describe('FilesOpenWorker', () => {
  beforeEach(() => {
    state.listener = undefined;
    state.message = undefined;
    const webContents = {
      isLoading: () => false,
      once: vi.fn(),
      send: vi.fn((_channel: string, message: typeof state.message) => {
        state.message = message;
        queueMicrotask(() => state.listener?.({ sender: webContents }, { opened: true, tabId: 'tab-1', path: message?.path, how: 'document-editor' }));
      }),
    };
    state.webContents = webContents;
    state.window = { webContents, focus: vi.fn() };
  });

  it('opens a path-resolved file itself, not the parent folder returned alongside its id', async() => {
    // risk: file access — agent open must dispatch the selected document path so the editor opens the file rather than its parent directory.
    const response = await new ResolvedFileOpenWorker().execute({ path: '/mnt/sulla-files/Projects/sulla-desktop/qa-two-device/editor-repro/agent-repro.md' });

    expect(state.message).toMatchObject({
      command: 'open-files-item',
      fileId: 'file-1',
      collectionId: 'collection-1',
      path: 'Projects/sulla-desktop/qa-two-device/editor-repro/agent-repro.md',
      kind: 'file',
    });
    expect(response.successBoolean).toBe(true);
    expect(JSON.parse(response.responseString)).toMatchObject({ how: 'document-editor', path: 'Projects/sulla-desktop/qa-two-device/editor-repro/agent-repro.md' });
  });
});
