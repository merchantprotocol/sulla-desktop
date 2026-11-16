// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { boundedFilesResponseReader } from './sullaFilesBoundedResponse';
import { SULLA_FILES_UUID as UUID } from './SullaFilesIpcSupport';

import type { OpenDialogOptions, WebContents } from 'electron';
import type { SullaFilesIpcApi, SullaFilesIpcDesktop, SullaFilesIpcRegistrar, SullaFilesIpcServices } from './SullaFilesIpcSupport';

export interface SullaFilesNativeSourceRuntime {
  platform:NodeJS.Platform;
  mas:boolean | undefined;
}

const NATIVE_HANDLE = /^[A-Za-z0-9_-]{43}$/;

/** Experimental native-source linking: pick, list, reselect, revoke and publish back to the host file. */
export class SullaFilesIpcNativeSourceHandlers {
  constructor(
    private readonly api:SullaFilesIpcApi,
    private readonly services:Pick<SullaFilesIpcServices, 'watcher' | 'sourceGateway'>,
    private readonly mountManager:{ status():{ ready:boolean } },
    private readonly desktop:Pick<SullaFilesIpcDesktop, 'ownerWindow' | 'showOpenDialog' | 'startAccessingSecurityScopedResource'>,
    private readonly runtime:() => SullaFilesNativeSourceRuntime = () => ({ platform: process.platform, mas: process.mas }),
  ) {}

  private sourceDialogOptions(title:string):OpenDialogOptions {
    const { platform, mas } = this.runtime();
    return { title, properties: ['openFile'], securityScopedBookmarks: platform === 'darwin' && mas };
  }

  /** Requires the MAS grant, then starts accessing it; returns the release callback. */
  private securityScopedRelease(bookmarks:string[] | undefined):(() => void) | undefined {
    if (this.runtime().mas && !bookmarks?.[0]) throw new Error('The Mac App Store build did not return the required security-scoped file grant');
    return bookmarks?.[0] ? this.desktop.startAccessingSecurityScopedResource(bookmarks[0]) : undefined;
  }

  register(ipc:SullaFilesIpcRegistrar):void {
    ipc.handle('files-experiment:pick-native-source', async(event) => {
      if (!this.mountManager.status().ready) throw new Error('Native Files runtime is not ready');
      const owner = this.desktop.ownerWindow(event.sender);
      const picked = await this.desktop.showOpenDialog(owner, this.sourceDialogOptions('Choose a file to link into Sulla Files'));
      if (picked.canceled || !picked.filePaths[0]) return undefined;
      await this.services.watcher().prepareNativeSourceSession();
      const release = this.securityScopedRelease(picked.bookmarks);
      const gateway = this.services.sourceGateway();
      const handle = await gateway.registerExactFile(picked.filePaths[0], release);
      try {
        const snapshot = await gateway.read(handle);
        const operationId = randomUUID();
        const file = await this.services.watcher().ingestNativeSource({
          operationId,
          handle,
          sourceRevision: snapshot.revision,
          contentHash:    snapshot.contentHash,
          name:           path.basename(picked.filePaths[0]),
          bytes:          snapshot.bytes,
        });
        return {
          handle,
          operationId,
          sourceRevision: snapshot.revision,
          contentHash:    snapshot.contentHash,
          fileId:         file.id,
          versionId:      file.current_version_id,
          path:           file.path,
        };
      } catch (error) {
        gateway.revoke(handle);
        throw error;
      }
    });
    ipc.handle('files-experiment:list-native-sources', async() => {
      if (!this.mountManager.status().ready) return [];
      return (await this.services.watcher().listNativeSources()).map(({ handle: _handle, versionId: _versionId, path: _path, sourceRevision: _sourceRevision, sourceHash: _sourceHash, ...source }) => source);
    });
    ipc.handle('files-experiment:recover-native-source', (event, fileId:string) => this.recover(event.sender, fileId));
    ipc.handle('files-experiment:revoke-native-source', (_event, handle:string) => {
      if (!this.mountManager.status().ready || !NATIVE_HANDLE.exec(handle)) throw new Error('Native Files source handle is invalid');
      this.services.sourceGateway().revoke(handle);
    });
    ipc.handle('files-experiment:publish-native-source', (_event, input:{ handle: string; sourceRevision: string; fileId: string; versionId: string }) => this.publish(input));
  }

