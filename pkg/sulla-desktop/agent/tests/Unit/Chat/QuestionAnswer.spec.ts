// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { answerSelection } from '@pkg/pages/chat/messages/questionAnswer';

describe('question card answers', () => {
  // risk: picking an option and typing a note sent two answers to a one-answer question,
  // which Sulla rejected ("Answer could not be recorded") and the user's reply was lost
  it('folds a typed note into the chosen option for a single-choice question', () => {
    expect(answerSelection(['A. billing_admin on qa-finance only'], 'grant it for one day', false))
      .toEqual(['A. billing_admin on qa-finance only (grant it for one day)']);
  });

  it('sends the typed answer alone when no option is chosen', () => {
    expect(answerSelection([], '  test locally  ', false)).toEqual(['test locally']);
  });

  it('keeps the note as its own answer when several may be chosen', () => {
    expect(answerSelection(['A', 'B'], 'and C', true)).toEqual(['A', 'B', 'and C']);
  });
});
