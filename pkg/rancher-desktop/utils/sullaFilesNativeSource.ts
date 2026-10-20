export type SullaFilesNativeRuntimeState = 'disabled' | 'starting' | 'ready' | 'locking' | 'error';
export type SullaFilesNativeSourceGrant = 'session-only' | 'security-scoped-bookmark' | 'unsupported';

export interface SullaFilesNativeRuntimeStatus {
  state:       SullaFilesNativeRuntimeState;
  ready:       boolean;
  generation:  number;
  sourceGrant: SullaFilesNativeSourceGrant;
  mountPath?:  string;
  reason?:     string;
}

/**
 * Test-phase rollout: every agent receives the mount. Authorization is
 * centralized in the Files service policy hook for later per-agent grants.
 */
export const SULLA_FILES_NATIVE_SOURCE_READY = true;

/**
 * One rollout gate owns the service routes and guest mount. Readiness remains
 * runtime state and Files lock still drains the mount.
 */
export function sullaFilesNativeSourceRolloutRequested():boolean {
  return SULLA_FILES_NATIVE_SOURCE_READY;
}

/**
 * Developer ID builds are not App-Sandboxed, so selected files are held by an
 * Electron-owned descriptor for this session and must be reselected on restart.
 * MAS builds may retain a security-scoped bookmark when Electron returns one.
 */
export function sullaFilesNativeSourceGrant():SullaFilesNativeSourceGrant {
  if (process.platform !== 'darwin') return 'session-only';
  return process.mas ? 'security-scoped-bookmark' : 'session-only';
}
