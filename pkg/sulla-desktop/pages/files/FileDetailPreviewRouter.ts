// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { documentEditorTypeIdForPath, type DocumentEditorTypeId } from './editor/editorTypes';

export type FileDetailPreviewDecision =
  | { kind: 'editor' }
  | { kind: 'document'; documentType: DocumentEditorTypeId }
  | { kind: 'video' | 'audio' | 'image' | 'pdf' | 'unsupported' };

export class FileDetailPreviewRouter {
  constructor(
    private readonly documentTypeForPath: (path:string) => DocumentEditorTypeId | undefined = documentEditorTypeIdForPath,
  ) {}

  resolve(path:string, mime:string):FileDetailPreviewDecision {
    const normalizedMime = mime.trim().toLowerCase();
    const documentType = this.documentTypeForPath(path) ?? this.documentTypeForMime(normalizedMime);

    if (documentType === 'html') return { kind: 'editor' };
    if (documentType) return { kind: 'document', documentType };
    if (normalizedMime.startsWith('video/')) return { kind: 'video' };
    if (normalizedMime.startsWith('audio/')) return { kind: 'audio' };
    if (/^image\/(?:avif|gif|jpeg|png|webp)(?:;|$)/.test(normalizedMime)) return { kind: 'image' };
    if (/^application\/pdf(?:;|$)/.test(normalizedMime)) return { kind: 'pdf' };
    return { kind: 'unsupported' };
  }

  private documentTypeForMime(mime:string):DocumentEditorTypeId | undefined {
    if (/^(?:text\/markdown|text\/x-markdown|application\/x-markdown)(?:;|$)/.test(mime)) return 'markdown';
    if (/^text\/html(?:;|$)/.test(mime)) return 'html';
    if (/^text\/plain(?:;|$)/.test(mime)) return 'text';
    return undefined;
  }
}
