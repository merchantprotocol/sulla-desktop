// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { matchesShortcutModifiers } from './shortcuts';

describe('shortcut modifier matching', () => {
  it('requires exact modifiers for Cmd+N', () => {
    // risk: unintended chat tab creation from Cmd+Shift+N (new window)
    const cmdN = { meta: true, key: 'N' } as Electron.Input;
    const cmdShiftN = { meta: true, shift: true, key: 'N' } as Electron.Input;
    expect(matchesShortcutModifiers(cmdN, { meta: true, key: 'N' })).toBe(true);
    expect(matchesShortcutModifiers(cmdShiftN, { meta: true, key: 'N' })).toBe(false);
  });
});
