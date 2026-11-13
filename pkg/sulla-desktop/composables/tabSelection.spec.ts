// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { selectTabAfterRemoval } from './tabSelection';

describe('selectTabAfterRemoval', () => {
  it('moves to the next tab when the active middle tab is closed', () => {
    // risk: core business logic — wrong neighbour would jump the user to an unrelated conversation.
    const before = ['a', 'b', 'c', 'd'];
    expect(selectTabAfterRemoval(before, 'b', ['a', 'c', 'd'])).toBe('c');
  });

  it('falls back to the previous tab when the last tab is closed', () => {
    // risk: core business logic — closing the last tab must not leave the view blank.
    const before = ['a', 'b', 'c'];
    expect(selectTabAfterRemoval(before, 'c', ['a', 'b'])).toBe('b');
  });

  it('skips tabs that were removed at the same time when picking a neighbour', () => {
    // risk: core business logic — batch removals (agent tab cleanup) must not point at a dead id.
    const before = ['a', 'b', 'c', 'd'];
    expect(selectTabAfterRemoval(before, 'b', ['a', 'd'])).toBe('d');
  });

  it('uses the first remaining tab when the removed id was not in the captured order', () => {
    // risk: core business logic — an unknown active id must still resolve to a live tab.
    expect(selectTabAfterRemoval(['a', 'b'], 'ghost', ['b', 'a'])).toBe('a');
  });

  it('returns null when no tabs remain so the caller opens a fresh chat tab', () => {
    // risk: core business logic — with zero tabs the screen must get a new tab, not stay blank.
    expect(selectTabAfterRemoval(['a'], 'a', [])).toBeNull();
  });
});
