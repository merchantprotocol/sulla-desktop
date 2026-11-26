// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FileDetailPreviewRouter } from '../FileDetailPreviewRouter';
import type { DocumentEditorTypeId } from '../editor/editorTypes';
import type { DisplayEntry } from './FilesBrowserTypes';

export type FilesBrowserOpenKind = 'folder' | 'editor' | 'media-preview' | 'detail-preview';

/** The single routing decision for opening a row from the Files browser. */
export class FilesBrowserOpenDecision {
  constructor(
    private readonly previewRouter:FileDetailPreviewRouter,
    private readonly editorTypeForPath:(path:string) => DocumentEditorTypeId | undefined,
  ) {}

  resolve(entry:Pick<DisplayEntry, 'folder' | 'path' | 'mime'>):FilesBrowserOpenKind {
    if (entry.folder) return 'folder';
    if (this.editorTypeForPath(entry.path)) return 'editor';

    const preview = this.previewRouter.resolve(entry.path, entry.mime);

    if (preview.kind === 'video' || preview.kind === 'audio') return 'media-preview';
    return 'detail-preview';
  }
}
