// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('./sullaFilesWatcher', () => ({ getSullaFilesWatcher: vi.fn() }));

import { SullaFilesIpcBrowseHandlers } from './SullaFilesIpcBrowseHandlers';
import { FilesApiError } from './sullaFilesClient';
import { SullaFilesIpcOperationHandlers } from './SullaFilesIpcOperationHandlers';
import { SullaFilesIpcReferenceHandlers } from './SullaFilesIpcReferenceHandlers';
import { SullaFilesIpcSettingsHandlers } from './SullaFilesIpcSettingsHandlers';
import { SullaFilesIpcApi, type SullaFilesIpcRegistrar } from './SullaFilesIpcSupport';

const COLLECTION = '11111111-1111-4111-8111-111111111111';

class FakeRegistrar implements SullaFilesIpcRegistrar {
  readonly handlers = new Map<string, (...args:any[]) => any>();
  handle(channel:string, listener:(...args:any[]) => unknown) { this.handlers.set(channel, listener as any) }
  call(channel:string, ...args:unknown[]) { return this.handlers.get(channel)!({ sender: { id: 1 } }, ...args) }
}

function fakeClient() {
  return { json: vi.fn(async() => ({})), request: vi.fn(), stream: vi.fn(), backupJson: vi.fn(), folderOperationState: vi.fn() };
}

describe('Files browse and folder handlers', () => {
  it('requires a valid collection before creating or deleting a folder', async() => {
    // risk: data integrity — folder writes without a valid collection must never reach Files.
    const client = fakeClient();
    const ipc = new FakeRegistrar();
    new SullaFilesIpcBrowseHandlers(new SullaFilesIpcApi(client as any)).registerFolders(ipc);
    await expect(ipc.call('files-ui:create-folder', 'Docs')).rejects.toThrow('Choose a Files collection before creating a folder');
    await expect(ipc.call('files-ui:create-folder', { collectionId: 'nope', path: 'Docs' })).rejects.toThrow('Choose a Files collection before creating a folder');
    await expect(ipc.call('files-ui:delete-folder', { collectionId: 'nope', path: 'Docs' })).rejects.toThrow('Choose a Files collection before removing a folder');
    await expect(ipc.call('files-ui:update-folder-description', { folderId: 'nope', description: 'd' })).rejects.toThrow('Choose a valid Files folder');
    expect(client.json).not.toHaveBeenCalled();
    await ipc.call('files-ui:create-folder', { collectionId: COLLECTION, path: 'Docs/New' });
    expect(client.json).toHaveBeenCalledWith('/v1/folders', { method: 'POST', body: JSON.stringify({ collectionId: COLLECTION, path: 'Docs/New' }) }, { server: false });
  });

  it('refuses the legacy whole listing past 20,000 rows instead of truncating', async() => {
    // risk: data accuracy — a silently truncated listing would hide files from the user.
    const client = fakeClient();
    let page = 0;
    client.request.mockImplementation(async() => {
      page++;
      const rows = Array.from({ length: 250 }, (_, index) => ({ id: `${ page }-${ index }` }));
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'X-Next-Cursor': `c${ page }`, 'X-Has-More': 'true' } });
    });
    const ipc = new FakeRegistrar();
    new SullaFilesIpcBrowseHandlers(new SullaFilesIpcApi(client as any)).register(ipc);
    const error = await ipc.call('sulla-files:list', { collectionId: COLLECTION }).catch((caught:unknown) => caught);
    expect(error).toBeInstanceOf(FilesApiError);
    expect(error).toMatchObject({ message: 'Listing exceeds 20,000 files; use sulla-files:list-page', status: 413 });
    expect(page).toBe(81);
  });

  it('rejects an invalid collection id for the change feed', async() => {
    // risk: input validation — a crafted id must not be interpolated into the journal URL.
    const ipc = new FakeRegistrar();
    new SullaFilesIpcBrowseHandlers(new SullaFilesIpcApi(fakeClient() as any)).registerFeed(ipc);
    expect(() => ipc.handlers.get('files-ui:watch')!({ sender: { id: 1 } }, '../x')).toThrow('Invalid Files collection');
  });
});

