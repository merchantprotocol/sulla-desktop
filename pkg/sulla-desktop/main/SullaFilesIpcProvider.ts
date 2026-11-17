// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SullaFilesIpcBrowseHandlers } from './SullaFilesIpcBrowseHandlers';
import { SullaFilesIpcDownloadService } from './SullaFilesIpcDownloadService';
import { SullaFilesIpcLiveHandlers } from './SullaFilesIpcLiveHandlers';
import { SullaFilesIpcMediaService } from './SullaFilesIpcMediaService';
import { SullaFilesIpcNativeSourceHandlers } from './SullaFilesIpcNativeSourceHandlers';
import { SullaFilesIpcOpenedCopyService } from './SullaFilesIpcOpenedCopyService';
import { SullaFilesIpcOperationHandlers } from './SullaFilesIpcOperationHandlers';
import { SullaFilesIpcOriginalRevealService } from './SullaFilesIpcOriginalRevealService';
import { SullaFilesIpcReferenceHandlers } from './SullaFilesIpcReferenceHandlers';
import { SullaFilesIpcSettingsHandlers } from './SullaFilesIpcSettingsHandlers';
import { SullaFilesIpcSharingHandlers } from './SullaFilesIpcSharingHandlers';
import { SullaFilesIpcApi } from './SullaFilesIpcSupport';
import { SullaFilesIpcUploadHandlers } from './SullaFilesIpcUploadHandlers';
import { SullaFilesIpcUploadService } from './SullaFilesIpcUploadService';
import { OrgFilesDesktopRuntime } from './cloud/orgFiles/OrgFilesDesktopRuntime';

import type { Protocol } from 'electron';
import type { SullaFilesClient } from './sullaFilesClient';
import type { SullaFilesChatImport, SullaFilesIpcDesktop, SullaFilesIpcLogger, SullaFilesIpcRegistrar, SullaFilesIpcServices } from './SullaFilesIpcSupport';

export interface SullaFilesIpcProviderDependencies {
  /** Logged ipcMain proxy used by every typed Files channel. */
  ipc:SullaFilesIpcRegistrar;
  /** Raw Electron ipcMain: live co-editing channels are registered outside the proxy. */
  rawIpc:SullaFilesIpcRegistrar;
  client:SullaFilesClient;
  protocol:Protocol;
  desktop:SullaFilesIpcDesktop;
  services:SullaFilesIpcServices;
  chatImport:SullaFilesChatImport;
  logger:SullaFilesIpcLogger;
  cachePath:() => string;
  registerUseCaseSuggestions(watcher:ReturnType<SullaFilesIpcServices['watcher']>):void;
}

/**
 * Builds the Files IPC handler classes and registers every channel once.
 * Side-effect order matches the original procedural initializer: watcher,
 * use-case suggestions, File Provider start, feed/operations, media protocol,
 * mount-manager broadcast, then the remaining channels.
 */
export class SullaFilesIpcProvider {
  constructor(private readonly deps:SullaFilesIpcProviderDependencies) {}

  register():void {
    const { ipc, rawIpc, client, protocol, desktop, services, chatImport, logger } = this.deps;
    const watcher = services.watcher();
    ipc.handle('files-ui:create-org-collection', (_event, input:{ orgId?:string; orgName?:string; name:string }) =>
      OrgFilesDesktopRuntime.current().createCollection(input));
    const api = new SullaFilesIpcApi(client);
    const upload = new SullaFilesIpcUploadService(client);
    const media = new SullaFilesIpcMediaService(protocol, client);
    this.deps.registerUseCaseSuggestions(watcher);
    void services.fileProvider().start();
    desktop.onceWillQuit(() => { void services.fileProvider().stop() });

    const browse = new SullaFilesIpcBrowseHandlers(api);
    const operations = new SullaFilesIpcOperationHandlers(api);
    browse.registerFeed(ipc);
    operations.registerOperations(ipc);
    try { media.initialize() } catch (error) { logger.error('Files media protocol failed to initialize:', error) }
    const mountManager = services.mountManager();
    mountManager.on('changed', status => desktop.broadcast('files-ui:native-runtime-changed', status));
    ipc.handle('files-ui:native-runtime', () => mountManager.status());

    const copies = new SullaFilesIpcOpenedCopyService(api, desktop, this.deps.cachePath);
    const reveal = new SullaFilesIpcOriginalRevealService(services, copies, desktop);
    const downloads = new SullaFilesIpcDownloadService(api, desktop, copies);
    const sharing = new SullaFilesIpcSharingHandlers(api, services, upload);
    const references = new SullaFilesIpcReferenceHandlers({ api, desktop, services, upload, copies, reveal, downloads, chatImport, logger });
    const settings = new SullaFilesIpcSettingsHandlers(api, services, desktop);
    const uploads = new SullaFilesIpcUploadHandlers(api, upload, media, desktop, logger);

    browse.register(ipc);
    new SullaFilesIpcLiveHandlers(api).register(rawIpc);
    operations.register(ipc);
    sharing.register(ipc);
    references.registerChat(ipc);
    sharing.registerLinks(ipc);
    settings.registerRoots(ipc);
    settings.registerBackups(ipc);
    browse.registerFolders(ipc);
    settings.registerCloudBackup(ipc);
    references.registerLocal(ipc);
    uploads.registerMedia(ipc);
    new SullaFilesIpcNativeSourceHandlers(api, services, mountManager, desktop).register(ipc);
    uploads.registerPaths(ipc);
  }
}
