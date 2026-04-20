/**
 * Desktop device identity — generates and persists a stable device_id for
 * this install, plus gathers display metadata (hostname, macOS/Windows/Linux
 * version, Electron app version).
 *
 * Parallel to sulla-mobile's DeviceIdentity so both clients register the
 * same way with /devices/register. The cloud then shows every paired
 * device (desktop + every mobile) in the AI Assistant settings screen.
 *
 * Persistence: the device_id lives in ~/.sulla/device-id, outside Electron's
 * userData directory. This survives app reinstalls and upgrades (mobile uses
 * SecureStore for the same reason — without this, a reinstall mints a fresh
 * UUID and the server sees a duplicate desktop in the devices list).
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getProductionVersion } from '@pkg/utils/version';

const LEGACY_SETTING_KEY = 'sullaCloudDeviceId';
const SULLA_DIR = path.join(os.homedir(), '.sulla');
const DEVICE_ID_PATH = path.join(SULLA_DIR, 'device-id');

export interface DesktopDeviceMetadata {
  deviceId: string;
  deviceType: 'desktop';
  platform: 'macos' | 'windows' | 'linux';
  model: string | null;
  hostname: string;
  name: string;
  osVersion: string | null;
  appVersion: string | null;
}

function generateDeviceId(): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function normalizePlatform(): DesktopDeviceMetadata['platform'] {
  const p = os.platform();
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  return 'linux';
}

function macProductName(): string | null {
  const platform = normalizePlatform();
  if (platform === 'macos') return 'Mac';
  if (platform === 'windows') return 'PC';
  return 'Linux box';
}

function osVersionLabel(): string {
  const platform = normalizePlatform();
  const release = os.release();
  if (platform === 'macos') return `macOS ${release}`;
  if (platform === 'windows') return `Windows ${release}`;
  return `${os.type()} ${release}`;
}

function readDeviceIdFromFile(): string | null {
  try {
    if (!fs.existsSync(DEVICE_ID_PATH)) return null;
    const raw = fs.readFileSync(DEVICE_ID_PATH, 'utf-8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

function writeDeviceIdToFile(id: string): void {
  try {
    fs.mkdirSync(SULLA_DIR, { recursive: true });
    // 0o600 — readable only by the owning user. The UUID isn't secret but
    // there's no reason for other users on a shared machine to see it.
    fs.writeFileSync(DEVICE_ID_PATH, id, { mode: 0o600 });
  } catch (err) {
    console.warn('[deviceIdentity] Failed to persist device-id to ~/.sulla:', err);
  }
}

async function readLegacyDeviceId(): Promise<string | null> {
  try {
    const existing = (await SullaSettingsModel.get(LEGACY_SETTING_KEY, '')) as string;
    return existing || null;
  } catch {
    return null;
  }
}

async function getOrCreateDeviceId(): Promise<string> {
  // Preferred: the reinstall-safe file in ~/.sulla.
  const fromFile = readDeviceIdFromFile();
  if (fromFile) return fromFile;

  // Legacy: previous installs stored the id in SullaSettings (inside the
  // Electron userData dir). Migrate it out so the id survives future
  // reinstalls. If migration succeeds we keep writing there too, which is
  // harmless but lets older code paths keep working during rollout.
  const legacy = await readLegacyDeviceId();
  if (legacy) {
    writeDeviceIdToFile(legacy);
    return legacy;
  }

  const fresh = generateDeviceId();
  writeDeviceIdToFile(fresh);
  try { await SullaSettingsModel.set(LEGACY_SETTING_KEY, fresh, 'string'); } catch {}
  return fresh;
}

/**
 * Collect the full device metadata payload expected by the server's
 * /devices/register endpoint.
 */
export async function getDesktopDeviceMetadata(): Promise<DesktopDeviceMetadata> {
  const deviceId = await getOrCreateDeviceId();
  const hostname = os.hostname();
  return {
    deviceId,
    deviceType: 'desktop',
    platform: normalizePlatform(),
    model: macProductName(),
    hostname,
    name: hostname || macProductName() || 'Sulla Desktop',
    osVersion: osVersionLabel(),
    appVersion: getProductionVersion(),
  };
}

export async function getDesktopDeviceId(): Promise<string> {
  return getOrCreateDeviceId();
}
