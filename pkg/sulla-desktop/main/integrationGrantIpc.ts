// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { setIntegrationGrant } from '../agent/integrations/packageLoader';

import type { IpcController, IpcRegistrar } from './ipc/IpcController';

export interface IntegrationGrantStore {
  setGrant(id: string, version: string, permissions: string[], granted: boolean): Promise<unknown>;
  refreshCatalog(): Promise<unknown>;
}

/** Default store: package grants in settings, then a catalog refresh. */
export class IntegrationGrantPackageStore implements IntegrationGrantStore {
  setGrant(id: string, version: string, permissions: string[], granted: boolean): Promise<unknown> {
    return setIntegrationGrant(id, version, permissions, granted);
  }

  async refreshCatalog(): Promise<unknown> {
    const { refreshIntegrationCatalog } = await import('../agent/integrations/catalog');

    return refreshIntegrationCatalog();
  }
}

/** integration-grants:* — grant or revoke an integration package's permissions. */
export class IntegrationGrantIpcController implements IpcController {
  constructor(private readonly ipc: IpcRegistrar, private readonly store: IntegrationGrantStore) {}

  register(): void {
    this.ipc.handle('integration-grants:grant', async(_event, input: { id: string; version: string; permissions: string[] }) => {
      await this.store.setGrant(input.id, input.version, input.permissions, true);
      await this.store.refreshCatalog();
    });
    this.ipc.handle('integration-grants:revoke', async(_event, input: { id: string; version: string }) => {
      await this.store.setGrant(input.id, input.version, [], false);
      await this.store.refreshCatalog();
    });
  }
}
