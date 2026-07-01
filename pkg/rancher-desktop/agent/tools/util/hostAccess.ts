/**
 * Host-machine access gate.
 *
 * Backed by `hostAccess` in SullaSettingsModel (the Redis + Postgres dual
 * store, same place heartbeatEnabled / remoteProvider live) — NOT the on-disk
 * rancher-desktop settings.json. This keeps host access consistent with every
 * other Sulla setting: it can be read/written through the settings model, the
 * Redis `sulla_settings` hash, or the Preferences UI, and it works even when no
 * settings.json exists on disk.
 *
 * When false, the agent must NOT be able to run host shell commands — neither
 * the AppleScript→Terminal bridge nor the meta/exechost path.
 *
 * Fails CLOSED: any read error (DB down, unset) is treated as disabled.
 */

import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';

/** Settings property key — flat camelCase, matching the other settings. */
export const HOST_ACCESS_SETTING_KEY = 'hostAccess';

export async function isHostAccessEnabled(): Promise<boolean> {
  try {
    const value = await SullaSettingsModel.get(HOST_ACCESS_SETTING_KEY, false);
    // Coerce defensively — the value may come back as a real boolean (when
    // stored with cast 'boolean') or as the string "true" (e.g. a raw
    // `redis hset sulla_settings hostAccess true` with no PG cast row).
    return value === true || value === 'true';
  } catch {
    return false;
  }
}

/** Enable/disable host access through the dual store (cast as boolean so
 *  reads come back as a real boolean). */
export async function setHostAccessEnabled(enabled: boolean): Promise<void> {
  await SullaSettingsModel.set(HOST_ACCESS_SETTING_KEY, enabled, 'boolean');
}

/** Standard message shown when an agent tries to reach the host with the
 *  gate closed. Tells the user exactly how to enable it. */
export const HOST_ACCESS_DISABLED_MESSAGE =
  'Host machine access is disabled. To let the agent run host shell commands or drive Terminal, enable "Allow access to the host machine" under Preferences → Application → Administrative Access.';
