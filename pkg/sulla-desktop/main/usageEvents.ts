// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getUsageSummary } from '@pkg/agent/usage/providerUsage';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const ipcMainProxy = getIpcMainProxy(Logging.background);

export function initUsageEvents(): void {
  ipcMainProxy.handle('usage:summary', async(_event: unknown, options?: { hours?: number; profileId?: string }) => {
    let profileId = options?.profileId?.trim();
    if (!profileId) {
      try {
        const { getActiveContractorId } = await import('./sullaCloudAuth');
        profileId = (await getActiveContractorId()).trim();
      } catch { /* local/offline installs use the default profile */ }
    }
    return getUsageSummary(options?.hours, profileId || 'default');
  });
}
