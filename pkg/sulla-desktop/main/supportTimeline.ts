// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import Electron from 'electron';

import { CLOUD_API_BASE } from '@pkg/main/cloud/cloudEndpoints';
import { SupportStateStore } from '@pkg/main/supportState';
import { getCurrentAccessToken, isCloudSignedIn } from '@pkg/main/sullaCloudAuth';

/** Best-effort support timeline delivery. It never waits for, or unlocks, the vault. */
export async function recordSupportTimeline(eventType: 'downloaded' | 'installed' | 'first_run_step' | 'error', data?: Record<string, unknown>): Promise<void> {
  try {
    if (!new SupportStateStore(Electron.app.getPath('userData')).read().privacy.metricsConsent || !await isCloudSignedIn()) return;
    const token = await getCurrentAccessToken();
    if (!token) return;
    await Electron.net.fetch(`${ CLOUD_API_BASE }/support/timeline`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ token }` },
      body: JSON.stringify({ eventType, appVersion: Electron.app.getVersion(), data }),
    });
  } catch { /* Metrics must never affect the app or first run. */ }
}
