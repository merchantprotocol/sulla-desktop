// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  const previewSession = {
    protocol: { isProtocolHandled: vi.fn(() => false), handle: vi.fn() },
    webRequest: { onBeforeRequest: vi.fn() },
    on: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn(),
    resolveHost: vi.fn(async() => ({ endpoints: [] })),
  };
  return {
    app: { on: vi.fn() },
    previewSession,
    fromPartition: vi.fn(() => previewSession),
  };
});
vi.mock('electron', () => ({ default: { app: electronMocks.app, session: { fromPartition: electronMocks.fromPartition } } }));
vi.mock('@pkg/window', () => ({ openUrlInApp: vi.fn() }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: { warn: vi.fn(), error: vi.fn(), log: vi.fn() } } }));
vi.mock('./sullaFilesWatcher', () => ({ getSullaFilesWatcher: vi.fn() }));
vi.mock('@pkg/agent/services/IntegrationService', () => ({ getIntegrationService: vi.fn() }));

import { SullaFilesIpcProvider, type SullaFilesIpcProviderDependencies } from './SullaFilesIpcProvider';

// The proxied channels registered by the current Files IPC provider.
const PROXIED_CHANNELS = [
  'files-ui:watch',
  'sulla-files:folders',
  'sulla-files:operation-capabilities',
  'sulla-files:folder-operation-state',
  'sulla-files:operation-submit',
  'sulla-files:operation-status',
  'sulla-files:operation-cancel',
  'sulla-files:operation-retry',
  'sulla-files:operation-undo',
  'files-ui:native-runtime',
  'sulla-files:collections',
  'sulla-files:list',
  'sulla-files:list-page',
  'sulla-files:recent',
  'sulla-files:stats',
  'sulla-files:folder-summary',
  'sulla-files:create-empty-file',
  'sulla-files:search',
  'sulla-files:reindex',
  'sulla-files:stars',
  'sulla-files:set-star',
  'sulla-files:operate',
  'sulla-files:metadata',
  'sulla-files:history',
  'sulla-files:preview',
  'sulla-files:preview-read',
  'sulla-files:preview-read-cancel',
  'sulla-files:save-content',
  'sulla-files:upload',
  'sulla-files:trash',
  'sulla-files:trash-list',
  'sulla-files:trash-restore',
  'sulla-files:trash-purge',
  'sulla-files:restore-version',
  'sulla-files:lifecycle',
  'sulla-files:checkout',
  'sulla-files:checkin',
  'sulla-files:publish',
  'sulla-files:retention',
  'sulla-files:record-lock',
  'sulla-files:record-unlock',
  'sulla-files:disposal-review',
  'sulla-files:shares',
  'sulla-files:share',
  'sulla-files:unshare',
  'sulla-files:file-shares',
  'sulla-files:share-file',
  'sulla-files:update-file-share',
  'sulla-files:unshare-file',
  'sulla-files:members',
  'sulla-files:keep',
  'sulla-files:keep-conflict-copies',
  'files-ui:capabilities',
  'files-ui:residency-status',
  'files-ui:set-residency',
  'files-ui:recent-references',
  'files-ui:pick-reference',
  'files-ui:chat-inventory',
  'files-ui:reference-content',
  'files-ui:capture-screenshot',
  'files-ui:toggle-recording',
  'files-ui:create-link',
  'files-ui:create-org-collection',
  'files-ui:list-links',
  'files-ui:revoke-link',
  'files-ui:update-link',
  'files-ui:set-link-keep',
  'files-ui:restore-link',
  'files-ui:link-activity',
  'files-ui:status',
  'files-preferences:list-roots',
  'files-preferences:add-root',
  'files-preferences:update-root',
  'files-preferences:remove-root',
  'files-preferences:file-provider-status',
  'files-preferences:set-file-provider',
  'files-ui:list-roots',
  'files-ui:add-root',
  'files-ui:remove-root',
  'files-backups:list',
  'files-backups:add',
  'files-backups:remove',
  'files-backups:run',
  'files-storage-cleanup:inventory',
  'files-storage-cleanup:prepared-plan',
  'files-storage-cleanup:plan',
  'files-storage-cleanup:confirm',
  'files-ui:set-paused',
  'files-ui:open-folder',
  'files-ui:create-folder',
  'files-ui:update-folder-description',
  'files-ui:cloud-backup-status',
  'files-ui:set-cloud-backup',
  'files-ui:delete-cloud-backup',
  'files-ui:cloud-collections',
  'files-ui:restore-cloud-collection',
  'files-ui:restore-all-cloud-collections',
  'files-ui:set-collection-cloud-sync',
  'files-ui:delete-folder',
  'files-ui:open-file',
  'files-ui:open-default',
  'files-ui:open-with',
  'files-ui:recent-apps',
  'files-ui:reveal-file',
  'files-ui:download-file',
  'files-ui:download-files',
  'files-ui:media-url',
  'files-ui:pick-upload',
  'files-ui:pick-upload-references',
  'files-experiment:pick-native-source',
  'files-experiment:list-native-sources',
  'files-experiment:recover-native-source',
  'files-experiment:revoke-native-source',
  'files-experiment:publish-native-source',
  'files-ui:upload-paths',
  'files-ui:import-path-references',
  'files:preview:open',
  'files:preview:revoke',
];
const LIVE_CHANNELS = ['sulla-files:live-join', 'sulla-files:live-start', 'sulla-files:live-sync', 'sulla-files:live-leave'];

