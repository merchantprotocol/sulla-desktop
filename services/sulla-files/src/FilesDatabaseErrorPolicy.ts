// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

type DatabaseError = { code?: unknown };
type HttpConflict = Error & { status: 409 };

/** Maps transaction-abort errors to the retryable conflict understood by the Files mount. */
export class FilesDatabaseErrorPolicy {
  private readonly retryableCodes = new Set(['40001', '40P01']);

  retryableConflict(error: unknown): HttpConflict | undefined {
    const code = (error as DatabaseError | null)?.code;
    if (typeof code !== 'string' || !this.retryableCodes.has(code)) return undefined;

    const conflict = new Error('Files changed concurrently or are busy; retry the write.') as HttpConflict;
    conflict.status = 409;
    return conflict;
  }
}
