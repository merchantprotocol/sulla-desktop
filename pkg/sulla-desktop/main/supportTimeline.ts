// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import Electron from 'electron';

import { SupportStateStore } from '@pkg/main/supportState';
import { supportCloudRequest } from '@pkg/main/support/supportCloud';

export type SupportTimelineEvent = 'downloaded' | 'installed' | 'first_run_step' | 'error';

export interface SupportTimelineDeps {
  metricsConsent(): boolean;
  appVersion(): string;
  request(method: string, path: string, init: { headers: Record<string, string>; body: string }): Promise<unknown>;
}

const electronTimelineDeps: SupportTimelineDeps = {
  metricsConsent: () => new SupportStateStore(Electron.app.getPath('userData')).read().privacy.metricsConsent,
  appVersion:     () => Electron.app.getVersion(),
  request:        (method, path, init) => supportCloudRequest(method, path, init),
};

/** Best-effort support timeline delivery. It never waits for, or unlocks, the vault. */
export class SupportTimelineRecorder {
  constructor(private readonly deps: SupportTimelineDeps = electronTimelineDeps) {}

  async record(eventType: SupportTimelineEvent, data?: Record<string, unknown>): Promise<void> {
    try {
      if (!this.deps.metricsConsent()) return;
      await this.deps.request('POST', '/support/timeline', {
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ eventType, appVersion: this.deps.appVersion(), data }),
      });
    } catch { /* Metrics must never affect the app or first run. */ }
  }
}

/** Shared main-process recorder; stateless apart from its collaborators. */
export const supportTimeline = new SupportTimelineRecorder();
