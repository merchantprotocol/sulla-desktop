// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { DesktopSnapshotRegistry } from '../../../tools/desktop/DesktopSnapshotRegistry';
import { DesktopTargetPolicy } from '../../../tools/desktop/DesktopTargetPolicy';

describe('desktop tool state classes', () => {
  it('isolates snapshot owners and clears them on dispose', () => {
    const first = new DesktopSnapshotRegistry();
    const second = new DesktopSnapshotRegistry();
    first.remember('s1', { app: 'Calculator', windowId: 'w1' });
    expect(second.lookup('s1')).toBeUndefined();
    expect(first.lookup('s1')).toEqual({ app: 'Calculator', windowId: 'w1' });
    first.dispose();
    expect(first.lookup('s1')).toBeUndefined();
  });

  it('keeps the sealed-wallet target deny list case-insensitive', () => {
    const policy = new DesktopTargetPolicy();
    expect(policy.isBlocked('BITWARDEN')).toBe(true);
    expect(policy.isBlocked('localhost:4777')).toBe(true);
    expect(policy.isBlocked('Calculator')).toBe(false);
  });
});
