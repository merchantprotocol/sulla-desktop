// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { documentEditorTypeIdForPath, type DocumentEditorTypeId } from './editor/editorTypes';

export type FilesOpenMode = 'edit' | 'view';
export type FilesOpenDestination = 'document-editor' | 'file-manager';

export interface FilesOpenDestinationDecision {
  destination:FilesOpenDestination;
  mode:FilesOpenMode;
}

/** Resolves Files open requests without allowing HTML to fall back to the Details viewer. */
export class FilesOpenDestinationRouter {
  constructor(private readonly documentTypeForPath:(path:string) => DocumentEditorTypeId | undefined = documentEditorTypeIdForPath) {}

  isHtmlPath(path:string):boolean { return this.documentTypeForPath(path) === 'html' }

  resolve(path:string, mode:FilesOpenMode = 'edit'):FilesOpenDestinationDecision {
    const documentType = this.documentTypeForPath(path);

    if (documentType === 'html') return { destination: 'document-editor', mode: 'edit' };
    if (documentType && mode !== 'view') return { destination: 'document-editor', mode: 'edit' };
    return { destination: 'file-manager', mode };
  }
}
