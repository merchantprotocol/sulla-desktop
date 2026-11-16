// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// risk: irreversible side effects. The row shortcuts include Trash, paste (move) and rename; a reordered or
// widened rule could trash files on a held Backspace, delete inside Trash, or rename where Enter should open.
// These cases pin the first-match order and the macOS/other-platform split the browser has always had.
import { describe, expect, it } from 'vitest';

import { FilesEntryKeyMap, type FilesEntryKeyContext, type FilesKeyPress } from './FilesEntryKeyMap';

const press = (key:string, extra:Partial<FilesKeyPress> = {}):FilesKeyPress => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, repeat: false, ...extra });
const mac:FilesEntryKeyContext = { isMac: true, quickLookOpen: false, canPaste: true, inTrash: false };
const pc:FilesEntryKeyContext = { ...mac, isMac: false };

describe('FilesEntryKeyMap', () => {
  it('renames with Enter on macOS and F2 elsewhere, and opens with Enter elsewhere', () => {
    expect(FilesEntryKeyMap.resolve(press('Enter'), mac)).toBe('rename');
    expect(FilesEntryKeyMap.resolve(press('F2'), mac)).toBeNull();
    expect(FilesEntryKeyMap.resolve(press('F2'), pc)).toBe('rename');
    expect(FilesEntryKeyMap.resolve(press('Enter'), pc)).toBe('activate');
    expect(FilesEntryKeyMap.resolve(press('ArrowDown', { metaKey: true }), mac)).toBe('activate');
  });

  it('never trashes on a held key, on a bare Backspace, or inside Trash', () => {
    expect(FilesEntryKeyMap.resolve(press('Delete', { repeat: true }), mac)).toBe('ignore-repeat');
    expect(FilesEntryKeyMap.resolve(press('Backspace', { repeat: true, metaKey: true }), mac)).toBe('ignore-repeat');
    expect(FilesEntryKeyMap.resolve(press('Backspace'), mac)).toBeNull();
    expect(FilesEntryKeyMap.resolve(press('Backspace', { metaKey: true }), mac)).toBe('trash');
    expect(FilesEntryKeyMap.resolve(press('Delete'), pc)).toBe('trash');
    expect(FilesEntryKeyMap.resolve(press('Delete'), { ...pc, inTrash: true })).toBeNull();
  });

  it('pastes only when the clipboard may be pasted here', () => {
    expect(FilesEntryKeyMap.resolve(press('v', { ctrlKey: true }), pc)).toBe('paste');
    expect(FilesEntryKeyMap.resolve(press('v', { ctrlKey: true }), { ...pc, canPaste: false })).toBeNull();
    expect(FilesEntryKeyMap.resolve(press('C', { metaKey: true }), mac)).toBe('copy');
    expect(FilesEntryKeyMap.resolve(press('x', { metaKey: true }), mac)).toBe('cut');
    expect(FilesEntryKeyMap.resolve(press('a', { ctrlKey: true }), pc)).toBe('select-all');
  });

  it('keeps undo and go-to-parent ahead of an open Quick Look, which receives every other key', () => {
    const looking = { ...mac, quickLookOpen: true };

    expect(FilesEntryKeyMap.resolve(press('z', { metaKey: true }), looking)).toBe('undo');
    expect(FilesEntryKeyMap.resolve(press('z', { metaKey: true, shiftKey: true }), looking)).toBe('quick-look-keys');
    expect(FilesEntryKeyMap.resolve(press('ArrowUp', { ctrlKey: true }), looking)).toBe('open-parent');
    expect(FilesEntryKeyMap.resolve(press('ArrowRight'), looking)).toBe('quick-look-keys');
    expect(FilesEntryKeyMap.resolve(press('Delete'), looking)).toBe('quick-look-keys');
  });

  it('moves focus with the arrows, opens Quick Look with a bare Space, and clears or opens the menu', () => {
    expect(FilesEntryKeyMap.resolve(press('ArrowDown'), pc)).toBe('next');
    expect(FilesEntryKeyMap.resolve(press('ArrowRight'), pc)).toBe('next');
    expect(FilesEntryKeyMap.resolve(press('ArrowUp'), pc)).toBe('previous');
    expect(FilesEntryKeyMap.resolve(press('ArrowLeft'), pc)).toBe('previous');
    expect(FilesEntryKeyMap.resolve(press(' '), pc)).toBe('quick-look');
    expect(FilesEntryKeyMap.resolve(press(' ', { ctrlKey: true }), pc)).toBeNull();
    expect(FilesEntryKeyMap.resolve(press('Escape'), pc)).toBe('clear-selection');
    expect(FilesEntryKeyMap.resolve(press('ContextMenu'), pc)).toBe('menu');
    expect(FilesEntryKeyMap.resolve(press('F10', { shiftKey: true }), pc)).toBe('menu');
    expect(FilesEntryKeyMap.resolve(press('q'), pc)).toBeNull();
  });
});
