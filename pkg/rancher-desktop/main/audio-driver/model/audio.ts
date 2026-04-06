/**
 * Model — audio capture state.
 *
 * Tracks whether capture is running and which devices are active.
 * Persists the toggle state so the app boots in the same position.
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';

const PREFS_FILE = path.join(app.getPath('userData'), 'audio-driver-preferences.json');

const state = {
  running:     false,
  message:     'Off',
  micName:     '',
  speakerName: '',
};

function loadPrefs(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function savePrefs(prefs: Record<string, any>): void {
  try {
    const dir = path.dirname(PREFS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch { /* best effort */ }
}

export function getState() {
  return { ...state };
}

export function start() {
  state.running = true;
  state.message = 'Capturing';
  savePrefs({ ...loadPrefs(), enabled: true });
  return { ...state };
}

export function stop() {
  state.running = false;
  state.message = 'Off';
  savePrefs({ ...loadPrefs(), enabled: false });
  return { ...state };
}

export function isEnabled(): boolean {
  const prefs = loadPrefs();
  return prefs.enabled !== false;
}

export function setDeviceNames(micName: string, speakerName: string): void {
  state.micName = micName;
  state.speakerName = speakerName;
}
