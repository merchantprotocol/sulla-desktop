/**
 * @module audio-driver/model/audio
 *
 * # Audio Driver Persistence
 *
 * Persistence-only module for audio driver preferences.
 * The `enabled` flag is persisted to `audio-driver-preferences.json` in the
 * Electron userData directory so the app can restore the user's last state.
 *
 * All in-memory state is owned by {@link MicrophoneDriverController / SpeakerDriverController}.
 * This module only handles disk I/O and device name storage.
 *
 * Preferences file location:
 *   `~/Library/Application Support/sulla-desktop/audio-driver-preferences.json`
 */

import fs from 'fs';
import path from 'path';

import { app } from 'electron';

/** Path to the JSON file where the enabled/disabled preference is persisted. */
const PREFS_FILE = path.join(app.getPath('userData'), 'audio-driver-preferences.json');

/** Device names stored in memory for quick access. */
let micName = '';
let speakerName = '';

/** Load preferences from disk. Returns empty object if file is missing or corrupt. */
export function loadPrefs(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

/** Persist preferences to disk. Best-effort; failures are silently ignored. */
export function savePrefs(prefs: Record<string, any>): void {
  try {
    const dir = path.dirname(PREFS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch { /* best effort */ }
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
 * devices. Called by the controller after mic starts.
 */
export function setDeviceNames(mic: string, speaker: string): void {
  micName = mic;
  speakerName = speaker;
}

/** Get stored device names. */
export function getDeviceNames(): { micName: string; speakerName: string } {
  return { micName, speakerName };
}
