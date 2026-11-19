// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { systemPreferences } from 'electron';

export const SCREEN_RECORDING_PERMISSION_MESSAGE = 'Sulla needs Screen Recording permission: System Settings > Privacy & Security > Screen Recording > enable Sulla, then retry.';

export type ScreenAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

/**
 * Pre-checks macOS Screen Recording permission before any capture. Without the grant,
 * screencapture and desktopCapturer fail in ways that look like a user cancel, so callers
 * ask this first and return the actionable message instead. Never requests the permission.
 */
export class ScreenRecordingPermission {
  constructor(
    private readonly platform:NodeJS.Platform = process.platform,
    private readonly readStatus:() => ScreenAccessStatus = () => systemPreferences.getMediaAccessStatus('screen') as ScreenAccessStatus,
  ) {}

  /** The actionable error when capture would be blocked on this Mac, otherwise undefined. */
  blockedReason():string | undefined {
    if (this.platform !== 'darwin') return undefined;

    const status = this.readStatus();
    // not-determined must fall through so macOS can show its own permission prompt on first capture.
    return status === 'denied' || status === 'restricted' ? SCREEN_RECORDING_PERMISSION_MESSAGE : undefined;
  }
}
