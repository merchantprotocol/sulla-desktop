// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.

export interface FilesOpenCommandNavigation {
  fileId?: string;
  path: string;
  collectionId?: string;
  openRequestId: string;
  openKind: 'file' | 'folder';
}

export interface FilesOpenCommandTab {
  id: string;
}

export interface FilesOpenCommandReply {
  opened: boolean;
  reason?: string;
  error?: string;
  tabId?: string;
  path?: string;
  how?: string;
}

export interface FilesOpenCommandOperations {
  hasWindow(): boolean;
  supportsDocumentEditor(path: string): boolean;
  openDocumentTab(file: { fileId: string; path: string; collectionId?: string }, focus: boolean): FilesOpenCommandTab | null;
  findFilesTab(): FilesOpenCommandTab | undefined;
  createFilesTab(navigation: FilesOpenCommandNavigation): FilesOpenCommandTab | null;
  updateFilesTab(tabId: string, navigation: FilesOpenCommandNavigation): void;
  focusFilesTab(tabId: string): void;
  reply(requestId: string, result: FilesOpenCommandReply): void;
}

/** Creates the Files tab, queues its navigation, and acknowledges tab creation independently of lazy renderer loading. */
export class FilesOpenCommandHandler {
  constructor(private readonly operations: FilesOpenCommandOperations) {}

  handle(input: unknown): void {
    if (!input || typeof input !== 'object') return;
    const command = input as Record<string, unknown>;
    const requestId = typeof command.requestId === 'string' ? command.requestId : '';
    if (!requestId) return;

    if (!this.operations.hasWindow()) {
      this.replyFailure(requestId, 'Main Sulla Desktop window is not available yet.');
      return;
    }

    const path = typeof command.path === 'string' ? command.path : '';
    const kind = command.kind;
    const fileId = typeof command.fileId === 'string' ? command.fileId : '';
    const collectionId = typeof command.collectionId === 'string' ? command.collectionId : undefined;
    if (!path || (kind !== 'folder' && (kind !== 'file' || !fileId))) {
      this.operations.reply(requestId, { opened: false, error: 'The resolved Files item is incomplete.' });
      return;
    }

    const focus = command.focus !== false;
    try {
      if (kind === 'file' && command.mode !== 'view' && this.operations.supportsDocumentEditor(path)) {
        const tab = this.operations.openDocumentTab({ fileId, path, collectionId }, focus);
        if (!tab?.id) throw new Error('The document tab could not be created.');
        this.operations.reply(requestId, { opened: true, tabId: tab.id, path, how: 'document-editor' });
        return;
      }

      const navigation: FilesOpenCommandNavigation = kind === 'folder'
        ? { path, collectionId, openRequestId: requestId, openKind: 'folder' }
        : { fileId, path, collectionId, openRequestId: requestId, openKind: 'file' };
      const existing = this.operations.findFilesTab();
      const tab = existing ?? this.operations.createFilesTab(navigation);
      if (!tab?.id) throw new Error('The File Manager tab could not be created.');
      if (existing) this.operations.updateFilesTab(tab.id, navigation);
      if (focus) this.operations.focusFilesTab(tab.id);

      // Navigation remains attached to this tab, but its later File Manager
      // selection result must not hold the open call behind lazy tab startup.
      this.operations.reply(requestId, { opened: true, tabId: tab.id, path, how: 'file-manager-tab' });
    } catch (cause) {
      const details = cause instanceof Error && cause.message.trim() ? `: ${ cause.message }` : '';
      this.replyFailure(requestId, `Could not open the Files tab${ details }`);
    }
  }

  private replyFailure(requestId: string, reason: string): void {
    this.operations.reply(requestId, { opened: false, reason, error: reason });
  }
}
