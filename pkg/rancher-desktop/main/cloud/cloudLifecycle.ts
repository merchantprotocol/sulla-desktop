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
import { getCloudPreferences, onCloudPreferencesChanged, setCloudPreferences, type CloudPreferences } from './cloudSettings';
import { type ObjectKind } from './desktopObjectSync';
import { VaultSyncV3 } from './vaultSyncV3';
import { getDeviceKeyFingerprint } from './deviceKey';
import { SecureDesktopChannel } from './secureChannel';
import { ConversationSyncService } from './conversationSync';
import { CloudRuntimeProjectionSync } from './runtimeProjection/sync';
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

function installPrefsListener() {
  if (prefsListenerInstalled) return;
  prefsListenerInstalled = true;
  onCloudPreferencesChanged((prefs, changed) => {
    if (!signedIn) return;
    DevicesCloudApi.heartbeat().catch(() => undefined);
    if (changed.includes('conversations')) {
      (prefs.conversations ? startConversationSync().then(() => ConversationSyncService.linkAll()) : stopConversationSync()).catch(err => console.warn('[CloudLifecycle] conversation sync toggle failed:', err));
    }
    if (changed.includes('vault')) (prefs.vault ? VaultSyncV3.syncNow() : VaultSyncV3.pause()).catch(() => undefined);
    broadcast();
  });
  DevicesCloudApi.onStateChange((state) => {
    // Revoked from the dashboard: stop the channel; heartbeats keep polling
    // so a restore brings it back without a restart.
    if (state.revoked) getChannel().stop();
    else if (signedIn && state.registered) getChannel().start();
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
  if (prefs.conversations) await startConversationSync().catch(err => console.warn('[CloudLifecycle] SullaSync start failed:', err));
  ConversationSyncService.start();
  VaultSyncV3.start();
  DeviceInstallSync.start();
  CloudRuntimeProjectionSync.start();
  broadcast();
}

export async function stopCloudServices(): Promise<void> {
  signedIn = false;
  channel?.stop();
  VaultSyncV3.stop();
  DeviceInstallSync.stop();
  CloudRuntimeProjectionSync.stop();
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
  objectSync:      ReturnType<typeof VaultSyncV3.getStatus>;
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
    objectSync:      VaultSyncV3.getStatus(),
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

  ipc.handle('sulla-cloud-connection:sync-now', async(_e: unknown, kind: ObjectKind) => {
    if (kind === 'vault') await VaultSyncV3.syncNow();
    return getCloudConnectionStatus();
  });

  ipc.handle('sulla-cloud-connection:delete-cloud-copy', async(_e: unknown, kind: ObjectKind) => {
    if (kind === 'vault') await VaultSyncV3.deleteCloudCopy();
    return getCloudConnectionStatus();
  });
}
