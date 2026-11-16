// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ipcMain as liveIpcMain, app, BrowserWindow, dialog, protocol, shell, webContents, type OpenDialogOptions, type SaveDialogOptions, type WebContents } from 'electron';

import { getIpcMainProxy } from './ipcMain';
import { getSullaFilesCaptureService } from './sullaFilesCapture';
import { importChatFiles, pickAndImportChatFiles } from './sullaFilesChatImport';
import { getSullaFilesClient } from './sullaFilesClient';
import { SullaFilesIpcProvider } from './SullaFilesIpcProvider';
import { getSullaFilesLinkService } from './sullaFilesLinkService';
import { getSullaFilesRootRegistry, isProtectedTrackedPath } from './sullaFilesRootRegistry';
import { getSullaFilesSourceGateway } from './sullaFilesSourceGateway';
import { getSullaFilesWatcher } from './sullaFilesWatcher';
import { getSullaFilesBackups } from './sullaFilesBackups';
import { getSullaFilesMountManager } from './sullaFilesMountManager';
import { getSullaFileProvider } from './sullaFileProvider';
import { FilesSyncV1 } from './cloud/filesSyncV1';
import { createUseCaseSuggestionIpcRegistrar } from './useCaseSuggestionIpc';

import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';

import type { SullaFilesIpcDesktop, SullaFilesIpcServices } from './SullaFilesIpcSupport';

/** Electron-backed desktop surface for the Files IPC handlers. */
export class SullaFilesIpcElectronDesktop implements SullaFilesIpcDesktop {
  ownerWindow(sender:WebContents):BrowserWindow | undefined { return BrowserWindow.fromWebContents(sender) ?? undefined }
  showOpenDialog(owner:BrowserWindow | undefined, options:OpenDialogOptions) { return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options) }
  showSaveDialog(owner:BrowserWindow | undefined, options:SaveDialogOptions) { return owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options) }
  openPath(target:string):Promise<string> { return shell.openPath(target) }
  showItemInFolder(target:string):void { shell.showItemInFolder(target) }
  startAccessingSecurityScopedResource(bookmark:string):() => void { return app.startAccessingSecurityScopedResource(bookmark) as () => void }
  userDataPath():string { return app.getPath('userData') }
  broadcast(channel:string, payload:unknown):void { for (const contents of webContents.getAllWebContents()) contents.send(channel, payload) }
  onceWillQuit(listener:() => void):void { app.once('will-quit', listener) }
}

/** Resolves each Files collaborator from its provider at call time. */
export class SullaFilesIpcElectronServices implements SullaFilesIpcServices {
  watcher() { return getSullaFilesWatcher() }
  rootRegistry() { return getSullaFilesRootRegistry() }
  isProtectedTrackedPath(value:string):boolean { return isProtectedTrackedPath(value) }
  linkService() { return getSullaFilesLinkService() }
  capture() { return getSullaFilesCaptureService() }
  sourceGateway() { return getSullaFilesSourceGateway() }
  fileProvider() { return getSullaFileProvider() }
  mountManager() { return getSullaFilesMountManager() }
  backups() { return getSullaFilesBackups() }
  cloudSync() { return FilesSyncV1 }
}

/** Wires the Files IPC provider to Electron's ipcMain, dialogs, shell and Files services. */
export class SullaFilesIpcElectronRuntime {
  provider():SullaFilesIpcProvider {
    const logger = Logging.background;
    const ipcMain = getIpcMainProxy(logger);

    return new SullaFilesIpcProvider({
      ipc:        { handle: (channel, listener) => ipcMain.handle(channel as any, listener as any) },
      rawIpc:     { handle: (channel, listener) => liveIpcMain.handle(channel, listener) },
      client:     getSullaFilesClient(),
      protocol,
      desktop:    new SullaFilesIpcElectronDesktop(),
      services:   new SullaFilesIpcElectronServices(),
      chatImport: { importChatFiles, pickAndImportChatFiles },
      logger,
      cachePath:  () => paths.cache,
      registerUseCaseSuggestions: watcher => createUseCaseSuggestionIpcRegistrar(
        (channel, handler) => ipcMain.handle(channel, handler),
        (channel, handler) => ipcMain.handle(channel, handler),
        watcher as Parameters<typeof createUseCaseSuggestionIpcRegistrar>[2],
      ).register(),
    });
  }
}

/** Compatibility entry point imported by sullaEvents.ts. */
export function initSullaFilesIpc():void {
  new SullaFilesIpcElectronRuntime().provider().register();
}
