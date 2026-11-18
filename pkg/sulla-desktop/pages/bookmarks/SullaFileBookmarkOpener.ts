// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// SullaFileBookmarkOpener — opens a `sulla-file:` bookmark the way a chat file card opens its file:
// the Files document tab when the editor supports the path, otherwise the Files open-file handler.
// The request carries the fileId and path only, never a version, so the latest version opens.

import { SullaFileBookmarkLink } from '@pkg/shared/sullaFileBookmark';

import type { BookmarkRecord } from '@pkg/agent/database/models/BrowserBookmarkModel';

export interface SullaFileOpenRequest {
  fileId: string;
  path:   string;
}

/** Collaborators the opener needs from the renderer. Injected so the rule stays testable without Vue or Electron. */
export interface SullaFileOpenPorts {
  canOpenInEditor(path: string): boolean;
  openDocument(request: SullaFileOpenRequest): void;
  openWithFilesHandler(fileId: string): Promise<unknown>;
}

export class SullaFileBookmarkOpener {
  constructor(private readonly ports: SullaFileOpenPorts) {}

  /** Returns false when the record is not a valid Files bookmark, so the caller can fall back. */
  async open(record: Pick<BookmarkRecord, 'kind' | 'url'>): Promise<boolean> {
    if (record.kind !== 'bookmark') return false;
    const target = SullaFileBookmarkLink.parse(record.url ?? '');
    if (!target) return false;

    const request: SullaFileOpenRequest = { fileId: target.fileId, path: target.path };
    if (this.ports.canOpenInEditor(request.path)) this.ports.openDocument(request);
    else await this.ports.openWithFilesHandler(request.fileId);

    return true;
  }
}