describe('Files operation handlers', () => {
  it('returns a save conflict as data with the current version id', async() => {
    // risk: data loss — the editor needs currentVersionId to resolve a concurrent edit instead of overwriting.
    const client = fakeClient();
    client.request.mockResolvedValue(new Response(JSON.stringify({ error: 'Changed', currentVersionId: 'v9' }), { status: 409 }));
    const ipc = new FakeRegistrar();
    new SullaFilesIpcOperationHandlers(new SullaFilesIpcApi(client as any)).register(ipc);
    await expect(ipc.call('sulla-files:save-content', { fileId: 'f1', baseVersionId: 'v1', content: 'x' })).resolves.toEqual({ conflict: { code: 'VERSION_CONFLICT', error: 'Changed', currentVersionId: 'v9' } });
    client.request.mockResolvedValue(new Response(JSON.stringify({ error: 'Locked' }), { status: 423 }));
    await expect(ipc.call('sulla-files:save-content', { fileId: 'f1', baseVersionId: 'v1', content: 'x' })).rejects.toThrow('Locked');
  });

  it('only sends invalidateUndo and kind on purge when requested', async() => {
    // risk: irreversible side effect — purge must not invalidate undo unless the human asked.
    const client = fakeClient();
    const ipc = new FakeRegistrar();
    new SullaFilesIpcOperationHandlers(new SullaFilesIpcApi(client as any)).register(ipc);
    await ipc.call('sulla-files:trash-purge', { id: 't 1', expectedRevision: '3', currentTombstone: { id: 'x' } });
    expect(client.json).toHaveBeenLastCalledWith('/v1/trash/t%201/purge', { method: 'DELETE', body: JSON.stringify({ expectedRevision: '3', currentTombstone: { id: 'x' } }) }, { server: false });
  });
});

describe('Files settings handlers', () => {
  function harness() {
    const fileProvider = { setEnabled: vi.fn(), status: vi.fn() };
    const cloudSync = { status: vi.fn(), setEnabled: vi.fn(), deleteCloudCopy: vi.fn(), cloudCollections: vi.fn(), restore: vi.fn(), restoreAll: vi.fn() };
    const client = fakeClient();
    const ipc = new FakeRegistrar();
    const storageCleanup = {
      inventory: vi.fn(() => Promise.resolve({ targets: [] })),
      takePreparedPreview: vi.fn(() => undefined),
      plan: vi.fn(() => Promise.resolve({ id: 'plan-1' })),
      review: vi.fn(() => ({
        id: 'plan-1',
        targets: [{ id: 'target-1', displayName: 'merchant/repo · feature', path: '/mnt/data/sulla/runtime/agents/checkout' }],
        blocked: [{ id: 'blocked-1', displayName: 'merchant/held · saved', path: '/mnt/data/sulla/runtime/agents/held', reason: 'Local stash is retained' }],
        estimatedRecoverableBytes: 42,
      })),
      cancel: vi.fn(() => Promise.resolve({ status: 'cancelled' })),
      execute: vi.fn(() => Promise.resolve({ status: 'completed' })),
    };
    const desktop = { ownerWindow: vi.fn(), showMessageBox: vi.fn(async(_window: Electron.BrowserWindow | undefined, _options: Electron.MessageBoxOptions) => ({ response: 1, checkboxChecked: false })) };
    const handlers = new SullaFilesIpcSettingsHandlers(new SullaFilesIpcApi(client as any), {
      rootRegistry: vi.fn(), fileProvider: () => fileProvider as any, backups: vi.fn(), watcher: vi.fn(), cloudSync: () => cloudSync, storageCleanup: () => storageCleanup,
    } as any, desktop as any);
    handlers.registerRoots(ipc);
    handlers.registerCloudBackup(ipc);
    handlers.registerBackups(ipc);
    handlers.registerStorageCleanup(ipc);

    return { ipc, fileProvider, cloudSync, client, storageCleanup, desktop };
  }

  it('enables the File Provider only for an explicit true, always as the human', async() => {
    // risk: permissions — truthy non-boolean input must not switch on the File Provider.
    const { ipc, fileProvider } = harness();
    await ipc.call('files-preferences:set-file-provider', { enabled: 'yes' });
    await ipc.call('files-preferences:set-file-provider', undefined);
    await ipc.call('files-preferences:set-file-provider', { enabled: true });
    expect(fileProvider.setEnabled.mock.calls).toEqual([[false, { kind: 'human' }], [false, { kind: 'human' }], [true, { kind: 'human' }]]);
  });

  it('refuses cloud backup changes for an invalid collection', async() => {
    // risk: irreversible side effect — deleting a cloud copy must require a valid collection id.
    const { ipc, cloudSync, client } = harness();
    await expect(ipc.call('files-ui:delete-cloud-backup', { collectionId: 'x' })).rejects.toThrow('Choose a valid Files collection');
    await expect(ipc.call('files-ui:set-cloud-backup', { collectionId: 'x', enabled: true })).rejects.toThrow('Choose a valid Files collection');
    await expect(ipc.call('files-ui:set-collection-cloud-sync', { collectionId: 'x', enabled: true })).rejects.toThrow('Choose a valid Files collection');
    expect(cloudSync.deleteCloudCopy).not.toHaveBeenCalled();
    expect(cloudSync.setEnabled).not.toHaveBeenCalled();
    expect(client.json).not.toHaveBeenCalled();
    await ipc.call('files-ui:delete-cloud-backup', { collectionId: COLLECTION });
    expect(cloudSync.deleteCloudCopy).toHaveBeenCalledWith(COLLECTION, { kind: 'human' });
  });

  it('routes backup control through the authenticated backup channel', async() => {
    // risk: security — backup runs must use backupJson (local authenticated channel), not the agent API.
    const { ipc, client } = harness();
    await ipc.call('files-backups:run', 'dest/1');
    expect(client.backupJson).toHaveBeenCalledWith('/v1/local/backups/dest%2F1/run', { method: 'POST' });
    expect(client.json).not.toHaveBeenCalled();
  });

  it('keeps cancellation in the trusted main-process confirmation boundary', async() => {
    const { ipc, storageCleanup, desktop } = harness();
    await expect(ipc.call('files-storage-cleanup:confirm', { planId: 'plan-1' })).resolves.toEqual({ status: 'cancelled' });
    expect(desktop.showMessageBox).toHaveBeenCalledWith(undefined, expect.objectContaining({ defaultId: 1, cancelId: 1 }));
    expect(desktop.showMessageBox.mock.calls[0][1].detail).toContain('merchant/repo · feature\n/mnt/data/sulla/runtime/agents/checkout');
    expect(desktop.showMessageBox.mock.calls[0][1].detail).toContain('merchant/held · saved · retained');
    expect(storageCleanup.cancel).toHaveBeenCalledWith('plan-1');
    expect(storageCleanup.execute).not.toHaveBeenCalled();
    desktop.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    await expect(ipc.call('files-storage-cleanup:confirm', { planId: 'plan-1' })).resolves.toEqual({ status: 'completed' });
    expect(storageCleanup.execute).toHaveBeenCalledWith('plan-1');
  });
});