  async recover(sender:WebContents, fileId:string):Promise<{ fileId:string; versionId:string } | undefined> {
    if (!this.mountManager.status().ready || !UUID.test(fileId)) throw new Error('Native Files recovery input is invalid');
    const watcher = () => this.services.watcher();
    const source = (await watcher().listNativeSources()).find(item => item.fileId === fileId);
    if (source?.state !== 'reselect-required') throw new Error('Native Files source does not require reselection');
    const owner = this.desktop.ownerWindow(sender);
    const picked = await this.desktop.showOpenDialog(owner, this.sourceDialogOptions(`Reselect ${ source.name }`));
    if (picked.canceled || !picked.filePaths[0]) return undefined;
    await watcher().prepareNativeSourceSession();
    const release = this.securityScopedRelease(picked.bookmarks);
    const gateway = this.services.sourceGateway();
    const handle = await gateway.registerExactFile(picked.filePaths[0], release);
    try {
      const snapshot = await gateway.read(handle);
      const recovered = await watcher().reselectInterruptedNativePublication({
        fileId:         source.fileId,
        previousHandle: source.handle,
        handle,
        sourceRevision: snapshot.revision,
        sourceHash:     snapshot.contentHash,
      });
      if (recovered) {
        gateway.revoke(source.handle);
        return { fileId: source.fileId, versionId: source.versionId };
      }
      const result = await watcher().ingestNativeSource({
        operationId:    randomUUID(),
        handle,
        sourceRevision: snapshot.revision,
        contentHash:    snapshot.contentHash,
        name:           source.name,
        bytes:          snapshot.bytes,
        fileId:         source.fileId,
        baseVersionId:  source.versionId,
        filesPath:      source.path,
      });
      gateway.revoke(source.handle);
      return { fileId: result.id, versionId: result.current_version_id };
    } catch (error) { gateway.revoke(handle); throw error }
  }

  async publish(input:{ handle: string; sourceRevision: string; fileId: string; versionId: string }):Promise<{ operationId:string; sourceRevision:string; contentHash:string }> {
    if (!this.mountManager.status().ready) throw new Error('Native Files runtime is not ready');
    if (!NATIVE_HANDLE.test(input.handle) || !/^[a-f0-9]{64}$/i.test(input.sourceRevision) ||
        !UUID.test(input.fileId) || !UUID.test(input.versionId)) throw new Error('Native Files publication input is invalid');
    const response = await this.api.client.stream(`/v1/files/${ encodeURIComponent(input.fileId) }/download?versionId=${ encodeURIComponent(input.versionId) }`);
    const bytes = await boundedFilesResponseReader.read(response);
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const operationId = randomUUID();
    const watcher = this.services.watcher();
    await watcher.planNativePublication({
      operationId,
      handle:         input.handle,
      sourceRevision: input.sourceRevision,
      contentHash,
      fileId:         input.fileId,
      baseVersionId:  input.versionId,
    });
    try {
      const before = await this.services.sourceGateway().read(input.handle);
      if (before.revision !== input.sourceRevision) throw new Error('Native source changed before publication');
      const result = await this.services.sourceGateway().write(input.handle, input.sourceRevision, bytes);
      if (result.contentHash !== contentHash) throw new Error('Native source publication returned an unexpected content hash');
      await watcher.finishNativePublication(operationId, {
        nextSourceRevision:      result.revision,
        originalSourceRevision: input.sourceRevision,
        originalSourceHash:     before.contentHash,
        currentSourceHash:      contentHash,
        filesBaseVersionId:     input.versionId,
        currentFilesVersionId:  input.versionId,
      });
      return { operationId, sourceRevision: result.revision, contentHash: result.contentHash };
    } catch (error) {
      await watcher.finishNativePublication(operationId, { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      throw error;
    }
  }
}
