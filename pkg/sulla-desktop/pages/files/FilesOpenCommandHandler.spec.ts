// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.

import { describe, expect, it } from 'vitest';

import { FilesOpenCommandHandler } from './FilesOpenCommandHandler';

import type { FilesOpenCommandNavigation, FilesOpenCommandOperations, FilesOpenCommandReply } from './FilesOpenCommandHandler';

interface TestTab { id: string; mode: 'files'; navigation?: FilesOpenCommandNavigation }

class InMemoryFilesOpenCommandOperations implements FilesOpenCommandOperations {
  readonly tabs: TestTab[] = [];
  readonly replies: Array<{ requestId: string; result: FilesOpenCommandReply }> = [];
  readonly focusCalls: string[] = [];
  available = true;
  createFailure: 'none' | 'null' | 'throw' = 'none';

  hasWindow(): boolean { return this.available }
  supportsDocumentEditor(): boolean { return false }
  openDocumentTab(): TestTab { throw new Error('Unexpected document editor route') }
  findFilesTab(): TestTab | undefined { return this.tabs.find(tab => tab.mode === 'files') }
  createFilesTab(navigation: FilesOpenCommandNavigation): TestTab | null {
    if (this.createFailure === 'throw') throw new Error('tab host unavailable');
    if (this.createFailure === 'null') return null;
    const tab = { id: `files-${ this.tabs.length + 1 }`, mode: 'files', navigation };
    this.tabs.push(tab);
    return tab;
  }
  updateFilesTab(tabId: string, navigation: FilesOpenCommandNavigation): void {
    const tab = this.tabs.find(candidate => candidate.id === tabId);
    if (!tab) throw new Error('Files tab disappeared');
    tab.navigation = navigation;
  }
  focusFilesTab(tabId: string): void { this.focusCalls.push(tabId) }
  reply(requestId: string, result: FilesOpenCommandReply): void { this.replies.push({ requestId, result }) }
}

describe('FilesOpenCommandHandler', () => {
  it('acks a background Files tab immediately and keeps its navigation on the created tab', () => {
    const operations = new InMemoryFilesOpenCommandOperations();
    const handler = new FilesOpenCommandHandler(operations);

    handler.handle({ requestId: 'req-background', kind: 'file', fileId: 'file-1', path: 'Projects/Notes.md', focus: false, mode: 'view' });

    expect(operations.tabs).toHaveLength(1);
    expect(operations.tabs[0].navigation).toEqual({
      fileId: 'file-1', path: 'Projects/Notes.md', collectionId: undefined,
      openRequestId: 'req-background', openKind: 'file',
    });
    expect(operations.focusCalls).toEqual([]);
    expect(operations.replies).toEqual([{
      requestId: 'req-background',
      result: { opened: true, tabId: 'files-1', path: 'Projects/Notes.md', how: 'file-manager-tab' },
    }]);
  });

  it('routes a focused open to the created tab and acknowledges without waiting for file selection', () => {
    const operations = new InMemoryFilesOpenCommandOperations();
    const handler = new FilesOpenCommandHandler(operations);

    handler.handle({ requestId: 'req-focused', kind: 'folder', path: 'Projects', focus: true });

    expect(operations.tabs[0].navigation).toMatchObject({ path: 'Projects', openKind: 'folder' });
    expect(operations.focusCalls).toEqual(['files-1']);
    expect(operations.replies[0]).toEqual({
      requestId: 'req-focused',
      result: { opened: true, tabId: 'files-1', path: 'Projects', how: 'file-manager-tab' },
    });
  });

  it('updates an existing Files tab instead of creating a second one', () => {
    const operations = new InMemoryFilesOpenCommandOperations();
    operations.tabs.push({
      id: 'files-existing', mode: 'files', navigation: { path: 'Old', openRequestId: 'old', openKind: 'folder' },
    });
    const handler = new FilesOpenCommandHandler(operations);

    handler.handle({ requestId: 'req-existing', kind: 'folder', path: 'Projects/sulla-desktop', focus: false });

    expect(operations.tabs).toHaveLength(1);
    expect(operations.tabs[0].navigation).toEqual({
      path: 'Projects/sulla-desktop', collectionId: undefined, openRequestId: 'req-existing', openKind: 'folder',
    });
    expect(operations.replies[0]?.result.tabId).toBe('files-existing');
  });

  it('acks opened:false with a clear reason when no window is available', () => {
    const operations = new InMemoryFilesOpenCommandOperations();
    operations.available = false;
    const handler = new FilesOpenCommandHandler(operations);

    handler.handle({ requestId: 'req-no-window', kind: 'folder', path: 'Projects' });

    expect(operations.tabs).toHaveLength(0);
    expect(operations.replies[0]).toEqual({
      requestId: 'req-no-window',
      result: {
        opened: false,
        reason: 'Main Sulla Desktop window is not available yet.',
        error: 'Main Sulla Desktop window is not available yet.',
      },
    });
  });

  it('acks opened:false with a clear reason when Files tab creation fails', () => {
    const operations = new InMemoryFilesOpenCommandOperations();
    operations.createFailure = 'null';
    const handler = new FilesOpenCommandHandler(operations);

    handler.handle({ requestId: 'req-create-failed', kind: 'folder', path: 'Projects' });

    expect(operations.focusCalls).toEqual([]);
    expect(operations.replies[0]).toEqual({
      requestId: 'req-create-failed',
      result: {
        opened: false,
        reason: 'Could not open the Files tab: The File Manager tab could not be created.',
        error: 'Could not open the Files tab: The File Manager tab could not be created.',
      },
    });
  });
});