describe('Files reference handlers', () => {
  function harness(readyFilesJson:(...args:any[]) => Promise<unknown>) {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const upload = { readyFilesJson: vi.fn(readyFilesJson) };
    const ipc = new FakeRegistrar();
    new SullaFilesIpcReferenceHandlers({
      api: new SullaFilesIpcApi(fakeClient() as any), desktop: { ownerWindow: vi.fn() }, services: { capture: vi.fn() } as any, upload: upload as any,
      copies: { open: vi.fn() }, reveal: { reveal: vi.fn() }, downloads: {} as any, chatImport: { importChatFiles: vi.fn(), pickAndImportChatFiles: vi.fn() }, logger,
    }).registerChat(ipc);

    return { ipc, upload, logger };
  }

  it('maps the chat inventory through the readiness-retrying Files query', async() => {
    // risk: regression — the split once called a deleted readyFilesJson so chat inventory was always empty.
    const { ipc, upload } = harness(async() => [{ id: 'f1', path: 'Run/out.txt', current_version_id: 'v1', mime: 'text/plain', size: 3, updated_at: '2026-01-01T00:00:00.000Z', collection_id: 'c1', collection_kind: 'agent', agent_run_id: 'r1' }]);
    const input = { runIds: ['r1'], threadId: 't1' };
    await expect(ipc.call('files-ui:chat-inventory', input)).resolves.toEqual({ files: [expect.objectContaining({ fileId: 'f1', versionId: 'v1', name: 'out.txt', collectionId: 'c1', collectionKind: 'agent', agentRunId: 'r1' })] });
    expect(upload.readyFilesJson).toHaveBeenCalledWith('/v1/agent-files/query', { method: 'POST', body: JSON.stringify(input) });
  });

  it('degrades to an empty inventory and logs only the status when Files is down', async() => {
    // risk: privacy + availability — chat must keep working and the log must not include request details.
    const { ipc, logger } = harness(async() => { throw new FilesApiError('secret detail', 503) });
    await expect(ipc.call('files-ui:chat-inventory', { runIds: [], threadId: 't' })).resolves.toEqual({ files: [], error: 'Files temporarily unavailable' });
    expect(logger.warn).toHaveBeenCalledWith('[SullaFiles] Chat inventory is temporarily unavailable (status=503)');
  });
});
