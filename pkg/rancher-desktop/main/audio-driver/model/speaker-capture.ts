/**
 * Model — speaker capture.
 * Thin wrapper around the platform provider.
 */

import * as platform from '../platform';

export function start(onLevel: (data: any) => void, opts?: { onAudio?: (data: Buffer) => void }): void {
  platform.capture.start(onLevel, opts);
}

export function stop(): void {
  platform.capture.stop();
}

export function isRunning(): boolean {
  return platform.capture.isRunning();
}
