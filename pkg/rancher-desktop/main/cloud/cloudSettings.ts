/**
 * Sulla Cloud connection preferences — what this desktop shares with the
 * cloud. Every sync is OFF unless the owner turns it on.
 *
 *   cloudSyncConversations  push/pull chat history (claude_conversations/messages)
 *   cloudSyncVault          upload a ciphertext-only vault snapshot (zero-knowledge)
 *   cloudSyncProjects       upload a Projects snapshot
 *   cloudRemoteAccess       accept commands from browsers/phones the owner
 *                           approved at this desktop (on by default: nothing
 *                           is approved until the owner pairs a device here)
 *
 * Migration: installs that were already syncing chat history before these
 * switches existed (non-zero sync cursor) keep conversations on, so an
 * update doesn't silently cut off the phone's history. Everything else
 * starts off.
 *
 * These keys are human-only: the agent `settings/set` tool refuses them
 * (see PROTECTED_SETTING_PREFIXES) so a prompt-injected agent can't turn on
 * uploads or remote control.
 */

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

export interface CloudPreferences {
  conversations: boolean;
  vault:         boolean;
  projects:      boolean;
  remoteAccess:  boolean;
}

export const CLOUD_SETTING_KEYS = {
  conversations: 'cloudSyncConversations',
  vault:         'cloudSyncVault',
  projects:      'cloudSyncProjects',
  remoteAccess:  'cloudRemoteAccess',
} as const;

const INITIALIZED_KEY = 'cloudSyncPreferencesInitialized';
const LEGACY_SYNC_CURSOR_KEY = 'claudeSyncLastSeq';

type Listener = (prefs: CloudPreferences, changed: Array<keyof CloudPreferences>) => void;
const listeners: Listener[] = [];

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

async function ensureInitialized(): Promise<void> {
  if (asBool(await SullaSettingsModel.get(INITIALIZED_KEY, false), false)) return;
  const cursor = parseInt(String((await SullaSettingsModel.get(LEGACY_SYNC_CURSOR_KEY, '0')) ?? '0'), 10);
  const wasSyncing = Number.isFinite(cursor) && cursor > 0;
  await SullaSettingsModel.set(CLOUD_SETTING_KEYS.conversations, wasSyncing, 'boolean');
  await SullaSettingsModel.set(CLOUD_SETTING_KEYS.vault, false, 'boolean');
  await SullaSettingsModel.set(CLOUD_SETTING_KEYS.projects, false, 'boolean');
  await SullaSettingsModel.set(CLOUD_SETTING_KEYS.remoteAccess, true, 'boolean');
  await SullaSettingsModel.set(INITIALIZED_KEY, true, 'boolean');
}

export async function getCloudPreferences(): Promise<CloudPreferences> {
  await ensureInitialized();
  return {
    conversations: asBool(await SullaSettingsModel.get(CLOUD_SETTING_KEYS.conversations, false), false),
    vault:         asBool(await SullaSettingsModel.get(CLOUD_SETTING_KEYS.vault, false), false),
    projects:      asBool(await SullaSettingsModel.get(CLOUD_SETTING_KEYS.projects, false), false),
    remoteAccess:  asBool(await SullaSettingsModel.get(CLOUD_SETTING_KEYS.remoteAccess, true), true),
  };
}

/** Human-initiated change (Settings UI / first run). Only known booleans apply. */
export async function setCloudPreferences(patch: Partial<Record<keyof CloudPreferences, unknown>>): Promise<CloudPreferences> {
  const before = await getCloudPreferences();
  const changed: Array<keyof CloudPreferences> = [];
  for (const key of Object.keys(CLOUD_SETTING_KEYS) as Array<keyof CloudPreferences>) {
    const v = patch[key];
    if (typeof v !== 'boolean' || v === before[key]) continue;
    await SullaSettingsModel.set(CLOUD_SETTING_KEYS[key], v, 'boolean');
    changed.push(key);
  }
  const after = await getCloudPreferences();
  if (changed.length) {
    for (const l of listeners) {
      try { l(after, changed); } catch (err) { console.warn('[cloudSettings] listener failed:', err); }
    }
  }
  return after;
}

export function onCloudPreferencesChanged(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/**
 * Settings the agent tool surface must never write. Covers the cloud
 * switches above, the legacy relay pairing, and anything future under
 * these prefixes.
 */
export const PROTECTED_SETTING_PREFIXES = ['cloudSync', 'cloudRemoteAccess', 'secureChannel', 'pairedMobileUserId'];

export function isProtectedSetting(property: string): boolean {
  return PROTECTED_SETTING_PREFIXES.some(p => property === p || property.startsWith(p));
}
