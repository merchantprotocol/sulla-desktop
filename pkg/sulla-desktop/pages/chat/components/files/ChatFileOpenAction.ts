// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FilesOpenDestinationRouter } from '@pkg/pages/files/FilesOpenDestinationRouter';

export interface ChatFileOpenReference {
  fileId:string;
  path:string;
  collectionId:string;
  versionId?:string;
}

export interface ChatFileOpenPorts {
  openHtmlInEditor(request:Pick<ChatFileOpenReference, 'fileId' | 'path' | 'collectionId'>):Promise<unknown> | unknown;
  openWithDefaultApp(request:Pick<ChatFileOpenReference, 'fileId' | 'versionId'>):Promise<unknown>;
}

/** Sends HTML card actions to the full-page editor without changing other card open behavior. */
export class ChatFileOpenAction {
  constructor(
    private readonly destinationRouter:FilesOpenDestinationRouter,
    private readonly ports:ChatFileOpenPorts,
  ) {}

  async open(reference:ChatFileOpenReference):Promise<void> {
    if (this.destinationRouter.isHtmlPath(reference.path)) {
      await this.ports.openHtmlInEditor({ fileId: reference.fileId, path: reference.path, collectionId: reference.collectionId });
      return;
    }

    await this.ports.openWithDefaultApp({ fileId: reference.fileId, versionId: reference.versionId });
  }
}
