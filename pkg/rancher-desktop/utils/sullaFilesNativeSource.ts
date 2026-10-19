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
 * One rollout gate owns the service routes, guest mount and renderer capability.
 * Readiness is still runtime state: this flag alone never enables the UI.
 */
export function sullaFilesNativeSourceRolloutRequested():boolean {
  return process.env.SULLA_FILES_NATIVE_SOURCE_ROLLOUT === '1';
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
