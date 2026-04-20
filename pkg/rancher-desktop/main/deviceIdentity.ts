/**
 * Desktop device identity — generates and persists a stable device_id for
 * this install, plus gathers display metadata (hostname, macOS/Windows/Linux
 * version, Electron app version).
 *
 * Parallel to sulla-mobile's DeviceIdentity so both clients register the
 * same way with /devices/register. The cloud then shows every paired
 * device (desktop + every mobile) in the AI Assistant settings screen.
 */

import os from 'os';
import crypto from 'crypto';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getProductionVersion } from '@pkg/utils/version';

const SETTING_KEY = 'sullaCloudDeviceId';

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
  // Prefer crypto.randomUUID when available (Node 14.17+).
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
  // os.type() returns e.g. 'Darwin' — not useful. Best-effort model name:
  // fall back to "Mac" / "PC" labels; richer model detection would require
  // shelling out to system_profiler, which isn't worth the complexity here.
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

async function getOrCreateDeviceId(): Promise<string> {
  const existing = (await SullaSettingsModel.get(SETTING_KEY, '')) as string;
  if (existing) return existing;
  const fresh = generateDeviceId();
  await SullaSettingsModel.set(SETTING_KEY, fresh, 'string');
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
