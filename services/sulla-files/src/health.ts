import type { Config } from './config.js';
import type { FilesLifecycleStatus } from './lifecycle.js';

/**
 * /healthz body. Desktop gates the unlock handshake on a top-level
 * `legacyImport.state`, so it must be present even before the first unlock
 * preflight has run (e.g. stored-only mode). 'clear' matches the lifecycle
 * snapshot default; the bootstrap preflight still runs and overwrites it.
 */
export function healthPayload(config:Pick<Config, 'mode' | 'legacyPreflight'>, ready:boolean, lifecycle?:FilesLifecycleStatus) {
  return {
    ok: true, mode: config.mode, locked: !ready,
    legacyImport: config.legacyPreflight ?? { state: 'clear' as const },
    lifecycle,
  };
}
