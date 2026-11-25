// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type ProviderReportingActivity = 'status' | 'tool';
export type ProviderActivityCallback = (message: string, reportingActivity?: ProviderReportingActivity) => void;

/** Forwards complete provider activity text to the transcript callback without altering its content. */
export class ProviderToolActivityReporter {
  constructor(private readonly onActivity?: ProviderActivityCallback) {}

  report(message: string, reportingActivity?: ProviderReportingActivity): void {
    if (!message) return;
    try { this.onActivity?.(message, reportingActivity) }
    catch { /* renderer unavailable */ }
  }
}
