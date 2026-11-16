// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: data integrity. The selection decides which files a Move, Copy, Trash or permanent delete acts on;
// a Shift range that grows past its anchor, drops a row, or forgets the Cmd/Ctrl-additive rule would make a
// bulk action hit files the user never selected.
import { describe, expect, it } from 'vitest';

import { FilesSelectionRange } from './FilesSelectionRange';

const keys = ['a', 'b', 'c', 'd', 'e'];

describe('FilesSelectionRange', () => {
  it('selects from the anchor to the clicked row inclusive, in display order, whichever direction', () => {
    expect(FilesSelectionRange.between(keys, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(FilesSelectionRange.between(keys, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(FilesSelectionRange.between(keys, 'c', 'c')).toEqual(['c']);
  });

  it('refuses a range when the anchor or the target is no longer displayed', () => {
    expect(FilesSelectionRange.between(keys, 'gone', 'c')).toBeNull();
    expect(FilesSelectionRange.between(keys, 'a', 'gone')).toBeNull();
    expect(FilesSelectionRange.between([], 'a', 'a')).toBeNull();
  });

  it('replaces the selection with a plain Shift range and adds to it with Cmd/Ctrl+Shift', () => {
    const existing = new Set(['e']);

    expect([...FilesSelectionRange.extend(existing, ['a', 'b'], false)]).toEqual(['a', 'b']);
    expect([...FilesSelectionRange.extend(existing, ['a', 'b'], true)].sort()).toEqual(['a', 'b', 'e']);
    expect([...existing]).toEqual(['e']);
  });

  it('toggles one key without mutating the current selection', () => {
    const existing = new Set(['a', 'b']);

    expect([...FilesSelectionRange.toggle(existing, 'b')]).toEqual(['a']);
    expect([...FilesSelectionRange.toggle(existing, 'c')].sort()).toEqual(['a', 'b', 'c']);
    expect([...existing].sort()).toEqual(['a', 'b']);
  });
});
