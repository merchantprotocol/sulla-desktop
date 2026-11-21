// SPDX-License-Identifier: GPL-2.0-or-later

import { openWorkspaceTab } from '@pkg/composables/useBrowserTabs';
import { supportsDocumentEditor } from '@pkg/pages/files/editor/editorTypes';
import type { WorkspaceFileSection } from '@pkg/shared/workspaceTabRequest';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

interface ChatFileIdentity {
  fileId: string;
  versionId?: string;
}

interface SavedFile {
  id: string;
  path: string;
  collection_id?: string;
  collectionId?: string;
  deleted_at?: string;
}

/** Open the saved Files identity in the shell even when the chat has its own renderer. */
export class ChatFileOpeningService {
  async open(reference: ChatFileIdentity, section?: WorkspaceFileSection): Promise<void> {
    const saved = await ipcRenderer.invoke('sulla-files:metadata', { fileId: reference.fileId }) as SavedFile;
    if (saved?.id !== reference.fileId || !saved.path || saved.deleted_at) {
      throw new Error('This file is no longer available in Files.');
    }

    const file = { fileId: saved.id, path: saved.path, collectionId: saved.collection_id ?? saved.collectionId };
    if (!section && supportsDocumentEditor(file.path)) {
      await openWorkspaceTab({ mode: 'paper', documentFile: file });
      return;
    }

    await openWorkspaceTab({
      mode: 'files',
      title: 'File Manager',
      filesNavigation: { ...file, section: section ?? 'detail', versionId: reference.versionId || undefined },
    });
  }
}

const chatFileOpeningService = new ChatFileOpeningService();
export const openChatFile = (reference: ChatFileIdentity, section?: WorkspaceFileSection) => chatFileOpeningService.open(reference, section);
