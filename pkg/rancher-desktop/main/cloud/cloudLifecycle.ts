/**
 * Sulla Cloud lifecycle — one place that decides what runs while the owner
 * is signed in.
 *
 * Signed in ⇒ always connected:
 *   - device registration (with the Ed25519 public key) + 45s heartbeat
 *   - the secure desktop channel (cloud dashboard → this desktop)
 * Plus, only if the owner opted in (Settings → Sulla Cloud):
 *   - conversation sync (SullaSync push/pull)
 *   - vault copy (zero-knowledge) and Projects copy uploads
 *
 * Signed out ⇒ everything stops.
 */

import { BrowserWindow, dialog } from 'electron';

import { getDesktopRelayClient } from '../desktopRelay';
import { DevicesCloudApi } from '../devicesCloudApi';
import { ApprovedClients } from './approvedClients';
import { getCloudPreferences, onCloudPreferencesChanged, setCloudPreferences, type CloudPreferences } from './cloudSettings';
import { DesktopObjectSync, type ObjectKind } from './desktopObjectSync';
import { getDeviceKeyFingerprint } from './deviceKey';
import { SecureDesktopChannel } from './secureChannel';

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

function getChannel(): SecureDesktopChannel {
  if (!channel) {
    channel = new SecureDesktopChannel({
      prompt:   promptPairing,
      dispatch: (body, reply, respond) => getDesktopRelayClient().handleRemoteCommand(body as any, reply, respond),
      audit:    (event, detail) => console.log(`[SecureChannel] ${ event } ${ JSON.stringify(detail) }`),
    });
    channel.onStatus(() => broadcast());
  }
  return channel;
}

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
      (prefs.conversations ? startConversationSync() : stopConversationSync()).catch(err => console.warn('[CloudLifecycle] conversation sync toggle failed:', err));
    }
    if (changed.includes('vault') && prefs.vault) DesktopObjectSync.syncNow('vault', true).catch(() => undefined);
    if (changed.includes('projects') && prefs.projects) DesktopObjectSync.syncNow('projects', true).catch(() => undefined);
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
  DesktopObjectSync.start();
  broadcast();
}

export async function stopCloudServices(): Promise<void> {
  signedIn = false;
  channel?.stop();
  DesktopObjectSync.stop();
  await stopConversationSync().catch(() => undefined);
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
  objectSync:      ReturnType<typeof DesktopObjectSync.getStatus>;
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
    objectSync:      DesktopObjectSync.getStatus(),
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

  ipc.handle('sulla-cloud-connection:revoke-client', async(_e: unknown, clientId: string) => {
    if (typeof clientId === 'string') getChannel().revokeClient(clientId);
    return getCloudConnectionStatus();
  });

  ipc.handle('sulla-cloud-connection:sync-now', async(_e: unknown, kind: ObjectKind) => {
    if (kind === 'vault' || kind === 'projects') await DesktopObjectSync.syncNow(kind, true);
    return getCloudConnectionStatus();
  });

  ipc.handle('sulla-cloud-connection:delete-cloud-copy', async(_e: unknown, kind: ObjectKind) => {
    if (kind === 'vault' || kind === 'projects') await DesktopObjectSync.deleteCloudCopy(kind);
    return getCloudConnectionStatus();
  });
}
