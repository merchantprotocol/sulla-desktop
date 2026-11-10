// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export interface ReviewUpdate { id: string; status: 'acknowledged' | 'fixed' | 'wont_fix'; commit?: string; reason?: string }

/** Validates review closure claims without I/O. */
export class ReviewItemClosureValidator {
  validate(updates: ReviewUpdate[], validOpenIds: string[]): string | null {
    const valid = new Set(validOpenIds);
    for (const update of updates) {
      if (!valid.has(update.id)) return `Unknown review item "${update.id}". Valid open ids: ${validOpenIds.join(', ') || '(none)'}.`;
      if (update.status === 'fixed' && !/^[a-f0-9]{7,40}$/i.test(update.commit ?? '')) return `Review item ${update.id} requires a 7–40 character hexadecimal commit sha to mark fixed.`;
      if (update.status === 'wont_fix' && !update.reason?.trim()) return `Review item ${update.id} requires a non-empty reason to mark wont_fix.`;
    }
    return null;
  }
}
