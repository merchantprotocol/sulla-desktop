// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Sulla Cloud lifecycle — one place that decides what runs while the owner
 * is signed in.
 *
 * Signed in ⇒ always connected:
 *   - device registration (with the Ed25519 public key) + 45s heartbeat
 *   - the secure desktop channel (cloud dashboard → this desktop)
 * Plus, only if the owner opted in (Settings → Sulla Cloud):
 *   - conversation sync (SullaSync push/pull)
 *   - vault copy uploads (zero-knowledge)
 *
 * Signed out ⇒ everything stops.
 */

import { BrowserWindow, dialog } from 'electron';

import { getDesktopRelayClient } from '../desktopRelay';
import { DevicesCloudApi } from '../devicesCloudApi';
import { DeviceInstallSync } from '../marketplace/cloudInstall/deviceInstallSync';
import { ApprovedClients } from './approvedClients';
import { getCloudPreferences, isCloudKindEnabled, onCloudPreferencesChanged, setCloudPreferences, type CloudDataKind, type CloudPreferences } from './cloudSettings';
import { CloudDataSync, type ProjectionKind } from './cloudDataSync';
import { ByoUsageSync } from './byoUsageSync';
import { VaultSyncV3 } from './vaultSyncV3';
import { FilesSyncV1 } from './filesSyncV1';
import { getDeviceKeyFingerprint } from './deviceKey';
import { SecureDesktopChannel } from './secureChannel';
import { ConversationSyncService } from './conversationSync';
import { CloudRuntimeProjectionSync, syncRuntimeProjections } from './runtimeProjection/sync';
import { dispatchCloudAgentCommand } from '@pkg/agent/tools/agents/cloudProjection';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

let channel: SecureDesktopChannel | null = null;
let signedIn = false;
let prefsListenerInstalled = false;

/**
 * Native, local-only approval. Default button is Deny; the dialog can only
 * be answered by someone sitting at this machine.
 */
async function promptPairing(req: { label: string; surface: string; code: string }): Promise<boolean> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  const what = req.surface === 'mobile' ? 'A phone' : 'A web browser';
  const opts = {
    type:      'warning' as const,
    buttons:   ['Deny', 'Allow'],
    defaultId: 0,
    cancelId:  0,
    noLink:    true,
    title:     'Allow remote access to this desktop?',
    message:   `${ what } signed in to your Sulla Cloud account wants to control this desktop.`,
    detail:    `Device: ${ req.label }\n\nPairing code: ${ req.code.slice(0, 3) } ${ req.code.slice(3) }\n\n` +
      'Only click Allow if you just asked for this and the same code is showing on that screen. ' +
      'Once allowed, it can chat with Sulla here and run tasks on this computer. You can revoke it any time in Settings → Sulla Cloud.',
  };
  const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return res.response === 1;
}

const CLOUD_COMMANDS = new Set(['agent.stop', 'agent.message', 'workflow.run']);

/** Signed Cloud browser commands. SecureDesktopChannel already verified the signature and approval. */
async function runCloudCommand(body: Record<string, any>): Promise<Record<string, unknown>> {
  try {
    if (body.type !== 'workflow.run') return await dispatchCloudAgentCommand(body);
    const workflowId = typeof body.workflowId === 'string' ? body.workflowId : '';
    // Same boundary as agents: only a workflow this Desktop projects to Cloud.
    const { buildWorkflowProjection } = await import('./runtimeProjection/workflows');
    if (!workflowId || !(await buildWorkflowProjection()).some(w => w.id === workflowId)) return { ok: false, error: 'workflow_not_found' };
    const { executeRoutine } = await import('../sullaRoutineTemplateEvents');
    const result = await executeRoutine(workflowId, 'Requested from an approved Sulla Cloud browser');
    CloudRuntimeProjectionSync.changed();
    return { ok: true, executionId: result.executionId };
  } catch (err) {
    console.warn('[CloudLifecycle] Cloud command failed:', err);
    return { ok: false, error: 'command_failed' };
  }
}

