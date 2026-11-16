// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SullaFilesIpcUploadService } from './SullaFilesIpcUploadService';
import type { SullaFilesIpcApi, SullaFilesIpcRegistrar, SullaFilesIpcServices } from './SullaFilesIpcSupport';
import type { CreateShareInput } from './sullaFilesLinkService';

/** Org sharing (server authority), public links and the sharing capability summary. */
export class SullaFilesIpcSharingHandlers {
  constructor(
    private readonly api:SullaFilesIpcApi,
    private readonly services:Pick<SullaFilesIpcServices, 'watcher' | 'linkService'>,
    private readonly upload:Pick<SullaFilesIpcUploadService, 'cloudFilesAvailable'>,
  ) {}

  register(ipc:SullaFilesIpcRegistrar):void {
    const json = this.api.json.bind(this.api);
    ipc.handle('sulla-files:shares', (_event, input:{ collectionId:string }) => json(`/v1/collections/${ encodeURIComponent(input.collectionId) }/shares`, {}, true));
    ipc.handle('sulla-files:share', (_event, input:{ collectionId:string; folderPath:string; principalType:'user' | 'group'; principalId:string; role:'view' | 'edit' }) => json(`/v1/collections/${ encodeURIComponent(input.collectionId) }/shares`, { method: 'POST', body: JSON.stringify(input) }, true));
    ipc.handle('sulla-files:unshare', (_event, input:{ collectionId:string; folderPath:string; principalType:'user' | 'group'; principalId:string }) => json(`/v1/collections/${ encodeURIComponent(input.collectionId) }/shares`, { method: 'DELETE', body: JSON.stringify(input) }, true));
    ipc.handle('sulla-files:file-shares', (_event, input:{ fileId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/shares`, {}, true));
    ipc.handle('sulla-files:share-file', (_event, input:{ fileId:string; principalType:'user' | 'group'; principalId:string; role:'view' | 'edit' }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/shares`, { method: 'POST', body: JSON.stringify(input) }, true));
    ipc.handle('sulla-files:update-file-share', (_event, input:{ fileId:string; shareId:string; role:'view' | 'edit' }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/shares/${ encodeURIComponent(input.shareId) }`, { method: 'PATCH', body: JSON.stringify({ role: input.role }) }, true));
    ipc.handle('sulla-files:unshare-file', (_event, input:{ fileId:string; shareId:string }) => json(`/v1/files/${ encodeURIComponent(input.fileId) }/shares/${ encodeURIComponent(input.shareId) }`, { method: 'DELETE' }, true));
    ipc.handle('sulla-files:members', (_event, input:{ orgId:string }) => json(`/v1/orgs/${ encodeURIComponent(input.orgId) }/members`, {}, true));
    ipc.handle('files-ui:capabilities', () => this.capabilities());
  }

  registerLinks(ipc:SullaFilesIpcRegistrar):void {
    const links = () => this.services.linkService();
    ipc.handle('files-ui:create-link', (_event, input:CreateShareInput) => links().create(input));
    ipc.handle('files-ui:list-links', () => links().list());
    ipc.handle('files-ui:revoke-link', (_event, id:string) => links().revoke(id));
    ipc.handle('files-ui:update-link', (_event, input:{ id: string; options: Partial<CreateShareInput> }) => links().update(input.id, input.options));
    ipc.handle('files-ui:set-link-keep', (_event, input:{ id: string; enabled: boolean }) => links().update(input.id, { keepAvailable: input.enabled }));
    ipc.handle('files-ui:restore-link', (_event, input:{ id: string; password?: string }) => links().restore(input.id, input.password));
    ipc.handle('files-ui:link-activity', (_event, id?:string) => links().activity(id));
    ipc.handle('files-ui:status', () => this.services.watcher().status());
  }

  async capabilities():Promise<Record<string, unknown>> {
    const [status, cloudAvailable, residencyResult] = await Promise.all([
      this.services.watcher().status(),
      this.upload.cloudFilesAvailable(),
      this.api.json('/v1/residency-capabilities')
        .then((residency:Record<string, unknown>) => ({ residency, reason: '' }))
        .catch((error) => ({ residency: undefined, reason: error instanceof Error ? error.message : 'Online-only residency is unavailable.' })),
    ]);
    const { residency, reason: onlineOnlyReason } = residencyResult;
    const onlineOnly = residency?.onlineOnly === true && residency.keepOnComputer === true &&
      residency.authenticatedRemote === true && residency.verifiedRecovery === true;

    return {
      orgSharing:          status.serverConfigured && status.state !== 'error',
      publicLinks:         cloudAvailable && status.state !== 'error',
      onlineOnly,
      keepOnComputer:      onlineOnly,
      authenticatedRemote: onlineOnly,
      verifiedRecovery:    onlineOnly,
      onlineOnlyReason:    onlineOnly ? '' : onlineOnlyReason || 'Online-only recovery is not fully configured.',
    };
  }
}
