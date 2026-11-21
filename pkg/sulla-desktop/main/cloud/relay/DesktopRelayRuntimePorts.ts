// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ApprovedClients } from '../approvedClients';
import { getCloudPreferences } from '../cloudSettings';
import { signDeviceMessageExact } from '../deviceKey';

import path from 'node:path';

import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getWebSocketClientService } from '@pkg/agent/services/WebSocketClientService';
import { resolveSullaHomeDir } from '@pkg/agent/utils/sullaPaths';
import { validateChatSelection } from '@pkg/main/chatSelection';
import { cloudRelayUsesVault, VaultRelaySocket } from '@pkg/main/cloudRelayTransport';
import { getDesktopDeviceId } from '@pkg/main/deviceIdentity';
import { persistMobileAttachments } from '@pkg/main/mobileRelayContent';
import { acquireRelayLiveness, releaseRelayLiveness } from '@pkg/main/SleepPreventionService';
import { getCurrentAccessToken, getCurrentUserId } from '@pkg/main/sullaCloudAuth';
import { desktopFilesFetch, FILES_HTTPS_ORIGIN } from '@pkg/main/sullaFilesTls';
import { acceptRelayUserTurn, admitRelayThread, deriveMessageId, scribeRelayTurn } from '@pkg/main/sync/syncMirror';
import Logging from '@pkg/utils/logging';

import type { DesktopRelayLog, DesktopRelayPortSet, DesktopRelaySignInNotifier, DesktopRelayTimers } from './DesktopRelayPorts';
import { DesktopRelayTerminalRepository } from './DesktopRelayTerminalRepository';

/** Surfaces another device's sign-in approval code as a notification and a renderer event. */
class ElectronSignInNotifier implements DesktopRelaySignInNotifier {
  constructor(private readonly log: DesktopRelayLog) {}

  surface(payload: Parameters<DesktopRelaySignInNotifier['surface']>[0]): void {
    try {
      const { BrowserWindow, Notification } = require('electron') as typeof import('electron');
      if (Notification.isSupported()) new Notification({ title: 'Approve a Sulla sign-in', body: `Someone is signing in on ${ payload.requestingDeviceName }. Open Sulla to see the code.` }).show();
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('sulla-cloud:other-device-signin-code', payload);
      }
    } catch (err) { this.log.warn('[DesktopRelay] Could not surface sign-in approval:', err) }
  }
}

/** Real clock and timers; each call reads the global so test fake timers apply. */
class GlobalRelayTimers implements DesktopRelayTimers {
  now(): number { return Date.now() }
  setTimeout(callback: () => void, delayMs: number) { return setTimeout(callback, delayMs) }
  clearTimeout(timer: ReturnType<typeof setTimeout>): void { clearTimeout(timer) }
  setInterval(callback: () => void, delayMs: number) { return setInterval(callback, delayMs) }
  clearInterval(timer: ReturnType<typeof setInterval>): void { clearInterval(timer) }
}

/**
 * Production wiring for the desktop relay: settings, Sulla Cloud session,
 * device identity, vault relay sockets, the local agent channel, the sync
 * log and Sulla Files. Every port reads its module at call time, never at
 * construction, so import order between these modules does not matter.
 */
export class DesktopRelayRuntimePorts {
  create(): DesktopRelayPortSet {
    const log: DesktopRelayLog = Logging.background;
    return {
      log,
      timers:  new GlobalRelayTimers(),
      sockets: {
        usesVault:  () => cloudRelayUsesVault(),
        openVault:  (room, deviceId) => new VaultRelaySocket(room, deviceId),
        openNative: url => new WebSocket(url),
        vaultView:  socket => socket instanceof VaultRelaySocket ? socket : null,
      },
      session: {
        sharedRelayEnabled: () => process.env.SULLA_SHARED_LIVE_RELAY === 'on',
        proveRelayDevice: (room, deviceId, nonce) => signDeviceMessageExact('shared-live-relay-v1', [room, 'desktop', deviceId, nonce]),
        accessToken:     () => getCurrentAccessToken(),
        deviceId:        () => getDesktopDeviceId(),
        acquireLiveness: holder => acquireRelayLiveness(holder),
        releaseLiveness: holder => releaseRelayLiveness(holder),
      },
      pairing: {
        read:  async() => (await SullaSettingsModel.get('pairedMobileUserId', '')) ?? '',
        ready: () => SullaSettingsModel.ready,
        save:  async(userId) => { await SullaSettingsModel.set('pairedMobileUserId', userId, 'string') },
      },
      agent:   () => getWebSocketClientService(),
      history: {
        scribe:          turn => scribeRelayTurn(turn),
        acceptUserTurn:  turn => acceptRelayUserTurn(turn),
        deriveMessageId: (conversationId, role, content, ts) => deriveMessageId(conversationId, role, content, ts),
      },
      terminal: new DesktopRelayTerminalRepository(postgresClient),
      chat: {
        currentRelayAccount: getCurrentUserId,
        allowScopedHistory: async() => {
          const prefs = await getCloudPreferences();
          return prefs.enabled && prefs.conversations && prefs.remoteAccess;
        },
        approveViewer: async(id, key) => (await getCloudPreferences()).remoteAccess && ApprovedClients.get(id)?.publicKey === key,
        hasScopedReceipt: async(thread, message, scope) => {
          const receipt = await postgresClient.queryWithResult(
            `SELECT m.id FROM claude_messages m JOIN claude_conversations c ON c.id = m.conversation_id AND c.contractor_id = m.contractor_id
              WHERE m.id = $1 AND c.id = $2 AND c.contractor_id = $3 AND c.relay_workspace_id = $4 AND c.relay_host_device_id = $5
                AND m.role = 'user' AND m.status = 'sent' AND m.routed_to = 'desktop' AND m.deleted_at IS NULL AND c.deleted_at IS NULL`,
            [message, thread, scope.accountId, scope.workspaceId, scope.hostDeviceId],
          );
          return receipt.rows.length === 1;
        },
        modelCapabilities: async() => {
          const { getModelProviderService } = await import('@pkg/agent/services/ModelProviderService');
          const service = getModelProviderService();
          const providers = (await service.getAvailableProviders()).filter(provider => provider.connected);
          const models = await Promise.all(providers.map(async provider =>
            (await service.getModelsForProvider(provider.id).catch(() => [])).map(model => ({ providerId: provider.id, modelId: model.id }))));
          return models.flat().slice(0, 256);
        },
        relayApprovals: () => ApprovedClients.list().map(client => [client.clientId, client.publicKey] as const),
        admitRelayThread,
        validateSelection:  message => validateChatSelection(message),
        persistAttachments: (conversationId, messageId, turn) => persistMobileAttachments(path.join(resolveSullaHomeDir(), 'uploads', 'mobile'), conversationId, messageId, turn.files),
        companionRequest:   async(method, params) => (await import('@pkg/main/mobileCompanion')).mobileCompanionRequest(method, params),
        registerMobileCard: async(threadId, kind, data) => { (await import('@pkg/main/mobileCompanion')).registerMobileCard(threadId, kind, data) },
      },
      files: {
        serviceToken: () => SullaSettingsModel.getServicePassword(),
        fetch:        (url, init) => desktopFilesFetch(url, init),
        origin:       () => FILES_HTTPS_ORIGIN,
      },
      signIn: new ElectronSignInNotifier(log),
    };
  }
}
