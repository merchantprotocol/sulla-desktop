// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Model — speaker capture.
 * Thin wrapper around the platform provider.
 */

import * as platform from '../platform';

export function start(onLevel: (data: any) => void, opts?: { onAudio?: (data: Buffer) => void }): void {
  platform.capture.start(onLevel, opts);
}

export function stop(): void {
  platform.capture.stop();
}

export function isRunning(): boolean {
  return platform.capture.isRunning();
}
