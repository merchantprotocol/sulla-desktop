/**
 * @module audio-driver/controller/lifecycle
 *
 * # Audio Capture Lifecycle Controller
 *
 * Owns the full startup and shutdown sequences for the speaker-side audio
 * capture system. The mic side is handled in the renderer (see
 * `model/audio-capture.js`); this controller manages everything that runs
 * in the main process on macOS:
 *
 * ## Activation sequence
 *
 * 1. **Loopback driver detection/install** — ensures BlackHole (or equivalent)
 *    virtual audio device is present in `/Library/Audio/Plug-Ins/HAL/`
 * 2. **Output reset** — if the system output was left pointing at the loopback
 *    device from a previous crash, reset it to the real physical speaker
 * 3. **Physical device UID capture** — records the UID of the current physical
 *    output device so volume keys can target it even after the system output
 *    switches to the aggregate mirror
 * 4. **Mirror device creation** — builds a CoreAudio aggregate device that
 *    combines the physical speaker + BlackHole, so all system audio is
 *    simultaneously played and looped back for capture
 * 5. **Volume key interception** — registers global shortcuts for VolumeUp,
 *    VolumeDown, VolumeMute that route to the physical speaker (the aggregate
 *    device does not respond to volume keys natively)
 * 6. **Device-change watcher** — monitors for output device changes (e.g. user
 *    plugs in headphones) and rebuilds the mirror automatically
 * 7. **Speaker socket + capture start** — launches the Swift CoreAudio capture
 *    helper and begins streaming raw s16le PCM to the gateway and speaker socket
 *
 * ## Deactivation sequence
 *
 * Reverses activation: unregisters volume keys, stops the capture helper,
 * stops the speaker socket, stops the device watcher, disables the mirror.
 * Optionally removes the loopback driver (not done on normal shutdown).
 *
 * ## Volume control
 *
 * Because the system output points at the aggregate mirror device, macOS
 * volume keys have no audible effect. This controller intercepts them via
 * `globalShortcut` and applies volume changes directly to the physical
 * speaker device using CoreAudio APIs. A callback ({@link setOnVolumeChanged})
 * notifies the UI so the volume indicator stays in sync.
 */

import { globalShortcut, systemPreferences } from 'electron';

import { log } from '../model/logger';
import * as loopback from '../model/loopback';
import * as mirror from '../model/mirror';
import * as speakerCapture from '../model/speaker-capture';
import * as platform from '../platform';
import * as speakerSocket from '../service/speaker-socket';

let onSpeakerLevel: ((data: any) => void) | null = null;
let onMirrorRebuilt: ((event: any) => void) | null = null;
let onVolumeChanged: ((state: any) => void) | null = null;

// UID of the physical speaker device the mirror is forwarding to.
let physicalDeviceUID: string | null = null;

// ─── Volume key interception ───────────────────────────────────

/**
 * Register global shortcuts for VolumeUp, VolumeDown, and VolumeMute.
 *
 * When the audio mirror is active the system output is an aggregate device
 * that does not respond to hardware volume keys. This function intercepts
 * those keys and applies volume changes directly to the physical speaker
 * device identified by {@link physicalDeviceUID}.
 *
 * Requires macOS Accessibility permission (`isTrustedAccessibilityClient`).
 */
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

/**
 * Unregister the VolumeUp/VolumeDown/VolumeMute global shortcuts,
 * restoring normal macOS volume key behavior.
 */
function unregisterVolumeKeys(): void {
  globalShortcut.unregister('VolumeUp');
  globalShortcut.unregister('VolumeDown');
  globalShortcut.unregister('VolumeMute');
  log.info('Lifecycle', 'Volume keys unregistered');
}

