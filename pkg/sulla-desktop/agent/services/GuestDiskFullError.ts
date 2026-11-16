// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { InfrastructureFailure } from '../languagemodels/providerRecovery';

const DISK_FULL_PATTERN = /no space left on device|disk quota exceeded|\benospc\b/i;

/**
 * The Sulla VM data disk ran out of space. Every guest write fails the same
 * way until space is freed, so this is one clear, actionable Sulla-side
 * failure: never retried and never blamed on a model provider.
 */
export class GuestDiskFullError extends InfrastructureFailure {
  readonly guestDiskFull = true;

  constructor(cause: unknown) {
    super('Sulla\'s disk is full. Free up space in the Sulla VM (old agent workspaces, Docker images or large files) and try again.', cause);
    this.name = 'GuestDiskFullError';
  }

  /** The error a failed guest command should surface for its stderr `detail`. */
  static fromGuestFailure(detail: string, fallback: string): Error {
    const message = detail || fallback;
    return DISK_FULL_PATTERN.test(message) ? new GuestDiskFullError(new Error(message)) : new Error(message);
  }
}
