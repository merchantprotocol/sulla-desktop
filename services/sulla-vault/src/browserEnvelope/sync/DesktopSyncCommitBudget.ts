// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// How much one v3 commit may carry. The write cap is the domain's SyncLimitsPolicy;
// the byte cap stays Desktop's 1.9 MB, which sits under the domain ceiling
// (COMMIT_BYTES minus COMMIT_OVERHEAD_BYTES) so Cloud never refuses the body for size.

import { SyncLimitsPolicy } from '@sulla/domain';

export class DesktopSyncCommitBudget {
  static readonly DESKTOP_COMMIT_BYTES = 1_900_000;

  constructor(
    readonly maxWrites: number = SyncLimitsPolicy.WRITES_PER_COMMIT,
    readonly maxBytes: number = DesktopSyncCommitBudget.DESKTOP_COMMIT_BYTES,
  ) {
    if (maxWrites > SyncLimitsPolicy.WRITES_PER_COMMIT) throw new RangeError('commit write cap exceeds the domain SyncLimitsPolicy');
    if (maxBytes > SyncLimitsPolicy.COMMIT_BYTES - SyncLimitsPolicy.COMMIT_OVERHEAD_BYTES) throw new RangeError('commit byte cap exceeds the domain SyncLimitsPolicy');
  }

  /** True once no further record may be added (checked before each candidate, as the runner always did). */
  isFull(writes: number, bytes: number): boolean {
    return writes >= this.maxWrites || bytes > this.maxBytes;
  }
}