class FakeRegistrar {
  readonly handlers = new Map<string, (...args:any[]) => unknown>();
  handle(channel:string, listener:(...args:any[]) => unknown):void {
    if (this.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${ channel }'`);
    this.handlers.set(channel, listener);
  }
}

function harness() {
  const ipc = new FakeRegistrar();
  const rawIpc = new FakeRegistrar();
  const mountManager = Object.assign(new EventEmitter(), { status: vi.fn(() => ({ ready: true })) });
  const fileProvider = { start: vi.fn(async() => undefined), stop: vi.fn(async() => undefined), status: vi.fn(), setEnabled: vi.fn() };
  const desktop = {
    ownerWindow: vi.fn(), showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn(),
    startAccessingSecurityScopedResource: vi.fn(), userDataPath: vi.fn(() => '/tmp'), broadcast: vi.fn(), onceWillQuit: vi.fn(),
    showMessageBox: vi.fn(),
  };
  const protocol = { isProtocolHandled: vi.fn(() => false), handle: vi.fn() };
  const registerUseCaseSuggestions = vi.fn();
  const logger = { warn: vi.fn(), error: vi.fn() };
  const deps = {
    ipc, rawIpc, protocol, desktop, logger, registerUseCaseSuggestions,
    client:   { json: vi.fn(), request: vi.fn(), stream: vi.fn(), backupJson: vi.fn(), folderOperationState: vi.fn() },
    services: {
      watcher: vi.fn(() => ({ id: 'watcher' })), rootRegistry: vi.fn(), isProtectedTrackedPath: vi.fn(), linkService: vi.fn(), capture: vi.fn(),
      sourceGateway: vi.fn(), fileProvider: () => fileProvider, mountManager: () => mountManager, backups: vi.fn(), cloudSync: vi.fn(),
      storageCleanup: vi.fn(),
    },
    chatImport: { importChatFiles: vi.fn(), pickAndImportChatFiles: vi.fn() },
    cachePath:  () => '/tmp',
  } as unknown as SullaFilesIpcProviderDependencies;

  return { deps, ipc, rawIpc, mountManager, fileProvider, desktop, protocol, registerUseCaseSuggestions, logger };
}

describe('SullaFilesIpcProvider', () => {
  it('registers exactly the channels the procedural initializer registered, live ones on raw ipcMain', () => {
    // risk: a channel dropped or renamed in the split breaks a Files UI feature with "No handler registered".
    const { deps, ipc, rawIpc } = harness();
    new SullaFilesIpcProvider(deps).register();
    expect([...ipc.handlers.keys()].sort()).toEqual([...PROXIED_CHANNELS].sort());
    expect([...rawIpc.handlers.keys()].sort()).toEqual([...LIVE_CHANNELS].sort());
  });

  it('registers the Files capability protocol and policy in the isolated HTML preview session', () => {
    // risk: relative asset isolation — the dedicated guest session must serve only the same scoped Files capability URLs.
    const { deps, protocol } = harness();
    new SullaFilesIpcProvider(deps).register();

    expect(electronMocks.fromPartition).toHaveBeenCalledWith('sulla-inline-html-preview', { cache: false });
    expect(electronMocks.previewSession.protocol.handle).toHaveBeenCalledWith('sulla-files-preview', expect.any(Function));
    expect(electronMocks.previewSession.webRequest.onBeforeRequest).toHaveBeenCalledWith({ urls: ['<all_urls>'] }, expect.any(Function));
    expect(electronMocks.previewSession.setPermissionRequestHandler).toHaveBeenCalledWith(expect.any(Function));
    expect(electronMocks.previewSession.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp');
    expect(protocol.handle).toHaveBeenCalledWith('sulla-files-preview', expect.any(Function));
  });

  it('starts the File Provider, stops it on quit, and wires use-case suggestions to the watcher', () => {
    // risk: lifecycle regression leaves the macOS File Provider running after quit or never started.
    const { deps, fileProvider, desktop, registerUseCaseSuggestions } = harness();
    new SullaFilesIpcProvider(deps).register();
    expect(fileProvider.start).toHaveBeenCalledTimes(1);
    expect(registerUseCaseSuggestions).toHaveBeenCalledWith({ id: 'watcher' });
    expect(fileProvider.stop).not.toHaveBeenCalled();
    desktop.onceWillQuit.mock.calls[0][0]();
    expect(fileProvider.stop).toHaveBeenCalledTimes(1);
  });

  it('logs a media protocol failure and still registers every channel', () => {
    // risk: a protocol registration failure must not take down the whole Files IPC surface.
    const { deps, ipc, protocol, logger } = harness();
    const failure = new Error('protocol busy');
    protocol.isProtocolHandled.mockImplementation(() => { throw failure });
    new SullaFilesIpcProvider(deps).register();
    expect(logger.error).toHaveBeenCalledWith('Files media protocol failed to initialize:', failure);
    expect(ipc.handlers.size).toBe(PROXIED_CHANNELS.length);
  });

  it('broadcasts native runtime changes to every renderer and serves the current status', async() => {
    // risk: renderers miss mount readiness changes and keep showing a stale native runtime state.
    const { deps, ipc, mountManager, desktop } = harness();
    new SullaFilesIpcProvider(deps).register();
    mountManager.emit('changed', { ready: false });
    expect(desktop.broadcast).toHaveBeenCalledWith('files-ui:native-runtime-changed', { ready: false });
    expect(await ipc.handlers.get('files-ui:native-runtime')!({})).toEqual({ ready: true });
  });

  it('refuses a second registration like Electron did before (no silent double init)', () => {
    // risk: behaviour drift — the split must not add or remove an idempotency guard.
    const { deps } = harness();
    const provider = new SullaFilesIpcProvider(deps);
    provider.register();
    expect(() => provider.register()).toThrow(/second handler/);
  });
});
