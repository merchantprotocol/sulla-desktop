// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

vi.mock('./sullaFilesWatcher', () => ({ getSullaFilesWatcher: vi.fn() }));

import { SullaFilesIpcNativeSourceHandlers } from './SullaFilesIpcNativeSourceHandlers';
import { SullaFilesIpcApi } from './SullaFilesIpcSupport';

const HANDLE = 'A'.repeat(43);
const REVISION = 'a'.repeat(64);
const FILE_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const BYTES = Buffer.from('published bytes');
const BYTES_HASH = createHash('sha256').update(BYTES).digest('hex');

function harness(options:{ ready?:boolean; mas?:boolean; bookmarks?:string[]; sourceRevision?:string; writeHash?:string } = {}) {
  const handlers = new Map<string, (...args:any[]) => any>();
  const watcher = {
    prepareNativeSourceSession: vi.fn(async() => undefined),
    ingestNativeSource:         vi.fn(async() => ({ id: FILE_ID, current_version_id: VERSION_ID, path: 'linked.txt' })),
    listNativeSources:          vi.fn(async() => [{ fileId: FILE_ID, name: 'linked.txt', state: 'linked', handle: HANDLE, versionId: VERSION_ID, path: '/Users/me/secret/linked.txt', sourceRevision: REVISION, sourceHash: 'h' }]),
    planNativePublication:      vi.fn(async() => undefined),
    finishNativePublication:    vi.fn(async() => undefined),
  };
  const gateway = {
    registerExactFile: vi.fn(async() => HANDLE),
    read:              vi.fn(async() => ({ revision: options.sourceRevision ?? REVISION, contentHash: 'before-hash', bytes: Buffer.from('x') })),
    write:             vi.fn(async() => ({ revision: 'b'.repeat(64), contentHash: options.writeHash ?? BYTES_HASH })),
    revoke:            vi.fn(),
  };
  const client = { stream: vi.fn(async() => new Response(BYTES, { status: 200 })) };
  const desktop = {
    ownerWindow:                          vi.fn(() => undefined),
    showOpenDialog:                       vi.fn(async() => ({ canceled: false, filePaths: ['/Users/me/linked.txt'], bookmarks: options.bookmarks })),
    startAccessingSecurityScopedResource: vi.fn(() => () => undefined),
  };
  const mountManager = { status: () => ({ ready: options.ready ?? true }) };
  new SullaFilesIpcNativeSourceHandlers(new SullaFilesIpcApi(client as any), { watcher: () => watcher as any, sourceGateway: () => gateway as any }, mountManager, desktop as any, () => ({ platform: 'darwin', mas: options.mas }))
    .register({ handle: (channel, listener) => { handlers.set(channel, listener) } });
  const call = async(channel:string, input?:unknown) => handlers.get(channel)!({ sender: {} }, input);

  return { call, watcher, gateway, client, desktop };
}

describe('SullaFilesIpcNativeSourceHandlers', () => {
  it('never exposes host paths, handles or revisions when listing native sources', async() => {
    // risk: privacy — absolute host paths and capability handles must stay in main.
    const { call } = harness();
    await expect(call('files-experiment:list-native-sources')).resolves.toEqual([{ fileId: FILE_ID, name: 'linked.txt', state: 'linked' }]);
  });

  it('lists nothing and refuses revocation while the native runtime is not ready', async() => {
    // risk: behaviour — native operations must not run before the mount is ready.
    const { call, gateway } = harness({ ready: false });
    await expect(call('files-experiment:list-native-sources')).resolves.toEqual([]);
    await expect(call('files-experiment:revoke-native-source', HANDLE)).rejects.toThrow('Native Files source handle is invalid');
    await expect(call('files-experiment:pick-native-source')).rejects.toThrow('Native Files runtime is not ready');
    expect(gateway.revoke).not.toHaveBeenCalled();
  });

  it('rejects malformed handles and publication input before any I/O', async() => {
    // risk: input validation — crafted handles or ids must not reach the gateway or Files.
    const { call, gateway, client } = harness();
    await expect(call('files-experiment:revoke-native-source', 'short')).rejects.toThrow('Native Files source handle is invalid');
    await expect(call('files-experiment:publish-native-source', { handle: HANDLE, sourceRevision: REVISION, fileId: 'not-a-uuid', versionId: VERSION_ID })).rejects.toThrow('Native Files publication input is invalid');
    expect(gateway.revoke).not.toHaveBeenCalled();
    expect(client.stream).not.toHaveBeenCalled();
  });

  it('requires the security-scoped grant in the Mac App Store build', async() => {
    // risk: sandbox safety — MAS builds must never read a file without its security-scoped bookmark.
    const { call, gateway } = harness({ mas: true, bookmarks: [] });
    await expect(call('files-experiment:pick-native-source')).rejects.toThrow('The Mac App Store build did not return the required security-scoped file grant');
    expect(gateway.registerExactFile).not.toHaveBeenCalled();
  });

  it('revokes the new handle when linking fails', async() => {
    // risk: resource leak — a failed ingest must not leave a live gateway handle behind.
    const { call, watcher, gateway } = harness();
    watcher.ingestNativeSource.mockRejectedValueOnce(new Error('ingest failed'));
    await expect(call('files-experiment:pick-native-source')).rejects.toThrow('ingest failed');
    expect(gateway.revoke).toHaveBeenCalledWith(HANDLE);
  });

  it('publishes the exact Files bytes back to the source and records the outcome', async() => {
    // risk: irreversible side effect — the host file is overwritten only with the verified version bytes.
    const { call, gateway, watcher } = harness();
    const result = await call('files-experiment:publish-native-source', { handle: HANDLE, sourceRevision: REVISION, fileId: FILE_ID, versionId: VERSION_ID });
    expect(gateway.write).toHaveBeenCalledWith(HANDLE, REVISION, BYTES);
    expect(result).toMatchObject({ sourceRevision: 'b'.repeat(64), contentHash: BYTES_HASH });
    expect(watcher.finishNativePublication).toHaveBeenCalledWith(result.operationId, expect.objectContaining({ originalSourceHash: 'before-hash', currentSourceHash: BYTES_HASH, filesBaseVersionId: VERSION_ID }));
  });

  it('does not write when the host source changed, and records the failure', async() => {
    // risk: data loss — publishing over a host file edited since planning would destroy the user's edit.
    const { call, gateway, watcher } = harness({ sourceRevision: 'c'.repeat(64) });
    await expect(call('files-experiment:publish-native-source', { handle: HANDLE, sourceRevision: REVISION, fileId: FILE_ID, versionId: VERSION_ID })).rejects.toThrow('Native source changed before publication');
    expect(gateway.write).not.toHaveBeenCalled();
    expect(watcher.finishNativePublication).toHaveBeenCalledWith(expect.any(String), { error: 'Native source changed before publication' });
  });
});
