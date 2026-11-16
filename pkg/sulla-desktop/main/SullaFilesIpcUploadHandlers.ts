// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SullaFilesIpcMediaService } from './SullaFilesIpcMediaService';
import type { SullaFilesIpcUploadService } from './SullaFilesIpcUploadService';
import type { SullaFilesIpcApi, SullaFilesIpcDesktop, SullaFilesIpcLogger, SullaFilesIpcRegistrar } from './SullaFilesIpcSupport';

/** Desktop uploads from picked or dropped paths, and app-only media capability URLs. */
export class SullaFilesIpcUploadHandlers {
  constructor(
    private readonly api:SullaFilesIpcApi,
    private readonly upload:Pick<SullaFilesIpcUploadService, 'importPaths'>,
    private readonly media:Pick<SullaFilesIpcMediaService, 'capability'>,
    private readonly desktop:Pick<SullaFilesIpcDesktop, 'ownerWindow' | 'showOpenDialog'>,
    private readonly logger:SullaFilesIpcLogger,
  ) {}

  registerMedia(ipc:SullaFilesIpcRegistrar):void {
    ipc.handle('files-ui:media-url', async(event, input:{ fileId:string; versionId?:string }) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl || new URL(senderUrl).protocol !== 'app:') throw new Error('Files media URLs are only available to the Sulla application');
      await this.api.json(`/v1/files/${ encodeURIComponent(input.fileId) }`);
      return this.media.capability(input);
    });
    ipc.handle('files-ui:pick-upload', async(event, input:string | { collectionId?: string; destination?: string } = '') => {
      const destination = typeof input === 'string' ? input : input.destination ?? '';
      const collectionId = typeof input === 'string' ? undefined : input.collectionId;
      const owner = this.desktop.ownerWindow(event.sender);
      const picked = await this.desktop.showOpenDialog(owner, { title: 'Upload to Sulla Files', properties: ['openFile', 'multiSelections'] });
      if (picked.canceled) return 0;

      return this.upload.importPaths(picked.filePaths, destination, progress => event.sender.send('files-ui:upload-progress', progress), collectionId);
    });
  }

  registerPaths(ipc:SullaFilesIpcRegistrar):void {
    ipc.handle('files-ui:upload-paths', async(event, input:{ paths: string[]; destination?: string; collectionId?: string }) => {
      try { return await this.upload.importPaths(input.paths, input.destination, progress => event.sender.send('files-ui:upload-progress', progress), input.collectionId) } catch (error) {
        this.logger.warn('[SullaFiles] upload-paths failed:', error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
  }
}
