// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { describe, expect, it, vi } from 'vitest';

import { FileDownloadAction } from './FileDownloadAction';

describe('FileDownloadAction', () => {
  it('starts only one save dialog for the displayed file and version', async() => {
    let finish!: (saved: boolean) => void;
    const ipc = { invoke: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve })) };
    const action = FileDownloadAction.forIpc(ipc, () => 'file');
    const pending = action.download('notes.md', 'previous');

    expect(action.state.busy).toBe(true);
    await action.download('other.md', 'latest');
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('files-ui:download-file', {
      fileId: 'file', name: 'notes.md', versionId: 'previous',
    });
    finish(true);
    await pending;
    expect(action.state).toEqual({ busy: false, error: '' });
  });

  it('reports a failure, clears it at the start of a retry, and allows the retry to finish', async() => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error('IPC failed')).mockResolvedValueOnce(true);
    const action = new FileDownloadAction(invoke);

    await action.download('notes.md');
    expect(action.state.busy).toBe(false);
    expect(action.state.error).toBeTruthy();
    const retry = action.download('notes.md');
    expect(action.state).toEqual({ busy: true, error: '' });
    await retry;
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(action.state).toEqual({ busy: false, error: '' });
  });

  it('treats dismissal of the native dialog as cancellation, not failure', async() => {
    const ipc = { invoke: vi.fn().mockResolvedValue(false) };
    const action = FileDownloadAction.forIpc(ipc, () => 'file');

    await action.download('notes.md');
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('files-ui:download-file', {
      fileId: 'file', name: 'notes.md', versionId: undefined,
    });
    expect(action.state).toEqual({ busy: false, error: '' });
  });
});