function getChannel(): SecureDesktopChannel {
  if (!channel) {
    const dispatch = (body: Record<string, any>, reply: (frame: Record<string, unknown>) => void, respond: (frame: Record<string, unknown>) => void) => getDesktopRelayClient().handleRemoteCommand(body as any, reply, respond);
    ConversationSyncService.setDispatcher(dispatch);
    channel = new SecureDesktopChannel({
      prompt:   promptPairing,
      serverDispatch: frame => ConversationSyncService.handleServerFrame(frame),
      dispatch: async(body, reply, respond) => {
        if (body.type === 'conversation_key') {
          // A paired browser asks for a linked conversation's key, wrapped to its RSA-OAEP public key.
          if (typeof body.conversationId !== 'string' || !body.wrapKey || typeof body.wrapKey !== 'object') { respond({ type: 'error', reason: 'invalid_conversation_key_request' }); return }
          reply({ type: 'conversation_key', conversationId: body.conversationId, wrappedKey: ConversationSyncService.wrapKey(body.conversationId, body.wrapKey as JsonWebKey), algorithm: 'RSA-OAEP+A256GCM', keyVersion: 1 });
          return;
        }
        if (CLOUD_COMMANDS.has(body.type)) {
          // requestId lets the browser match the result to its command.
          const requestId = typeof body.requestId === 'string' ? body.requestId.slice(0, 64) : undefined;
          respond({ type: 'command_result', requestId, ...await runCloudCommand(body) });
          return;
        }
        await dispatch(body, reply, respond);
      },
      audit:    (event, detail) => console.log(`[SecureChannel] ${ event } ${ JSON.stringify(detail) }`),
    });
    channel.onStatus(() => broadcast());
  }
  return channel;
}

// Linked chats are opted in one by one (or all at once via the
// `conversations` preference), so ConversationSyncService runs whenever the
// Desktop is signed in; it only ever touches conversations that have a link.
async function startConversationSync(): Promise<void> {
  const { SullaSync } = await import('../sync/SullaSyncService');
  SullaSync.start();
}

async function stopConversationSync(): Promise<void> {
  const { SullaSync } = await import('../sync/SullaSyncService');
  SullaSync.stop();
}

async function applySyncPreferences(prefs: CloudPreferences): Promise<void> {
  if (!prefs.enabled) {
    await stopConversationSync().catch(() => undefined); ConversationSyncService.stop(); VaultSyncV3.stop(); FilesSyncV1.stop();
    DeviceInstallSync.stop(); CloudRuntimeProjectionSync.stop(); CloudDataSync.stop(); ByoUsageSync.stop(); return;
  }
  if (prefs.conversations) { await startConversationSync(); ConversationSyncService.start(); } else { await stopConversationSync(); ConversationSyncService.stop(); }
  if (prefs.vault) VaultSyncV3.start(); else VaultSyncV3.stop();
  if (prefs.files) FilesSyncV1.start(); else FilesSyncV1.stop();
  if (prefs.useCases) DeviceInstallSync.start(); else DeviceInstallSync.stop();
  if (prefs.workflows || prefs.liveAgents) CloudRuntimeProjectionSync.start(); else CloudRuntimeProjectionSync.stop();
  if (prefs.skills || prefs.customAgents || prefs.recipes || prefs.usage || prefs.memory) CloudDataSync.start(); else CloudDataSync.stop();
  if (prefs.usage) ByoUsageSync.start(); else ByoUsageSync.stop();
}

function installPrefsListener() {
  if (prefsListenerInstalled) return;
  prefsListenerInstalled = true;
  onCloudPreferencesChanged((prefs, changed) => {
    if (!signedIn) return;
    DevicesCloudApi.heartbeat().catch(() => undefined);
    applySyncPreferences(prefs).then(() => {
      if (prefs.enabled && changed.includes('conversations') && prefs.conversations) return ConversationSyncService.linkAll();
    }).catch(err => console.warn('[CloudLifecycle] sync preference change failed:', err));
    broadcast();
  });
  DevicesCloudApi.onStateChange((state) => {
    // Revoked from the dashboard: stop the channel; heartbeats keep polling
    // so a restore brings it back without a restart.
    if (state.revoked) { getChannel().stop(); FilesSyncV1.stop() }
    else if (signedIn && state.registered) { getChannel().start(); getCloudPreferences().then(p => { if (isCloudKindEnabled(p, 'files')) FilesSyncV1.start() }).catch(() => undefined) }
    broadcast();
  });
}

/** Called after a successful sign-in and after restoring a saved session. */
export async function startCloudServices(): Promise<void> {
  signedIn = true;
  installPrefsListener();
  const prefs = await getCloudPreferences();
  const deviceId = await DevicesCloudApi.register();
  DevicesCloudApi.startHeartbeat();
  // The channel needs the key enrolled first; if registration failed it
  // retries on its own backoff.
  if (deviceId && !DevicesCloudApi.getState().revoked) getChannel().start();
  await applySyncPreferences(prefs).catch(err => console.warn('[CloudLifecycle] sync services start failed:', err));
  broadcast();
}

