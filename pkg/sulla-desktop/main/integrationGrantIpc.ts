// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ipcMain } from 'electron';
import { setIntegrationGrant } from '../agent/integrations/packageLoader';

export function initIntegrationGrantIpc(): void {
  ipcMain.handle('integration-grants:grant', async(_event, input: { id: string; version: string; permissions: string[] }) => {
    await setIntegrationGrant(input.id, input.version, input.permissions, true);
    const { refreshIntegrationCatalog } = await import('../agent/integrations/catalog');
    await refreshIntegrationCatalog();
  });
  ipcMain.handle('integration-grants:revoke', async(_event, input: { id: string; version: string }) => {
    await setIntegrationGrant(input.id, input.version, [], false);
    const { refreshIntegrationCatalog } = await import('../agent/integrations/catalog');
    await refreshIntegrationCatalog();
  });
}
