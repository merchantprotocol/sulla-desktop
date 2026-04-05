/**
 * Model — Audio Mirror Manager.
 * Manages audio routing for system audio capture.
 */

import { log } from './logger';
import * as platform from '../platform';

let isRebuilding = false;

export async function status() {
  return platform.mirror.status();
}

export async function enable(deviceName?: string, forDeviceUID?: string) {
  return platform.mirror.enable(deviceName, forDeviceUID);
}

export async function disable() {
  return platform.mirror.disable();
}

export function watch(onRebuild: (event: { name: string; uid: string; deviceName: string }) => void): void {
  platform.watcher.start((event: any) => {
    handleOutputChange(event, onRebuild);
  });
}

async function handleOutputChange(event: any, onRebuild: (e: any) => void): Promise<void> {
  if (isRebuilding) {
    log.debug('Mirror', 'Already rebuilding, skipping', event);
    return;
  }
  isRebuilding = true;

  const newName = `${ event.name } + Loopback`;
  log.info('Mirror', 'Output changed — rebuilding mirror', {
    device: event.name, uid: event.uid, mirrorName: newName,
  });

  try {
    await disable();
    const ok = await enable(newName, event.uid);
    if (ok && onRebuild) {
      onRebuild({ name: newName, uid: event.uid, deviceName: event.name });
    }
  } catch (e: any) {
    log.error('Mirror', 'Rebuild failed', { error: e.message });
  } finally {
    isRebuilding = false;
  }
}

export function stopWatching(): void {
  platform.watcher.stop();
}
