/**
 * Host-machine access gate.
 *
 * Reads `application.hostAccess` from the on-disk rancher-desktop settings
 * (the same value backing the "Allow access to the host machine" checkbox
 * under Preferences → Application → Administrative Access). When this is
 * false, the agent must NOT be able to run host shell commands — neither the
 * AppleScript→Terminal bridge nor any future host-exec path.
 *
 * Fails CLOSED: if the settings file is missing/unreadable, host access is
 * treated as disabled. Reading from disk each call is fine — these checks
 * are low-frequency and the file is small.
 */

import fs from 'fs';
import { join } from 'path';

import paths from '@pkg/utils/paths';

export function isHostAccessEnabled(): boolean {
  try {
    const settingsPath = join(paths.config, 'settings.json');
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const cfg = JSON.parse(raw);
    return cfg?.application?.hostAccess === true;
  } catch {
    return false;
  }
}

/** Standard message shown when an agent tries to reach the host with the
 *  gate closed. Tells the user exactly how to enable it. */
export const HOST_ACCESS_DISABLED_MESSAGE =
  'Host machine access is disabled. To let the agent run host shell commands or drive Terminal, enable "Allow access to the host machine" under Preferences → Application → Administrative Access.';
