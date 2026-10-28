// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const REFRESH_RETRY_DELAY_MS = 60 * 1000;
export const MAX_REFRESH_RETRY_DELAY_MS = 30 * 60 * 1000;

/** Retry delay after `failures` consecutive failures: 60s doubling, capped at 30min. */
export function refreshRetryDelayMs(failures: number): number {
  return Math.min(REFRESH_RETRY_DELAY_MS * 2 ** Math.max(0, failures - 1), MAX_REFRESH_RETRY_DELAY_MS);
}
