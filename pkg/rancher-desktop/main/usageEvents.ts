import { getUsageSummary } from '@pkg/agent/usage/providerUsage';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const ipcMainProxy = getIpcMainProxy(Logging.background);

export function initUsageEvents(): void {
  ipcMainProxy.handle('usage:summary', async(_event: unknown, options?: { hours?: number; profileId?: string }) => {
    return getUsageSummary(options?.hours, options?.profileId);
  });
}
