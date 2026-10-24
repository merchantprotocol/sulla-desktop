import os from 'node:os';
import path from 'node:path';

/**
 * Team-ID-prefixed app group shared by the app, SullaFinderSync.appex and
 * SullaFileProvider.appex. macOS 15 authorizes this form from the Developer ID
 * signature; the File Provider profile also lists it.
 */
export const SULLA_APP_GROUP = '946AF7TL74.io.sulla.desktop';

export function sullaAppGroupDirectory(home = os.homedir()):string {
  return path.join(home, 'Library', 'Group Containers', SULLA_APP_GROUP);
}

/** `defaults` domain path that sandboxed extensions read as UserDefaults(suiteName: SULLA_APP_GROUP). */
export function sullaAppGroupDefaultsDomain(home = os.homedir()):string {
  return path.join(sullaAppGroupDirectory(home), 'Library', 'Preferences', SULLA_APP_GROUP);
}
