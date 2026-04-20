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

import { getDesktopDeviceMetadata, getDesktopDeviceId } from './deviceIdentity';

const console = Logging.background;

const API_BASE = 'https://sulla-workers.jonathon-44b.workers.dev';
const HEARTBEAT_INTERVAL_MS = 45_000;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let cachedDeviceId: string | null = null;

async function postJson(path: string, body: unknown): Promise<boolean> {
  try {
    const token = await getCurrentAccessToken();
    if (!token) return false;
    const res = await fetch(`${ API_BASE }${ path }`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        Authorization: `Bearer ${ token }`,
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch (err) {
    console.log(`[DevicesApi] ${ path } failed: ${ err }`);
    return false;
  }
}

export const DevicesCloudApi = {
  async register(): Promise<string | null> {
    try {
      const meta = await getDesktopDeviceMetadata();
      const ok = await postJson('/devices/register', {
        deviceId:   meta.deviceId,
        deviceType: meta.deviceType,
        platform:   meta.platform,
        model:      meta.model,
        hostname:   meta.hostname,
        name:       meta.name,
        osVersion:  meta.osVersion,
        appVersion: meta.appVersion,
      });
      if (!ok) return null;
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
      await postJson('/devices/heartbeat', { deviceId });
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

  stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    cachedDeviceId = null;
  },
};
