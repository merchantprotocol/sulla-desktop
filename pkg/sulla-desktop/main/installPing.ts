// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import os from 'os';

import Electron from 'electron';

import { getSettings } from '@pkg/config/settingsImpl';
import { CLOUD_API_BASE } from '@pkg/main/cloud/cloudEndpoints';
import { InstallIdStore } from '@pkg/main/installId';
import { supportTimeline } from '@pkg/main/supportTimeline';

export type PingEvent = 'launch' | 'daily';

export interface InstallPingDeps {
  telemetryEnabled(): boolean;
  recordInstalled(): void;
  installId(): string;
  appVersion(): string;
  fetch(url: string, init: RequestInit): Promise<unknown>;
}

const electronPingDeps: InstallPingDeps = {
  telemetryEnabled: () => getSettings().application.telemetry.enabled,
  recordInstalled:  () => { void supportTimeline.record('installed', { platform: process.platform, arch: process.arch }) },
  installId:        () => new InstallIdStore(Electron.app.getPath('userData')).get(),
  appVersion:       () => Electron.app.getVersion(),
  fetch:            (url, init) => Electron.net.fetch(url, init),
};

/** Anonymous install telemetry: one launch ping after a delay, then one ping a day. */
export class InstallPingScheduler {
  static readonly LAUNCH_DELAY_MS = 30_000;
  static readonly DAILY_INTERVAL_MS = 24 * 60 * 60 * 1_000;
  static readonly REQUEST_TIMEOUT_MS = 10_000;

  private started = false;

  constructor(private readonly deps: InstallPingDeps = electronPingDeps) {}

  async send(event: PingEvent): Promise<void> {
    if (event === 'launch') this.deps.recordInstalled();
    if (!this.deps.telemetryEnabled()) {
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), InstallPingScheduler.REQUEST_TIMEOUT_MS);

    try {
      await this.deps.fetch(`${ CLOUD_API_BASE }/desktop/ping`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          installId:  this.deps.installId(),
          appVersion: this.deps.appVersion(),
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

  /** Schedule the non-blocking launch ping and subsequent daily pings. Repeat calls do nothing. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    const launchTimer = setTimeout(() => void this.send('launch'), InstallPingScheduler.LAUNCH_DELAY_MS);
    const dailyTimer = setInterval(() => void this.send('daily'), InstallPingScheduler.DAILY_INTERVAL_MS);

    launchTimer.unref();
    dailyTimer.unref();
  }
}

/** Shared main-process scheduler; `start()` is idempotent on this instance. */
export const installPing = new InstallPingScheduler();