/**
 * Full startup — install loopback driver, create aggregate mirror, register
 * volume keys, start device-change watcher, and begin speaker capture.
 *
 * This is the main process counterpart to the renderer's mic capture. After
 * this resolves, system audio is being captured via BlackHole and streamed
 * to the gateway on channel 1 (speaker).
 *
 * @param onLevel   - Called at the Swift helper's native rate with
 *                    `{ rms, peak, zcr, variance }` speaker level data.
 *                    Used to drive the speaker meter in the UI.
 * @param onRebuild - Called when the mirror is rebuilt for a new output device
 *                    (e.g. user switched from speakers to headphones). Receives
 *                    `{ name, uid }` of the new physical device.
 * @returns `{ ok, mirrorActive, permissions }` — `ok` is false only if the
 *          loopback driver could not be installed.
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

  // 7. Start speaker socket + capture (with raw PCM callback for gateway + local transcription)
  speakerSocket.start();

  // Wait for macOS to fully activate the aggregate device before capturing.
  // Without this delay the Swift helper reads from BlackHole before audio is
  // being routed through the mirror, producing silence on first activation.
  await new Promise(resolve => setTimeout(resolve, 600));

  const gateway = await import('../service/gateway');
  const whisperTranscribe = await import('../service/whisper-transcribe');
  speakerCapture.start((level: any) => {
    if (onSpeakerLevel) onSpeakerLevel(level);
  }, {
    onAudio: (pcmData: Buffer) => {
      gateway.sendAudio(pcmData, 1);
      // Feed speaker audio to local whisper transcription (secretary mode)
      whisperTranscribe.feedSpeaker(pcmData);
      // Feed speaker audio to capture studio socket
      speakerSocket.writeChunk(pcmData);
    },
  });

  log.info('Lifecycle', 'Activated');
  const permissions = checkPermissions();
  return { ok: true, mirrorActive: mirrorOk, permissions };
}

/**
 * Check macOS accessibility and microphone permissions.
 *
 * - **Accessibility** — required for global volume key interception.
 *   Without it, `globalShortcut.register('VolumeUp', ...)` silently fails.
 * - **Microphone** — required for `getUserMedia` in the renderer. Returns
 *   `'granted'`, `'denied'`, or `'restricted'`.
 *
 * On non-macOS platforms, returns `{ accessibility: true, microphone: 'granted' }`.
 *
 * @returns `{ accessibility: boolean, microphone: string }`
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
 * Full shutdown — stop capture, stop speaker socket, stop device watcher,
 * disable the aggregate mirror, and optionally remove the loopback driver.
 *
 * On normal application quit, `removeDriver` should be `false` because the
 * BlackHole driver lives in a system directory requiring `sudo` to delete.
 * Pass `true` only for explicit user-initiated uninstall.
 *
 * @param removeDriver - If `true`, also uninstalls the BlackHole loopback
 *                       driver from `/Library/Audio/Plug-Ins/HAL/`.
 */
export async function deactivate({ removeDriver = false } = {}) {
  log.info('Lifecycle', 'Deactivating...', { removeDriver });

  if (process.platform === 'darwin') {
    unregisterVolumeKeys();
  }
  physicalDeviceUID = null;

  speakerCapture.stop();
  speakerSocket.stop();
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

/**
 * Increase the physical speaker volume by one step.
 * No-op if no physical device UID is cached (capture not active).
 * Fires the {@link onVolumeChanged} callback with the new volume state.
 */
export async function speakerVolumeUp() {
  if (!physicalDeviceUID) return null;
  const result = await platform.volume.inc(physicalDeviceUID);
  if (result.ok && onVolumeChanged) onVolumeChanged(result);
  return result;
}

/**
 * Decrease the physical speaker volume by one step.
 * No-op if no physical device UID is cached (capture not active).
 * Fires the {@link onVolumeChanged} callback with the new volume state.
 */
export async function speakerVolumeDown() {
  if (!physicalDeviceUID) return null;
  const result = await platform.volume.dec(physicalDeviceUID);
  if (result.ok && onVolumeChanged) onVolumeChanged(result);
  return result;
}

/**
 * Toggle mute on the physical speaker device.
 * No-op if no physical device UID is cached (capture not active).
 * Fires the {@link onVolumeChanged} callback with the new mute state.
 */
export async function speakerMuteToggle() {
  if (!physicalDeviceUID) return null;
  const result = await platform.volume.toggleMute(physicalDeviceUID);
  if (result.ok && onVolumeChanged) onVolumeChanged(result);
  return result;
}

/**
 * Get the current volume and mute state of the physical speaker device.
 * Returns `null` if no physical device UID is cached (capture not active).
 */
export async function speakerVolumeGet() {
  if (!physicalDeviceUID) return null;
  return platform.volume.get(physicalDeviceUID);
}

/**
 * Register a callback that fires whenever the speaker volume or mute state
 * changes (via volume keys or programmatic control). The callback receives
 * the same `{ ok, volume, muted }` object returned by the platform volume API.
 *
 * @param cb - Volume-change handler; typically broadcasts to all renderer windows.
 */
export function setOnVolumeChanged(cb: (state: any) => void): void {
  onVolumeChanged = cb;
}
