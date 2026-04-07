/**
 * @module audio-driver/model/audio
 *
 * # Audio Capture State Model
 *
 * Singleton in-memory state that tracks whether audio capture is currently
 * running and which mic/speaker device names are active. The `running` flag
 * is persisted to `audio-driver-preferences.json` in the Electron userData
 * directory so the app can restore the user's last toggle position on reboot.
 *
 * This module is purely a data store -- it does not start or stop any audio
 * hardware. The controller (`controller/lifecycle.ts`) and init module
 * (`init.ts`) call {@link start} and {@link stop} to update state after
 * the actual hardware operations succeed.
 *
 * Preferences file location:
 *   `~/Library/Application Support/sulla-desktop/audio-driver-preferences.json`
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';

/** Path to the JSON file where the enabled/disabled preference is persisted. */
const PREFS_FILE = path.join(app.getPath('userData'), 'audio-driver-preferences.json');

/** In-memory capture state. Shallow-cloned on every public read to prevent mutation. */
const state = {
  running:     false,
  message:     'Off',
  micName:     '',
  speakerName: '',
};

/** Load preferences from disk. Returns empty object if file is missing or corrupt. */
function loadPrefs(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

/** Persist preferences to disk. Best-effort; failures are silently ignored. */
function savePrefs(prefs: Record<string, any>): void {
  try {
    const dir = path.dirname(PREFS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch { /* best effort */ }
}

/**
 * Return a shallow clone of the current capture state.
 * @returns `{ running, message, micName, speakerName }`
 */
export function getState() {
  return { ...state };
}

/**
 * Mark capture as running and persist the `enabled: true` preference.
 * Called by `init.ts` after the hardware capture has successfully started.
 * @returns A shallow clone of the updated state.
 */
export function start() {
  state.running = true;
  state.message = 'Capturing';
  savePrefs({ ...loadPrefs(), enabled: true });
  return { ...state };
}

/**
 * Mark capture as stopped and persist the `enabled: false` preference.
 * Called by `init.ts` after the hardware capture has been torn down.
 * @returns A shallow clone of the updated state.
 */
export function stop() {
  state.running = false;
  state.message = 'Off';
  savePrefs({ ...loadPrefs(), enabled: false });
  return { ...state };
}

/**
 * Check the persisted preference to determine if capture should auto-start.
 * Defaults to `true` if no preference file exists (first run).
 */
export function isEnabled(): boolean {
  const prefs = loadPrefs();
  return prefs.enabled !== false;
}

/**
 * Store the human-readable names of the currently active mic and speaker
 * devices. Called by the renderer after `getUserMedia` resolves so the main
 * process state reflects what the user sees in device dropdowns.
 *
 * @param micName     - e.g. `"MacBook Pro Microphone"`
 * @param speakerName - e.g. `"MacBook Pro Speakers"`
 */
export function setDeviceNames(micName: string, speakerName: string): void {
  state.micName = micName;
  state.speakerName = speakerName;
}
