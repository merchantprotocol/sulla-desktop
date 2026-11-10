// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { splitForSynthesis } from './speechText';

describe('splitForSynthesis', () => {
  it('starts with a short chunk and preserves every spoken word in order', () => {
    // risk: core business logic — a truncation or reorder would silently lose spoken reply content.
    const text = 'Here is a realistic spoken reply that should begin quickly, while the full answer follows.';
    const parts = splitForSynthesis(text);

    expect(parts[0].length).toBeLessThanOrEqual(50);
    expect(parts[0].trim().split(/\s+/).length).toBeGreaterThanOrEqual(6);
    expect(parts.join(' ').replace(/\s+/g, ' ').trim()).toBe(text);
  });
});
