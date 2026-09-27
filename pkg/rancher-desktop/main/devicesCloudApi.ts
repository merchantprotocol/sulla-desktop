/**
 * Devices API client for Sulla Desktop — talks to sulla-workers /devices/*
 * endpoints.
 *
 * On sign-in: register this desktop and start a 45s heartbeat.
 * On sign-out: stop the heartbeat (last_seen_at stops advancing, the server
 * marks us offline after ~2 minutes).
 */

import { getCurrentAccessToken } from '@pkg/main/sullaCloudAuth';
import Logging from '@pkg/utils/logging';

import { getCloudPreferences } from './cloud/cloudSettings';
import { getDevicePublicKey } from './cloud/deviceKey';
import { getDesktopDeviceMetadata, getDesktopDeviceId } from './deviceIdentity';

const console = Logging.background;

const API_BASE = 'https://sulla-workers.merchantprotocol.workers.dev';
const HEARTBEAT_INTERVAL_MS = 45_000;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let cachedDeviceId: string | null = null;

/** What the cloud last told us about this desktop's standing. */
export interface CloudDeviceState {
  registered: boolean;
  revoked:    boolean;
  /** Registration refused (e.g. device key mismatch / owned by another account). */
  error?:     string;
}
let deviceState: CloudDeviceState = { registered: false, revoked: false };
const stateListeners: Array<(s: CloudDeviceState) => void> = [];

function setDeviceState(next: CloudDeviceState) {
  const changed = JSON.stringify(next) !== JSON.stringify(deviceState);
  deviceState = next;
  if (changed) for (const l of stateListeners) { try { l(next); } catch { /* ignore */ } }
}

/** Remote-access + sync switches reported with every register/heartbeat. */
async function reportedPreferences(): Promise<{ remoteAccess: 'enabled' | 'disabled'; syncSettings: Record<string, boolean> } | Record<string, never>> {
  try {
    const p = await getCloudPreferences();
    return { remoteAccess: p.remoteAccess ? 'enabled' : 'disabled', syncSettings: { conversations: p.conversations, vault: p.vault, projects: p.projects } };
  } catch {
    return {};
  }
}

// The 45s heartbeat retries forever, so an unreachable cloud logged the same
// failure ~1,900×/day. Log the first failure per endpoint, then every 40th,
// and announce recovery.
const failCounts = new Map<string, number>();

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const token = await getCurrentAccessToken();
    if (!token) return { ok: false, status: 0, data: null };
    const res = await fetch(`${ API_BASE }${ path }`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        Authorization: `Bearer ${ token }`,
      },
      body: JSON.stringify(body),
    });
    const n = failCounts.get(path);

    if (n && n > 1) {
      console.log(`[DevicesApi] ${ path } recovered after ${ n } consecutive failures`);
    }
    failCounts.delete(path);
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    const n = (failCounts.get(path) ?? 0) + 1;

    failCounts.set(path, n);
    if (n === 1 || n % 40 === 0) {
      console.log(`[DevicesApi] ${ path } failed: ${ err }${ n > 1 ? ` (${ n } consecutive failures, logging every 40th)` : '' }`);
    }
    return { ok: false, status: 0, data: null };
  }
}

export const DevicesCloudApi = {
  async register(): Promise<string | null> {
    try {
      const meta = await getDesktopDeviceMetadata();
      const res = await postJson('/devices/register', {
        deviceId:   meta.deviceId,
        deviceType: meta.deviceType,
        platform:   meta.platform,
        model:      meta.model,
        hostname:   meta.hostname,
        name:       meta.name,
        osVersion:  meta.osVersion,
        appVersion: meta.appVersion,
        // Ed25519 public key; the private half never leaves ~/.sulla.
        publicKey:  getDevicePublicKey(),
        ...(await reportedPreferences()),
      });
      if (!res.ok) {
        if (res.status === 409) {
          console.warn(`[DevicesApi] register refused: ${ res.data?.error }`);
          setDeviceState({ registered: false, revoked: false, error: res.data?.error || 'registration_refused' });
        }
        return null;
      }
      setDeviceState({ registered: true, revoked: !!res.data?.revoked });
      cachedDeviceId = meta.deviceId;
      console.log(`[DevicesApi] registered ${ meta.deviceId }`);
      return meta.deviceId;
    } catch (err) {
      console.log(`[DevicesApi] register failed: ${ err }`);
      return null;
    }
  },

  async heartbeat(): Promise<void> {
    try {
      const deviceId = cachedDeviceId ?? (await getDesktopDeviceId());
      cachedDeviceId = deviceId;
      const res = await postJson('/devices/heartbeat', { deviceId, ...(await reportedPreferences()) });
      if (res.ok && typeof res.data?.revoked === 'boolean' && res.data.revoked !== deviceState.revoked) {
        setDeviceState({ ...deviceState, revoked: res.data.revoked });
      }
    } catch {
      // Next tick will retry.
    }
  },

  /**
   * Start the 45s heartbeat. Idempotent — safe to call repeatedly.
   */
  startHeartbeat(): void {
    if (heartbeatTimer) return;
    // Fire immediately so the cloud sees us online right away.
    void DevicesCloudApi.heartbeat();
    heartbeatTimer = setInterval(() => {
      void DevicesCloudApi.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  },

  getState(): CloudDeviceState {
    return deviceState;
  },

  onStateChange(listener: (s: CloudDeviceState) => void): () => void {
    stateListeners.push(listener);
    return () => {
      const i = stateListeners.indexOf(listener);
      if (i >= 0) stateListeners.splice(i, 1);
    };
  },

  stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    cachedDeviceId = null;
  },
};
