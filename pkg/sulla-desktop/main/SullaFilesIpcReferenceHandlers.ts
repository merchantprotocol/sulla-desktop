// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesApiError } from './sullaFilesClient';

import type { ScreenshotMode } from './sullaFilesCapture';
import type { SullaFilesIpcDownloadService } from './SullaFilesIpcDownloadService';
import type { SullaFilesIpcOpenedCopyService } from './SullaFilesIpcOpenedCopyService';
import type { SullaFilesIpcOriginalRevealService } from './SullaFilesIpcOriginalRevealService';
import type { SullaFilesIpcUploadService } from './SullaFilesIpcUploadService';
import type { SullaFilesChatImport, SullaFilesIpcApi, SullaFilesIpcDesktop, SullaFilesIpcLogger, SullaFilesIpcRegistrar, SullaFilesIpcServices } from './SullaFilesIpcSupport';

export interface SullaFilesIpcReferenceDependencies {
  api:SullaFilesIpcApi;
  desktop:Pick<SullaFilesIpcDesktop, 'ownerWindow'>;
  services:Pick<SullaFilesIpcServices, 'capture'>;
  upload:Pick<SullaFilesIpcUploadService, 'readyFilesJson'>;
  copies:Pick<SullaFilesIpcOpenedCopyService, 'open'>;
  reveal:Pick<SullaFilesIpcOriginalRevealService, 'reveal'>;
  downloads:Pick<SullaFilesIpcDownloadService, 'openWithApplication' | 'recentApplications' | 'fileExtension' | 'downloadReference' | 'downloadReferences'>;
  chatImport:SullaFilesChatImport;
  logger:SullaFilesIpcLogger;
}

/** Chat references, capture, and opening, revealing or downloading Files content on this computer. */
export class SullaFilesIpcReferenceHandlers {
  constructor(private readonly deps:SullaFilesIpcReferenceDependencies) {}

  registerChat(ipc:SullaFilesIpcRegistrar):void {
    const { api, desktop, chatImport, logger } = this.deps;
    ipc.handle('files-ui:pick-reference', async(event) => {
      try {
        const owner = desktop.ownerWindow(event.sender);
        return await chatImport.pickAndImportChatFiles(owner);
      } catch (error) {
        logger.warn('[SullaFiles] pick-reference failed:', error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
    ipc.handle('files-ui:chat-inventory', async(_event, input:{ runIds:string[]; threadId:string }) => {
      try {
        const files = await this.deps.upload.readyFilesJson<any[]>('/v1/agent-files/query', { method: 'POST', body: JSON.stringify(input) });

        return { files: files.map(file => api.reference(file, {
          id: file.collection_id, kind: file.collection_kind, agent_run_id: file.agent_run_id,
        })) };
      } catch (error) {
        const status = error instanceof FilesApiError ? error.status : 'request-failed';

        logger.warn(`[SullaFiles] Chat inventory is temporarily unavailable (status=${ status })`);
        return { files: [], error: 'Files temporarily unavailable' };
      }
    });
    ipc.handle('files-ui:reference-content', async(_event, input:{ fileId:string; versionId?:string }) => {
      const query = input.versionId ? `?versionId=${ encodeURIComponent(input.versionId) }` : '';
      const response = await api.client.request(`/v1/files/${ encodeURIComponent(input.fileId) }/preview${ query }`);
      if (!response.ok) throw new Error(`Files content failed (${ response.status })`);
      return { mime: response.headers.get('content-type') ?? 'application/octet-stream', data: new Uint8Array(await response.arrayBuffer()) };
    });
    ipc.handle('files-ui:capture-screenshot', async(_event, mode:ScreenshotMode = 'area') => {
      try {
        const capture = await this.deps.services.capture().screenshot(mode);
        if (!capture.reference?.versionId) throw new Error('Files did not return the durable screenshot version.');
        return { reference: capture.reference };
      } catch (error) {
        if (!(error as { cancelled?:boolean })?.cancelled) logger.warn('[SullaFiles] capture-screenshot failed:', error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
    ipc.handle('files-ui:toggle-recording', (_event, input:{ mic: boolean; camera: boolean }) => this.deps.services.capture().toggleRecording(input));
  }

  registerLocal(ipc:SullaFilesIpcRegistrar):void {
    const { copies, reveal, downloads, desktop, chatImport, logger } = this.deps;
    ipc.handle('files-ui:open-file', (_event, input:{ fileId:string; versionId?:string }) => copies.open(input));
    ipc.handle('files-ui:open-default', (_event, input:{ fileId:string; versionId?:string }) => copies.open(input));
    ipc.handle('files-ui:open-with', (event, input:{ fileId:string; versionId?:string; application?:string }) => downloads.openWithApplication(event, input));
    ipc.handle('files-ui:recent-apps', async(_event, input:{ name:string }) => (await downloads.recentApplications())[downloads.fileExtension(input.name)] ?? []);
    ipc.handle('files-ui:reveal-file', (_event, input:{ fileId:string; versionId?:string }) => reveal.reveal(input));
    ipc.handle('files-ui:download-file', (event, input:{ fileId:string; versionId?:string; name:string }) => downloads.downloadReference(event, input));
    ipc.handle('files-ui:download-files', (event, input:{ fileId:string; versionId?:string; name:string }[]) => downloads.downloadReferences(event, input));
    ipc.handle('files-ui:pick-upload-references', async(event) => {
      try {
        const owner = desktop.ownerWindow(event.sender);
        return await chatImport.pickAndImportChatFiles(owner);
      } catch (error) {
        logger.warn('[SullaFiles] pick-upload-references failed:', error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
    ipc.handle('files-ui:import-path-references', async(_event, input:{ paths:string[] }) => {
      try { return await chatImport.importChatFiles(input.paths) } catch (error) {
        logger.warn('[SullaFiles] import-path-references failed:', error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
  }
}
