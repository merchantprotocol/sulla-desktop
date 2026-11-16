// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'node:path';

import { FilesListingPager } from './FilesListingPager';

import type { BrowserWindow, IpcMainInvokeEvent, OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue, WebContents } from 'electron';
import type { SullaFilesCaptureService } from './sullaFilesCapture';
import type { SullaFilesClient } from './sullaFilesClient';
import type { LinkService } from './sullaFilesLinkService';
import type { SullaFilesMountManager } from './sullaFilesMountManager';
import type { SullaFilesRootRegistry } from './sullaFilesRootRegistry';
import type { SullaFilesSourceGateway } from './sullaFilesSourceGateway';
import type { SullaFilesWatcher } from './sullaFilesWatcher';
import type { SullaFileProviderService } from './sullaFileProvider';

export const SULLA_FILES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The subset of Electron's ipcMain each handler class registers through. */
export interface SullaFilesIpcRegistrar {
  handle(channel:string, listener:(event:IpcMainInvokeEvent, ...args:any[]) => unknown):void;
}

export interface SullaFilesIpcLogger {
  warn(...args:unknown[]):void;
  error(...args:unknown[]):void;
}

/** Electron desktop surface used by the Files IPC handlers, injectable for tests. */
export interface SullaFilesIpcDesktop {
  ownerWindow(sender:WebContents):BrowserWindow | undefined;
  showOpenDialog(owner:BrowserWindow | undefined, options:OpenDialogOptions):Promise<OpenDialogReturnValue>;
  showSaveDialog(owner:BrowserWindow | undefined, options:SaveDialogOptions):Promise<SaveDialogReturnValue>;
  openPath(target:string):Promise<string>;
  showItemInFolder(target:string):void;
  startAccessingSecurityScopedResource(bookmark:string):() => void;
  userDataPath():string;
  broadcast(channel:string, payload:unknown):void;
  onceWillQuit(listener:() => void):void;
}

/** Lazily resolved Files collaborators: each is looked up when a handler runs, as before. */
export interface SullaFilesIpcServices {
  watcher():Pick<SullaFilesWatcher, 'status' | 'setPaused' | 'requestNativeFiles' | 'prepareNativeSourceSession' | 'ingestNativeSource' | 'listNativeSources' | 'reselectInterruptedNativePublication' | 'planNativePublication' | 'finishNativePublication'>;
  rootRegistry():Pick<SullaFilesRootRegistry, 'list' | 'add' | 'update' | 'remove' | 'rootForCollection'>;
  isProtectedTrackedPath(value:string):boolean;
  linkService():LinkService;
  capture():Pick<SullaFilesCaptureService, 'screenshot' | 'toggleRecording'>;
  sourceGateway():Pick<SullaFilesSourceGateway, 'registerExactFile' | 'read' | 'write' | 'revoke'>;
  fileProvider():Pick<SullaFileProviderService, 'start' | 'stop' | 'status' | 'setEnabled'>;
  mountManager():Pick<SullaFilesMountManager, 'on' | 'status'>;
  backups():{ remove(id:string):unknown };
  cloudSync():SullaFilesIpcCloudSync;
}

export interface SullaFilesIpcCloudSync {
  status():unknown;
  setEnabled(collectionId:string, enabled:boolean, caller:{ kind:'human' }):unknown;
  deleteCloudCopy(collectionId:string, caller:{ kind:'human' }):unknown;
  cloudCollections(caller:{ kind:'human' }):unknown;
  restore(collectionId:string, name:string, caller:{ kind:'human' }):unknown;
  restoreAll(caller:{ kind:'human' }):unknown;
}

export interface SullaFilesChatImport {
  importChatFiles(paths:string[]):Promise<unknown>;
  pickAndImportChatFiles(owner?:BrowserWindow):Promise<unknown>;
}

export interface FileReference {
  fileId:          string;
  versionId:       string;
  path:            string;
  name:            string;
  mime:            string;
  size:            number;
  updatedAt:       string;
  createdByType?:  string;
  createdById?:    string;
  collectionId?:   string;
  collectionKind?: string;
  agentRunId?:     string;
}

/** Desktop-authority Files service calls shared by every handler class. */
export class SullaFilesIpcApi {
  constructor(readonly client:SullaFilesClient) {}

  json(endpoint:string, init:RequestInit = {}, server = false):Promise<any> {
    return this.client.json(endpoint, init, { server });
  }

  listingRequest(url:string):Promise<Response> {
    return this.client.request(url);
  }

  /** Each collection's active files, one bounded page at a time. */
  async* collectionFilePages(collections:any[], folderPath = ''):AsyncGenerator<{ collection:any; files:any[] }> {
    for (const collection of collections) {
      for await (const files of FilesListingPager.pages<any>(url => this.listingRequest(url), '/v1/files', { collectionId: String(collection.id), path: folderPath, trash: 'false' })) yield { collection, files };
    }
  }

  reference(file:any, collection?:any):FileReference {
    return {
      fileId:         String(file.id),
      versionId:      String(file.current_version_id ?? ''),
      path:           String(file.path),
      name:           path.basename(String(file.path)),
      mime:           String(file.mime || 'application/octet-stream'),
      size:           Number(file.size ?? 0),
      updatedAt:      String(file.updated_at ?? new Date(0).toISOString()),
      createdByType:  file.created_by_type ?? file.version_created_by_type,
      createdById:    file.created_by_id ?? file.version_created_by_id,
      collectionId:   collection?.id ?? file.collection_id,
      collectionKind: collection?.kind,
      agentRunId:     collection?.agent_run_id,
    };
  }
}
