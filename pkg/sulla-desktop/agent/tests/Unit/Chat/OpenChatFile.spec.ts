// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openChatFile } from '@pkg/pages/chat/services/openChatFile';

const { invoke, openWorkspaceTab } = vi.hoisted(() => ({ invoke: vi.fn(), openWorkspaceTab: vi.fn() }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke } }));
vi.mock('@pkg/composables/useBrowserTabs', () => ({ openWorkspaceTab }));

describe('openChatFile', () => {
  beforeEach(() => vi.resetAllMocks());

  it('resolves the current path and collection for a saved proposal before opening it', async () => {
    invoke.mockResolvedValue({ id: 'proposal', path: 'Solitaire/Proposal.html', collection_id: 'project' });
    await openChatFile({ fileId: 'proposal', versionId: 'original' });
    expect(invoke).toHaveBeenCalledWith('sulla-files:metadata', { fileId: 'proposal' });
    expect(openWorkspaceTab).toHaveBeenCalledWith({
      mode: 'paper', documentFile: { fileId: 'proposal', path: 'Solitaire/Proposal.html', collectionId: 'project' },
    });
  });

  it('requests the attached screenshot version inside Files', async () => {
    invoke.mockResolvedValue({ id: 'image', path: 'Attachments/Screenshot.jpeg', collection_id: 'personal' });
    await openChatFile({ fileId: 'image', versionId: 'attached' });
    expect(openWorkspaceTab).toHaveBeenCalledWith({
      mode: 'files', title: 'File Manager',
      filesNavigation: { fileId: 'image', path: 'Attachments/Screenshot.jpeg', collectionId: 'personal', versionId: 'attached', section: 'detail' },
    });
  });

  it('reports a missing identity without opening a different file', async () => {
    invoke.mockResolvedValue({ id: 'different-file', path: 'Solitaire/Proposal.html', collection_id: 'project' });
    await expect(openChatFile({ fileId: 'proposal' })).rejects.toThrow('This file is no longer available in Files.');
    expect(openWorkspaceTab).not.toHaveBeenCalled();
  });
});
