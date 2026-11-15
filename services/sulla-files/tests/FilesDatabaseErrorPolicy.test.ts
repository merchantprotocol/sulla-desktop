// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { FilesDatabaseErrorPolicy } from '../src/FilesDatabaseErrorPolicy.js';

describe('FilesDatabaseErrorPolicy', () => {
  const policy = new FilesDatabaseErrorPolicy();

  it('turns transaction deadlocks and serialization aborts into retryable mount conflicts', () => {
    // risk: data integrity — transient rolled-back writes must be retried, not surfaced as generic EIO.
    for (const code of ['40P01', '40001']) {
      const conflict = policy.retryableConflict({ code });
      expect(conflict?.status).toBe(409);
      expect(conflict?.message).toContain('concurrently or are busy');
    }
  });

  it('leaves permanent and non-database errors untouched', () => {
    expect(policy.retryableConflict({ code: '23505' })).toBeUndefined();
    expect(policy.retryableConflict(new Error('network failed'))).toBeUndefined();
    expect(policy.retryableConflict(null)).toBeUndefined();
  });
});
