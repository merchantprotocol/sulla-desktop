// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: data integrity. A name with "/" (or "." / "..") would turn a rename or new folder into a move to
// another folder; an unchanged or blank rename must not submit a move at all.
import { describe, expect, it } from 'vitest';

import { FilesNameRules } from './FilesNameRules';

describe('FilesNameRules', () => {
  it('cancels a blank or unchanged rename instead of submitting a move', () => {
    expect(FilesNameRules.decideRename('a.txt', '   ')).toEqual({ kind: 'cancel' });
    expect(FilesNameRules.decideRename('a.txt', ' a.txt ')).toEqual({ kind: 'cancel' });
  });

  it('refuses path separators and dot segments with the inline message, and trims a valid name', () => {
    for (const bad of ['x/y.txt', '.', '..', '/']) expect(FilesNameRules.decideRename('a.txt', bad)).toEqual({ kind: 'invalid', message: 'Names can’t contain “/” or be “.” or “..”.' });
    expect(FilesNameRules.decideRename('a.txt', '  b.txt ')).toEqual({ kind: 'rename', name: 'b.txt' });
    expect(FilesNameRules.isSingleSegment('...')).toBe(true);
    expect(FilesNameRules.isSingleSegment('a/b')).toBe(false);
  });

  it('pre-selects a file name up to its extension, and a folder or dotfile name whole', () => {
    expect(FilesNameRules.renameSelectionEnd('report.final.pdf', false)).toBe(12);
    expect(FilesNameRules.renameSelectionEnd('my.folder', true)).toBe(9);
    expect(FilesNameRules.renameSelectionEnd('.env', false)).toBe(4);
    expect(FilesNameRules.renameSelectionEnd('README', false)).toBe(6);
  });

  it('pre-selects a dialog value before ".sulla.md" or its last extension', () => {
    expect(FilesNameRules.promptSelectionEnd('Plan.sulla.md')).toBe(4);
    expect(FilesNameRules.promptSelectionEnd('Untitled.txt')).toBe(8);
    expect(FilesNameRules.promptSelectionEnd('untitled folder')).toBe(15);
    expect(FilesNameRules.promptSelectionEnd('')).toBe(0);
  });
});
