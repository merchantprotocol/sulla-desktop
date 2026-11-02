// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import Electron from 'electron';

import { SupportStateStore } from '@pkg/main/supportState';
import { cloudRequest } from '@pkg/main/cloud/cloudFetch';
import { isCloudSignedIn } from '@pkg/main/sullaCloudAuth';

/** Best-effort support timeline delivery. It never waits for, or unlocks, the vault. */
export async function recordSupportTimeline(eventType: 'downloaded' | 'installed' | 'first_run_step' | 'error', data?: Record<string, unknown>): Promise<void> {
  try {
    if (!new SupportStateStore(Electron.app.getPath('userData')).read().privacy.metricsConsent || !await isCloudSignedIn()) return;
    await cloudRequest('POST', '/support/timeline', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventType, appVersion: Electron.app.getVersion(), data }),
    });
  } catch { /* Metrics must never affect the app or first run. */ }
}
