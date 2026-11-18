// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { getServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';

import type { MainProcessIpcContext, MainProcessIpcStep } from './MainProcessIpcContext';
import { VaultIpcInputPolicy } from './VaultIpcInputPolicy';
import { VaultStatusMonitor } from './VaultStatusMonitor';
import { agentWindowFromSender } from '@pkg/window/agentWindowTrust';

/** Vault status polling, metadata-only integration bridges and the isolated vault view. */
export class VaultViewIpc implements MainProcessIpcStep {
  readonly name = 'vault-view';

  async register(ctx: MainProcessIpcContext): Promise<void> {
    const { ipc, window, vaultViewManager } = ctx;
    const tabViewManager = ctx.tabs();
    const policy = new VaultIpcInputPolicy(window);

    // ── Vault: key management IPC handlers (main-process only — safeStorage) ──
    const { getVaultKeyService } = await import('@pkg/agent/services/VaultKeyService');
    const vaultKey = getVaultKeyService();

    ctx.vaultKey = vaultKey;
    const vaultStatus = new VaultStatusMonitor({
      client: async() => {
        const { getDesktopVaultClient } = await import('@pkg/agent/services/DesktopVaultClient');

        return getDesktopVaultClient();
      },
      lifecycleVaultUnlocked: () => getServiceLifecycleManager().isVaultUnlocked(),
      refreshMasterCache:     () => vaultKey.refreshMasterCache(),
      publish:                unlocked => ctx.vaultState.publish(unlocked),
      hasActiveVaultView:     () => vaultViewManager.hasActiveOwner(),
    });

    ctx.vaultStatus = vaultStatus;

    ipc.handle('vault:status', () => vaultStatus.refresh());

    // Narrow metadata-only bridge for renderer integration settings. The broker
    // response is pre-sanitized by the vault and contains no credential fields.
    ipc.handle('vault:integration-metadata', async(
      event: Electron.IpcMainInvokeEvent,
      input: { integrationId: string; accountId?: string },
    ) => {
      policy.requireTrustedVaultRenderer(event);
      const integrationId = policy.metadataId(input?.integrationId, 'integrationId');
      const accountId = input?.accountId === undefined ? undefined : policy.metadataId(input.accountId, 'accountId');
      const { configuredVaultBrokerProvider } = await import('@pkg/vault-broker');
      return configuredVaultBrokerProvider.requireConfiguredCredentialBroker().integrationMetadata(integrationId, accountId);
    });

    ipc.handle('vault:integration-active-account', async(
      event: Electron.IpcMainInvokeEvent,
      input: { integrationId: string; accountId: string },
    ) => {
      policy.requireTrustedVaultRenderer(event);
      const integrationId = policy.metadataId(input?.integrationId, 'integrationId');
      const accountId = policy.metadataId(input?.accountId, 'accountId');
      const { configuredVaultBrokerProvider } = await import('@pkg/vault-broker');
      return configuredVaultBrokerProvider.requireConfiguredCredentialBroker().setActiveIntegrationAccount(integrationId, accountId);
    });

    // First OAuth sign-in: the vault creates the empty account it will store
    // the tokens in. Label only crosses; tokens never leave the vault.
    ipc.handle('vault:integration-oauth-account', async(
      event: Electron.IpcMainInvokeEvent,
      input: { integrationId: string; accountId: string; label?: string },
    ) => {
      policy.requireTrustedVaultRenderer(event);
      const integrationId = policy.metadataId(input?.integrationId, 'integrationId');
      const accountId = policy.metadataId(input?.accountId, 'accountId');
      const label = typeof input?.label === 'string' ? input.label.slice(0, 120) : '';
      const { configuredVaultBrokerProvider } = await import('@pkg/vault-broker');
      const client = configuredVaultBrokerProvider.getConfiguredApprovalClient();
      if (!client) throw new Error('Desktop vault service is unavailable');
      return client.ensureOAuthAccount(integrationId, accountId, label);
    });

    ipc.handle('vault:view-open', async(
      event: Electron.IpcMainInvokeEvent,
      bounds: Electron.Rectangle,
      hint?: { integrationId?: string; accountId?: string; surface?: 'page' | 'popup'; siteUrl?: string; tabId?: string; ownerId?: string; restoreFiles?: boolean; connect?: unknown },
    ) => {
      const parentWindow = agentWindowFromSender(event.sender) ?? (window.getWindow('main-agent')?.webContents === event.sender ? window.getWindow('main-agent') : null);
      if (!parentWindow || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted vault view caller');
      const safeMetadata = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined;
      const ownerId = typeof hint?.ownerId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(hint.ownerId) ? hint.ownerId : undefined;
      if (!ownerId) throw new Error('Invalid vault view owner');
      const reservation = vaultViewManager.reserve(parentWindow, ownerId);
      try {
        await getServiceLifecycleManager().waitUntilStarted('vault');
      } catch (error) {
        if (!vaultViewManager.isCurrent(reservation)) return { state: 'cancelled' };
        vaultViewManager.hide(ownerId, parentWindow);
        throw error;
      }
      if (!vaultViewManager.isCurrent(reservation)) return { state: 'cancelled' };
      const { getDesktopVaultClient } = await import('@pkg/agent/services/DesktopVaultClient');
      if (!vaultViewManager.isCurrent(reservation)) return { state: 'cancelled' };
      const popupTabId = hint?.surface === 'popup' && typeof hint.tabId === 'string' ? hint.tabId : undefined;
      const popupOrigin = popupTabId ? tabViewManager.getTrustedMainFrameOrigin(popupTabId) ?? undefined : undefined;
      // The container can be recreated right after the lifecycle reports it started;
      // ride out that window instead of surfacing a raw connection error.
      const { retryTransientVault } = await import('@pkg/utils/vaultTransient');
      const humanSession = await retryTransientVault(
        () => getDesktopVaultClient().createHumanSession(
          popupTabId && popupOrigin ? { tabId: popupTabId, origin: popupOrigin } : undefined,
        ),
        { shouldContinue: () => vaultViewManager.isCurrent(reservation) },
      );
      if (!vaultViewManager.isCurrent(reservation)) return { state: 'cancelled' };
      const target = new URL(humanSession.url);
      const integrationId = safeMetadata(hint?.integrationId);
      const accountId = safeMetadata(hint?.accountId);
      if (integrationId) target.searchParams.set('integration', integrationId);
      if (accountId) target.searchParams.set('account', accountId);
      if (hint?.restoreFiles === true) target.searchParams.set('restoreFiles', '1');
      // Public form layout for the vault's guided "Connect" screen (labels, hints, setup notes; no values).
      const connect = integrationId && !accountId ? policy.sanitizeConnectSpec(hint?.connect) : undefined;
      if (connect) {
        const fragment = new URLSearchParams(target.hash.slice(1));
        fragment.set('connect', Buffer.from(JSON.stringify(connect)).toString('base64url'));
        target.hash = fragment.toString();
      }
      if (hint?.surface === 'popup') {
        target.pathname = '/vault/popup.html';
        if (popupOrigin) target.searchParams.set('site', new URL(popupOrigin).hostname);
      }
      const opened = await vaultViewManager.show(reservation, parentWindow, target.toString(), bounds);
      if (!opened) return { state: 'cancelled' };
      vaultStatus.startPolling();
      return { state: 'opened', expiresAt: humanSession.expiresAt };
    });

    ipc.handle('vault:view-bounds', async(event: Electron.IpcMainInvokeEvent, ownerId: string, bounds: Electron.Rectangle) => {
      const senderWindow = agentWindowFromSender(event.sender) ?? (window.getWindow('main-agent')?.webContents === event.sender ? window.getWindow('main-agent') : null);
      if (!senderWindow || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted vault view caller');
      vaultViewManager.setBounds(ownerId, bounds, senderWindow);
    });

    ipc.handle('vault:view-hide', async(event: Electron.IpcMainInvokeEvent, ownerId: string) => {
      const senderWindow = agentWindowFromSender(event.sender) ?? (window.getWindow('main-agent')?.webContents === event.sender ? window.getWindow('main-agent') : null);
      if (!senderWindow || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted vault view caller');
      vaultViewManager.hide(ownerId, senderWindow);
      vaultStatus.viewHidden();
    });
  }
}
