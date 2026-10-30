// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BrowserWindow, dialog } from 'electron';

import { getConfiguredApprovalClient } from '@pkg/vault-broker';

interface ApprovalRequest { id: string; vaultId: string; vaultEpoch: number; publicKey: string; expiresAt: string }

class VaultDeviceApprovalService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private readonly seen = new Set<string>();

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll().catch(() => undefined) }, 15_000);
    this.timer.unref?.();
    void this.poll().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.seen.clear();
  }

  private async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const client = getConfiguredApprovalClient();
      if (!client) return;
      const response = await client.sullaCloudRequest({ method: 'GET', path: '/auth/password/device-approval/requests', responseType: 'json' });
      if (response.status !== 200) return;
      const body = response.body as { requests?: ApprovalRequest[] };
      for (const request of body.requests ?? []) {
        if (this.seen.has(request.id)) continue;
        this.seen.add(request.id);
        if (!await this.prompt()) continue; // No relay response of any kind without the tap.
        const wrapped = await client.wrapUserKeyForApprovedDevice({ ...request, requestId: request.id, approved: true });
        await client.sullaCloudRequest({
          method: 'POST', path: `/auth/password/device-approval/requests/${ encodeURIComponent(request.id) }/respond`,
          body: { wrappedUserKey: wrapped.wrappedUserKey }, responseType: 'json',
        });
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async prompt(): Promise<boolean> {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = {
      type: 'question' as const,
      buttons: ['Don\'t approve', 'Approve'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Vault access request',
      message: 'Approve vault access for this browser/device?',
      detail: 'Only approve if you just reset your Sulla password on that device.',
    };
    const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    return result.response === 1;
  }
}

export const VaultDeviceApproval = new VaultDeviceApprovalService();
