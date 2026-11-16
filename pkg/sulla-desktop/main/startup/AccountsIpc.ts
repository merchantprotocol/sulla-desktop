// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { shell } from 'electron';

import type { MainProcessIpcContext, MainProcessIpcStep } from './MainProcessIpcContext';
import { VaultIpcInputPolicy } from './VaultIpcInputPolicy';

/** Local Accounts broker IPC for the trusted main window. */
export class AccountsIpc implements MainProcessIpcStep {
  readonly name = 'accounts';

  async register(ctx: MainProcessIpcContext): Promise<void> {
    const { ipc } = ctx;
    const policy = new VaultIpcInputPolicy(ctx.window);

    const accountsClient = async(event:Electron.IpcMainInvokeEvent) => {
      policy.requireTrustedAccountsRenderer(event);
      const { getSullaAccountsClient } = await import('@pkg/main/sullaAccountsClient');
      return getSullaAccountsClient();
    };

    ipc.handle('accounts:profile', async(event:Electron.IpcMainInvokeEvent) =>
      (await accountsClient(event)).getProfile());
    ipc.handle('accounts:update-profile', async(event:Electron.IpcMainInvokeEvent, input:{ displayName: string }) =>
      (await accountsClient(event)).updateProfile(input?.displayName));
    ipc.handle('accounts:connections', async(event:Electron.IpcMainInvokeEvent) =>
      (await accountsClient(event)).listConnections());
    ipc.handle('accounts:create-connection', async(event:Electron.IpcMainInvokeEvent, input:import('@pkg/main/sullaAccountsClient').AccountsConnectionInput) =>
      (await accountsClient(event)).createConnection(input));
    ipc.handle('accounts:discover-authority', async(event:Electron.IpcMainInvokeEvent, baseUrl:string) =>
      (await accountsClient(event)).discoverAuthority(baseUrl));
    ipc.handle('accounts:enroll-authority', async(event:Electron.IpcMainInvokeEvent, baseUrl:string) =>
      (await accountsClient(event)).enrollAuthority(baseUrl));
    ipc.handle('accounts:remove-connection', async(event:Electron.IpcMainInvokeEvent, id:string) => {
      await (await accountsClient(event)).removeConnection(id);
    });
    ipc.handle('accounts:authorize', async(event:Electron.IpcMainInvokeEvent, input:{ id: string; resourceAudience?: string }) => {
      const launch = await (await accountsClient(event)).beginAuthorization(input?.id, input?.resourceAudience);
      await shell.openExternal(launch.authorizationUrl);
      return { opened: true, expiresAt: launch.expiresAt };
    });
    ipc.handle('accounts:memberships', async(event:Electron.IpcMainInvokeEvent) =>
      (await accountsClient(event)).listMemberships());
  }
}
