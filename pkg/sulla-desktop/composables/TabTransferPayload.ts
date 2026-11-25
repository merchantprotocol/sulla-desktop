// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { toRaw } from 'vue';

import type { BrowserTab } from './useBrowserTabs';

export interface TabEditorTransferSnapshot {
  tabId: string;
  fileEditor: NonNullable<BrowserTab['transferState']>;
}

/** Copy the transfer DTO explicitly; neither Vue proxies nor incidental state cross IPC. */
export class TabTransferPayload {
  descriptor(tab: BrowserTab) {
    const raw = toRaw(tab);
    const { filesNavigation, documentFile, agentChat, supportSession, transferState } = raw;

    return {
      id: raw.id,
      url: raw.url,
      title: raw.title,
      favicon: raw.favicon,
      loading: raw.loading,
      mode: raw.mode,
      assetId: raw.assetId,
      content: raw.content,
      recipeAppSlug: raw.recipeAppSlug,
      studioSection: raw.studioSection,
      section: raw.section,
      customTitle: raw.customTitle,
      lastAccessedAt: raw.lastAccessedAt,
      initialAgentId: raw.initialAgentId,
      ...(filesNavigation && {
        filesNavigation: {
          fileId: filesNavigation.fileId,
          versionId: filesNavigation.versionId,
          path: filesNavigation.path,
          section: filesNavigation.section,
          collectionId: filesNavigation.collectionId,
          openRequestId: filesNavigation.openRequestId,
          openKind: filesNavigation.openKind,
        },
      }),
      ...(documentFile && {
        documentFile: { fileId: documentFile.fileId, path: documentFile.path, collectionId: documentFile.collectionId },
      }),
      ...(agentChat && {
        agentChat: {
          threadId: agentChat.threadId,
          agentId: agentChat.agentId,
          agentName: agentChat.agentName,
          parentThreadId: agentChat.parentThreadId,
          parentAgentId: agentChat.parentAgentId,
          parentAgentName: agentChat.parentAgentName,
          contractId: agentChat.contractId,
          depth: agentChat.depth,
        },
      }),
      ...(supportSession && { supportSession: { sessionId: supportSession.sessionId } }),
      ...(transferState && { transferState: this.editorState(transferState) }),
    };
  }

  transient(snapshot: TabEditorTransferSnapshot | undefined, pinned: boolean) {
    return { pinned, ...(snapshot && { fileEditor: this.editorState(snapshot.fileEditor) }) };
  }

  private editorState(value: NonNullable<BrowserTab['transferState']>) {
    return { filePath: value.filePath, text: value.text, dirty: value.dirty };
  }
}
