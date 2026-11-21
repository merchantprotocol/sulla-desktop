// SPDX-License-Identifier: GPL-2.0-or-later

interface WorkspaceFile {
  fileId: string;
  path: string;
  collectionId?: string;
}

export type WorkspaceFilesSection = 'detail' | 'versions' | 'share-review';

export type WorkspaceTabRequest =
  | { mode: 'paper'; documentFile: WorkspaceFile }
  | { mode: 'files'; title: string; filesNavigation: WorkspaceFile & { section: WorkspaceFilesSection; versionId?: string } }
  | { mode: 'chat'; title: string; initialAgentId: string };
