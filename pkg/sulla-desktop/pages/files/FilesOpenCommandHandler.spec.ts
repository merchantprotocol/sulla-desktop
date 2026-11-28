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
  readonly events: string[] = [];
  available = true;
  createFailure: 'none' | 'null' | 'throw' = 'none';

  hasWindow():boolean { return this.available }
  supportsDocumentEditor():boolean { return false }
  openDocumentTab():TestTab { throw new Error('Unexpected document editor route') }
  findFilesTab():TestTab | undefined { return this.tabs.find(tab => tab.mode === 'files') }
  createFilesTab(navigation:FilesOpenCommandNavigation):TestTab | null {
    if (this.createFailure === 'throw') throw new Error('tab host unavailable');
    if (this.createFailure === 'null') return null;
    const tab = { id: `files-${ this.tabs.length + 1 }`, mode: 'files' as const, navigation };
    this.tabs.push(tab);
    this.events.push('create');
    return tab;
  }
  updateFilesTab(tabId:string, navigation:FilesOpenCommandNavigation):void {
    const tab = this.tabs.find(candidate => candidate.id === tabId);
    if (!tab) throw new Error('Files tab disappeared');
    tab.navigation = navigation;
    this.events.push('update');
  }
  ensureTabMounted(tabId:string):void {
    this.events.push(`mount:${ tabId }`);
  }
  focusFilesTab(tabId:string):void { this.focusCalls.push(tabId); this.events.push(`focus:${ tabId }`); }
  reply(requestId:string, result:FilesOpenCommandReply):void {
    this.events.push('reply');
    this.replies.push({ requestId, result });
  }
}

describe('FilesOpenCommandHandler', () => {
  it('mounts a background Files tab at the requested folder before replying success without stealing focus', () => {
    const operations = new InMemoryFilesOpenCommandOperations();
    const handler = new FilesOpenCommandHandler(operations);

    handler.handle({ requestId: 'req-background', kind: 'folder', path: 'Projects/sulla-desktop', focus: false });

    expect(operations.tabs).toHaveLength(1);
    expect(operations.tabs[0].navigation).toEqual({
      path: 'Projects/sulla-desktop', collectionId: undefined,
      openRequestId: 'req-background', openKind: 'folder',
    });
    const mountIndex = operations.events.indexOf('mount:files-1');
    expect(mountIndex).toBeGreaterThanOrEqual(0);
    expect(mountIndex).toBeLessThan(operations.events.indexOf('reply'));
    expect(operations.focusCalls).toEqual([]);
    expect(operations.replies).toEqual([{
      requestId: 'req-background',
      result: { opened: true, tabId: 'files-1', path: 'Projects/sulla-desktop', how: 'file-manager-tab' },
    }]);
  });

  it('updates and mounts an existing Files tab before returning success for a folder open', () => {
    const operations = new InMemoryFilesOpenCommandOperations();
    operations.tabs.push({ id: 'files-existing', mode: 'files', navigation: { path: 'Old', openRequestId: 'old', openKind: 'folder' } });
    const handler = new FilesOpenCommandHandler(operations);

    handler.handle({ requestId: 'req-existing', kind: 'folder', path: 'Projects', focus: false });

    expect(operations.tabs).toHaveLength(1);
    expect(operations.tabs[0].navigation).toEqual({ path: 'Projects', collectionId: undefined, openRequestId: 'req-existing', openKind: 'folder' });
    expect(operations.events).toEqual(['update', 'mount:files-existing', 'reply']);
    expect(operations.replies[0]?.result).toMatchObject({ opened: true, tabId: 'files-existing', path: 'Projects' });
  });

  it('mounts a background document tab before acknowledging it', () => {
    const operations = new InMemoryFilesOpenCommandOperations();
    operations.supportsDocumentEditor = () => true;
    operations.openDocumentTab = () => ({ id: 'paper-1' });
    const handler = new FilesOpenCommandHandler(operations);

    handler.handle({ requestId: 'req-paper', kind: 'file', fileId: 'file-1', path: 'Projects/file.md', focus: false });

    expect(operations.events).toEqual(['mount:paper-1', 'reply']);
    expect(operations.focusCalls).toEqual([]);
    expect(operations.replies[0]?.result).toMatchObject({ opened: true, tabId: 'paper-1', how: 'document-editor' });
  });

  it('returns a clear failure when no Desktop window is available', () => {
    const operations = new InMemoryFilesOpenCommandOperations();
    operations.available = false;
    const handler = new FilesOpenCommandHandler(operations);

    handler.handle({ requestId: 'req-no-window', kind: 'folder', path: 'Projects' });

    expect(operations.tabs).toHaveLength(0);
    expect(operations.replies[0]?.result.error).toMatch(/window is not available/i);
  });

  it('returns a clear failure when tab creation fails', () => {
    const operations = new InMemoryFilesOpenCommandOperations();
    operations.createFailure = 'null';
    const handler = new FilesOpenCommandHandler(operations);

    handler.handle({ requestId: 'req-create-failed', kind: 'folder', path: 'Projects' });

    expect(operations.focusCalls).toEqual([]);
    expect(operations.replies[0]?.result.error).toMatch(/could not be created/i);
  });
});
