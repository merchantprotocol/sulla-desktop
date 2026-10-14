import os from 'os';

import Electron from 'electron';

import { getSettings } from '@pkg/config/settingsImpl';
import { CLOUD_API_BASE } from '@pkg/main/cloud/cloudEndpoints';
import { getInstallId } from '@pkg/main/installId';

const LAUNCH_DELAY_MS = 30_000;
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 10_000;

type PingEvent = 'launch' | 'daily';

let started = false;

function telemetryEnabled(): boolean {
  return getSettings().application.telemetry.enabled;
}

async function sendPing(event: PingEvent): Promise<void> {
  if (!telemetryEnabled()) {
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    await Electron.net.fetch(`${ CLOUD_API_BASE }/desktop/ping`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        installId:  getInstallId(Electron.app.getPath('userData')),
        appVersion: Electron.app.getVersion(),
        platform:   process.platform,
        arch:       process.arch,
        osVersion:  os.release(),
        event,
      }),
      signal: controller.signal,
    });
  } catch {
    // Anonymous telemetry must never interfere with startup or app operation.
  } finally {
    clearTimeout(timeout);
  }
}

/** Schedule the non-blocking launch ping and subsequent daily pings. */
export function startInstallPing(): void {
  if (started) {
    return;
  }
  started = true;

  const launchTimer = setTimeout(() => void sendPing('launch'), LAUNCH_DELAY_MS);
  const dailyTimer = setInterval(() => void sendPing('daily'), DAILY_INTERVAL_MS);

  launchTimer.unref();
  dailyTimer.unref();
}
