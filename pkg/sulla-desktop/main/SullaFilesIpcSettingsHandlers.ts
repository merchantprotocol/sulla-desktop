// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SULLA_FILES_UUID as UUID } from './SullaFilesIpcSupport';

import type { SullaFilesIpcApi, SullaFilesIpcDesktop, SullaFilesIpcRegistrar, SullaFilesIpcServices } from './SullaFilesIpcSupport';

import { formatStorageMegabytes } from '@pkg/shared/storageCleanupUnits';

/** Human-only Files settings: tracked roots, File Provider, backups, pause and cloud backup. */
export class SullaFilesIpcSettingsHandlers {
  constructor(
    private readonly api:SullaFilesIpcApi,
    private readonly services:Pick<SullaFilesIpcServices, 'rootRegistry' | 'fileProvider' | 'backups' | 'watcher' | 'cloudSync' | 'storageCleanup'>,
    private readonly desktop:Pick<SullaFilesIpcDesktop, 'ownerWindow' | 'showMessageBox'>,
  ) {}

  registerRoots(ipc:SullaFilesIpcRegistrar):void {
    const roots = () => this.services.rootRegistry();
    ipc.handle('files-preferences:list-roots', () => roots().list());
    ipc.handle('files-preferences:add-root', event => roots().add(this.desktop.ownerWindow(event.sender)));
    ipc.handle('files-preferences:update-root', (_event, input:{ id: string; syncMode?: 'local' | 'server'; paused?: boolean; exclusions?: string[] }) => {
      const { id, ...updates } = input;
      return roots().update(id, updates);
    });
    ipc.handle('files-preferences:remove-root', (_event, id:string) => roots().remove(id));
    // Renderer IPC is the human's surface; agents have no path to this switch.
    ipc.handle('files-preferences:file-provider-status', () => this.services.fileProvider().status());
    ipc.handle('files-preferences:set-file-provider', (_event, input:{ enabled:boolean }) => this.services.fileProvider().setEnabled(input?.enabled === true, { kind: 'human' }));
    // File Manager uses the files-ui namespace; keep the preferences aliases for
    // the standalone Preferences window and existing integrations.
    ipc.handle('files-ui:list-roots', () => roots().list());
    ipc.handle('files-ui:add-root', event => roots().add(this.desktop.ownerWindow(event.sender)));
    ipc.handle('files-ui:remove-root', (_event, id:string) => roots().remove(id));
  }

  registerBackups(ipc:SullaFilesIpcRegistrar):void {
    const client = this.api.client;
    ipc.handle('files-backups:list', () => client.backupJson('/v1/local/backups'));
    ipc.handle('files-backups:add', (_event, input:{ kind:'local'|'nas'|'s3'; label:string; config:Record<string, unknown> }) => client.backupJson('/v1/local/backups/destinations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }));
    ipc.handle('files-backups:remove', (_event, id:string) => this.services.backups().remove(id));
    ipc.handle('files-backups:run', (_event, id:string) => client.backupJson(`/v1/local/backups/${ encodeURIComponent(id) }/run`, { method: 'POST' }));
    ipc.handle('files-ui:set-paused', (_event, paused:boolean) => this.services.watcher().setPaused(paused));
  }

  registerCloudBackup(ipc:SullaFilesIpcRegistrar):void {
    const sync = () => this.services.cloudSync();
    ipc.handle('files-ui:cloud-backup-status', () => sync().status());
    ipc.handle('files-ui:set-cloud-backup', async(_event, input:{ collectionId:string; enabled:boolean }) => {
      if (!UUID.test(input.collectionId)) throw new Error('Choose a valid Files collection');
      return sync().setEnabled(input.collectionId, input.enabled === true, { kind: 'human' });
    });
    ipc.handle('files-ui:delete-cloud-backup', async(_event, input:{ collectionId:string }) => {
      if (!UUID.test(input.collectionId)) throw new Error('Choose a valid Files collection');
      return sync().deleteCloudCopy(input.collectionId, { kind: 'human' });
    });
    ipc.handle('files-ui:cloud-collections', () => sync().cloudCollections({ kind: 'human' }));
    ipc.handle('files-ui:restore-cloud-collection', (_event, input:{ collectionId:string; name:string }) => sync().restore(input.collectionId, input.name, { kind: 'human' }));
    ipc.handle('files-ui:restore-all-cloud-collections', () => sync().restoreAll({ kind: 'human' }));
    ipc.handle('files-ui:set-collection-cloud-sync', async(_event, input:{ collectionId:string; enabled:boolean }) => {
      if (!UUID.test(input.collectionId)) throw new Error('Choose a valid Files collection');
      await this.api.json(`/v1/collections/${ encodeURIComponent(input.collectionId) }/cloud-sync`, { method: 'PATCH', body: JSON.stringify({ enabled: input.enabled === true }) });
    });
  }

  registerStorageCleanup(ipc:SullaFilesIpcRegistrar):void {
    const cleanup = () => this.services.storageCleanup();
    ipc.handle('files-storage-cleanup:inventory', () => cleanup().inventory());
    ipc.handle('files-storage-cleanup:prepared-plan', () => cleanup().takePreparedPreview());
    ipc.handle('files-storage-cleanup:plan', (_event, input:{ targetIds:string[] }) => cleanup().plan({ targetIds: input?.targetIds ?? [] }));
    ipc.handle('files-storage-cleanup:confirm', async(event, input:{ planId:string }) => {
      const plan = cleanup().review(input?.planId ?? '');
      const selected = plan.targets.map(target => `${ target.displayName }\n${ target.path }`);
      const retained = plan.blocked.map(target => `${ target.displayName } · retained\n${ target.path ? `${ target.path }\n` : '' }${ target.reason }`);
      const result = await this.desktop.showMessageBox(this.desktop.ownerWindow(event.sender), {
        type:      'warning',
        title:     'Remove selected code workspaces?',
        message:   `Remove ${ plan.targets.length } verified workspace${ plan.targets.length === 1 ? '' : 's' } from the Sulla VM?`,
        detail:    [
          `Estimated guest recovery: ${ formatStorageMegabytes(plan.estimatedRecoverableBytes) }.`,
          ...selected,
          ...retained,
          'Chat history, provider sessions, conversation workspace containers, and protected work are retained. Host disk recovery may occur later after VM trim or compaction.',
        ].join('\n\n'),
        buttons:   ['Remove workspaces', 'Cancel'],
        defaultId: 1,
        cancelId:  1,
        noLink:    true,
      });
      return result.response === 0 ? cleanup().execute(plan.id) : cleanup().cancel(plan.id);
    });
  }
}
