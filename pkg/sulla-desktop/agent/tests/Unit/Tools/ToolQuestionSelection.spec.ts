// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { ToolQuestionSelection, type ToolQuestionSelectionSource } from '../../../../pages/chat/components/tool/ToolQuestionSelection';

describe('ToolQuestionSelection', () => {
  it('toggles one choice, preserves multiple choices, and locks answered questions', () => {
    // risk: data accuracy — selections sent with a question answer must match the user's choices.
    let locked = false;
    const source: ToolQuestionSelectionSource = {
      msg: {
        id: 'question', status: 'pending', questions: [
          { question: 'Single?', options: [{ label: 'A' }, { label: 'B' }] },
          { question: 'Many?', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
        ],
      } as any,
    };
    const picks = [[], []] as string[][];
    const otherText = ['', ''];
    const customSelected = [false, false];
    const selection = new ToolQuestionSelection(() => source, picks, otherText, customSelected, () => locked);

    selection.toggle(0, 'A', false);
    selection.toggle(0, 'B', false);
    selection.toggle(1, 'X', true);
    selection.toggle(1, 'Y', true);
    expect(picks).toEqual([['B'], ['X', 'Y']]);
    expect(selection.isPicked(0, 'B')).toBe(true);

    locked = true;
    selection.toggle(0, 'A', false);
    expect(picks).toEqual([['B'], ['X', 'Y']]);
  });
});
