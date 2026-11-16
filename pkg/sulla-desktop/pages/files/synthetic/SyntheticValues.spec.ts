// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: data integrity. Folder subtree signatures are the CAS guard for folder Replace and
// cross-collection moves; a wrong SHA-256 or key-order-dependent JSON would let a stale tree pass.
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SyntheticValues } from './SyntheticValues';

describe('SyntheticValues', () => {
  it('matches the standard SHA-256 across empty, single-block, multi-block and non-ASCII input', () => {
    for (const input of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'x'.repeat(1000), 'Résumé · 文件 📁']) {
      expect(SyntheticValues.sha256(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'));
    }
  });

  it('serializes objects with sorted keys at every depth but keeps array order', () => {
    expect(SyntheticValues.canonical({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
    expect(SyntheticValues.canonical({ x: 1, y: 2 })).toBe(SyntheticValues.canonical({ y: 2, x: 1 }));
  });

  it('clones deeply so the copy cannot alter the original', () => {
    const original = { folder: { path: 'A', revision: '1' } };
    const copy = SyntheticValues.clone(original);

    copy.folder.revision = '2';
    expect(original.folder.revision).toBe('1');
  });
});
