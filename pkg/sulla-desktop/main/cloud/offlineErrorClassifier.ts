// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Network-unreachable markers: the laptop is offline or between networks, not a sync bug. */
export const DEFAULT_OFFLINE_PATTERNS: readonly RegExp[] = [
  /\bupstream_failed\b/i,
  /\bERR_NETWORK_CHANGED\b/,
  /\bERR_INTERNET_DISCONNECTED\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bETIMEDOUT\b/,
];

/** Decides whether a sync failure means "offline" (quiet, no error streak) or a real error. */
export class OfflineErrorClassifier {
  constructor(private readonly patterns: readonly RegExp[] = DEFAULT_OFFLINE_PATTERNS) {}

  isOffline(error: unknown): boolean {
    const text = this.textOf(error);
    return text !== '' && this.patterns.some(pattern => pattern.test(text));
  }

  // Only the code and message are inspected; the classifier never reads or logs synced data.
  private textOf(error: unknown): string {
    if (typeof error === 'string') return error;
    if (!error || typeof error !== 'object') return '';
    const { code, message } = error as { code?: unknown; message?: unknown };
    return [code, message].filter((part): part is string => typeof part === 'string').join(' ');
  }
}
