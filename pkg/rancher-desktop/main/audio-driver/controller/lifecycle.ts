/**
 * Controller — audio capture lifecycle.
 *
 * Owns the startup and shutdown sequences for the audio capture system.
 * Startup: install driver → reset output → enable mirror → start watcher → start capture
 * Shutdown: stop capture → stop watcher → disable mirror → remove driver
 */

import { globalShortcut, systemPreferences } from 'electron';
import { log } from '../model/logger';
import * as platform from '../platform';
import * as loopback from '../model/loopback';
import * as mirror from '../model/mirror';
import * as speakerCapture from '../model/speaker-capture';

let onSpeakerLevel: ((data: any) => void) | null = null;
let onMirrorRebuilt: ((event: any) => void) | null = null;
let onVolumeChanged: ((state: any) => void) | null = null;

// UID of the physical speaker device the mirror is forwarding to.
let physicalDeviceUID: string | null = null;

// ─── Volume key interception ───────────────────────────────────

function registerVolumeKeys(): void {
  if (!physicalDeviceUID) {
    log.warn('Lifecycle', 'Cannot register volume keys — no physical device UID');
    return;
  }

  if (systemPreferences.isTrustedAccessibilityClient) {
    const trusted = systemPreferences.isTrustedAccessibilityClient(true);
    log.info('Lifecycle', 'Accessibility permission', { trusted });
  }

  const uid = physicalDeviceUID;

  const regUp = globalShortcut.register('VolumeUp', async() => {
    const result = await platform.volume.inc(uid);
    if (result.ok && onVolumeChanged) onVolumeChanged(result);
  });

  const regDown = globalShortcut.register('VolumeDown', async() => {
    const result = await platform.volume.dec(uid);
    if (result.ok && onVolumeChanged) onVolumeChanged(result);
  });

  const regMute = globalShortcut.register('VolumeMute', async() => {
    const result = await platform.volume.toggleMute(uid);
    if (result.ok && onVolumeChanged) onVolumeChanged(result);
  });

  log.info('Lifecycle', 'Volume keys registered', { regUp, regDown, regMute, deviceUID: uid });
}

function unregisterVolumeKeys(): void {
  globalShortcut.unregister('VolumeUp');
  globalShortcut.unregister('VolumeDown');
  globalShortcut.unregister('VolumeMute');
  log.info('Lifecycle', 'Volume keys unregistered');
}

/**
 * Full startup — install driver, create mirror, start watcher, start capture.
 */
export async function activate({ onLevel, onRebuild }: { onLevel?: (data: any) => void; onRebuild?: (event: any) => void } = {}) {
  log.info('Lifecycle', 'Activating...');
  onSpeakerLevel = onLevel || null;
  onMirrorRebuilt = onRebuild || null;

  // 1. Ensure loopback driver is available
  const detection = await loopback.detect();
  if (!detection.found) {
    log.info('Lifecycle', 'Loopback driver not found — installing...');
    const installed = await platform.loopback.install();
    if (!installed) {
      log.error('Lifecycle', 'Cannot activate — no loopback driver available');
      return { ok: false, mirrorActive: false };
    }
    await loopback.detect(); // re-cache
  } else {
    log.info('Lifecycle', 'Loopback driver available', {
      name: detection.name, driver: detection.driver,
    });
  }

  // 2. Reset output if stuck on loopback (broken shutdown recovery)
  await platform.devices.resetOutput();

  // 3. Capture the current physical device UID (before mirror takes over)
  physicalDeviceUID = await platform.volume.getDefaultOutputUID();
  log.info('Lifecycle', 'Physical device for volume control', { uid: physicalDeviceUID });

  // 4. Enable mirror
  const mirrorOk = await mirror.enable();
  log.info('Lifecycle', 'Mirror enable', { ok: mirrorOk });

  // 5. Register volume keys on macOS
  if (process.platform === 'darwin' && physicalDeviceUID) {
    registerVolumeKeys();
  }

  // 6. Start watcher for output device changes
  mirror.watch((event) => {
    log.info('Lifecycle', 'Mirror rebuilt for new output', event);
    physicalDeviceUID = event.uid;
    if (process.platform === 'darwin') {
      unregisterVolumeKeys();
      registerVolumeKeys();
    }
    if (onMirrorRebuilt) onMirrorRebuilt(event);
  });

  // 7. Start speaker capture (with raw PCM callback for gateway + local transcription)
  const gateway = await import('../service/gateway');
  const whisperTranscribe = await import('../service/whisper-transcribe');
  speakerCapture.start((level: any) => {
    if (onSpeakerLevel) onSpeakerLevel(level);
  }, {
    onAudio: (pcmData: Buffer) => {
      gateway.sendAudio(pcmData, 1);
      // Feed speaker audio to local whisper transcription (secretary mode)
      whisperTranscribe.feedSpeaker(pcmData);
    },
  });

  log.info('Lifecycle', 'Activated');
  const permissions = checkPermissions();
  return { ok: true, mirrorActive: mirrorOk, permissions };
}

/**
 * Check macOS accessibility and microphone permissions.
 */
export function checkPermissions() {
  const result: { accessibility: boolean; microphone: string } = { accessibility: true, microphone: 'granted' };

  if (process.platform === 'darwin') {
    if (systemPreferences.isTrustedAccessibilityClient) {
      result.accessibility = systemPreferences.isTrustedAccessibilityClient(false);
    }
    if (systemPreferences.getMediaAccessStatus) {
      result.microphone = systemPreferences.getMediaAccessStatus('microphone');
    }
  }
  return result;
}

/**
 * Full shutdown — stop capture, stop watcher, disable mirror, remove driver.
 */
export async function deactivate({ removeDriver = false } = {}) {
  log.info('Lifecycle', 'Deactivating...', { removeDriver });

  if (process.platform === 'darwin') {
    unregisterVolumeKeys();
  }
  physicalDeviceUID = null;

  speakerCapture.stop();
  mirror.stopWatching();
  await mirror.disable();

  if (removeDriver) {
    platform.loopback.remove();
  }

  onSpeakerLevel = null;
  onMirrorRebuilt = null;
  log.info('Lifecycle', 'Deactivated');
}

// ─── Volume control API ─────────────────────────────────────

export async function speakerVolumeUp() {
  if (!physicalDeviceUID) return null;
  const result = await platform.volume.inc(physicalDeviceUID);
  if (result.ok && onVolumeChanged) onVolumeChanged(result);
  return result;
}

export async function speakerVolumeDown() {
  if (!physicalDeviceUID) return null;
  const result = await platform.volume.dec(physicalDeviceUID);
  if (result.ok && onVolumeChanged) onVolumeChanged(result);
  return result;
}

export async function speakerMuteToggle() {
  if (!physicalDeviceUID) return null;
  const result = await platform.volume.toggleMute(physicalDeviceUID);
  if (result.ok && onVolumeChanged) onVolumeChanged(result);
  return result;
}

export async function speakerVolumeGet() {
  if (!physicalDeviceUID) return null;
  return platform.volume.get(physicalDeviceUID);
}

export function setOnVolumeChanged(cb: (state: any) => void): void {
  onVolumeChanged = cb;
}
