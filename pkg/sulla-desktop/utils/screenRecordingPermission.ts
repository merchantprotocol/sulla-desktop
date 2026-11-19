// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { systemPreferences } from 'electron';

export const SCREEN_RECORDING_PERMISSION_MESSAGE = 'Sulla needs Screen Recording permission: System Settings > Privacy & Security > Screen Recording > enable Sulla, then retry.';

/**
 * Reads macOS Screen Recording consent. It only reads the status; the user grants
 * the permission in System Settings, and Sulla never requests it programmatically.
 */
export class ScreenRecordingPermission {
  constructor(
    private readonly platform:NodeJS.Platform = process.platform,
    private readonly accessStatus:() => string = () => systemPreferences.getMediaAccessStatus('screen'),
  ) {}

  /** The actionable message when macOS is not granting screen capture; undefined when capture may run. */
  deniedMessage():string | undefined {
    if (this.platform !== 'darwin') return undefined;

    return this.accessStatus() === 'granted' ? undefined : SCREEN_RECORDING_PERMISSION_MESSAGE;
  }
}

/** Classifies a `screencapture` exit. Exit 1 means "cancelled" only for interactive selections. */
export class ScreencaptureExit {
  static isCancel(mode:'area' | 'window' | 'full', code:number | null):boolean {
    return code === 1 && mode !== 'full';
  }
}
