// SPDX-License-Identifier: GPL-2.0-or-later
import { BrowserWindow } from 'electron';
import { SecurityCheckService } from '@pkg/main/security/SecurityCheckService';
import type { MainProcessIpcContext, MainProcessIpcStep } from './MainProcessIpcContext';

export class SecurityIpc implements MainProcessIpcStep {
  readonly name = 'security';
  async register(ctx: MainProcessIpcContext): Promise<void> {
    const service = new SecurityCheckService(result => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('security:check-progress', result);
    });
    ctx.ipc.handle('security:run-check', () => service.runChecks());
    ctx.ipc.handle('security:summary', () => service.summary());
    ctx.ipc.handle('security:lock-vault', async() => {
      try {
        const { getSullaFilesWatcher } = await import('@pkg/main/sullaFilesWatcher');
        const filesLock = getSullaFilesWatcher().lockService();
        const { getDesktopVaultClient } = await import('@pkg/agent/services/DesktopVaultClient');
        await getDesktopVaultClient().lock();
        await ctx.vaultState.publish(false);
        ctx.tabs().setFocusedTab(null);
        await filesLock;
        return { ok: true };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    });
  }
}