export async function stopCloudServices(): Promise<void> {
  signedIn = false;
  channel?.stop();
  VaultSyncV3.stop();
  FilesSyncV1.stop();
  DeviceInstallSync.stop();
  CloudRuntimeProjectionSync.stop();
  CloudDataSync.stop();
  ByoUsageSync.stop();
  await stopConversationSync().catch(() => undefined);
  ConversationSyncService.stop();
  DevicesCloudApi.stopHeartbeat();
  broadcast();
}

export function handleSystemResume(): void {
  if (signedIn) channel?.reconnect();
}

export interface CloudConnectionStatus {
  signedIn:        boolean;
  preferences:     CloudPreferences | null;
  channel:         ReturnType<SecureDesktopChannel['getStatus']> | null;
  device:          ReturnType<typeof DevicesCloudApi.getState>;
  keyFingerprint:  string | null;
  approvedClients: { clientId: string; label: string; surface: string; approvedAt: string; lastUsedAt?: string }[];
  objectSync:      Array<ReturnType<typeof VaultSyncV3.getStatus>[number] | ReturnType<typeof CloudDataSync.getStatus>[number]>;
}

export async function getCloudConnectionStatus(): Promise<CloudConnectionStatus> {
  let fingerprint: string | null = null;
  try { fingerprint = getDeviceKeyFingerprint() } catch { /* key unreadable */ }
  return {
    signedIn,
    preferences:     await getCloudPreferences().catch(() => null),
    channel:         channel?.getStatus() ?? null,
    device:          DevicesCloudApi.getState(),
    keyFingerprint:  fingerprint,
    approvedClients: ApprovedClients.list().map(({ publicKey: _pk, ...rest }) => rest),
    objectSync:      [...VaultSyncV3.getStatus(), ...CloudDataSync.getStatus()],
  };
}

function broadcast() {
  getCloudConnectionStatus().then((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send('sulla-cloud-connection:status-changed', status) } catch { /* window gone */ }
    }
  }).catch(() => undefined);
}

/** IPC for Settings → Sulla Cloud. Human-driven only. */
export function initCloudConnectionEvents(): void {
  const ipc = getIpcMainProxy(console);

  ipc.handle('sulla-cloud-connection:get-status', async() => getCloudConnectionStatus());

  ipc.handle('sulla-cloud-connection:set-preferences', async(_e: unknown, patch: Partial<Record<keyof CloudPreferences, unknown>>) => {
    await setCloudPreferences(patch ?? {});
    return getCloudConnectionStatus();
  });

  ipc.handle('sulla-cloud-chat:get-link', async(_e: unknown, conversationId: string) => ConversationSyncService.getLink(conversationId));
  ipc.handle('sulla-cloud-chat:link', async(_e: unknown, conversationId: string, title: string, privacyMode: 'encrypted_bodies'|'metadata_only') => ConversationSyncService.link(conversationId,title,privacyMode));
  ipc.handle('sulla-cloud-chat:unlink', async(_e: unknown, linkId: string, deleteCloudCopy: boolean) => ConversationSyncService.unlink(linkId,deleteCloudCopy));

  ipc.handle('sulla-cloud-connection:revoke-client', async(_e: unknown, clientId: string) => {
    if (typeof clientId === 'string') getChannel().revokeClient(clientId);
    return getCloudConnectionStatus();
  });

  ipc.handle('sulla-cloud-connection:sync-now', async(_e: unknown, kind: CloudDataKind | 'all') => {
    if (kind === 'vault') await VaultSyncV3.syncNow();
    else if (kind === 'all') { await syncRuntimeProjections(true); await CloudDataSync.syncEnabled(true); await ByoUsageSync.flush(); ConversationSyncService.syncNow().catch(() => undefined); FilesSyncV1.wake(); }
    else if (['skills','customAgents','recipes','usage','memory'].includes(kind)) { await CloudDataSync.syncNow(kind as ProjectionKind, true); if (kind === 'usage') await ByoUsageSync.flush(); }
    return getCloudConnectionStatus();
  });

  ipc.handle('sulla-cloud-connection:delete-cloud-copy', async(_e: unknown, kind: CloudDataKind | 'all') => {
    // Files, chats and passwords have their own encrypted stores; the rest are device projections.
    if (kind === 'vault') await VaultSyncV3.deleteCloudCopy();
    else if (kind === 'files') await FilesSyncV1.deleteAllCloudCopies({ kind: 'human' });
    else if (kind === 'conversations') await ConversationSyncService.deleteAllCloudCopies();
    else if (kind === 'all') { await CloudDataSync.deleteAll(); await FilesSyncV1.deleteAllCloudCopies({ kind: 'human' }); await ConversationSyncService.deleteAllCloudCopies() }
    else await CloudDataSync.deleteCloudCopy(kind);
    return getCloudConnectionStatus();
  });
}
