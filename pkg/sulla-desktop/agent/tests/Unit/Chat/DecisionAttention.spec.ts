// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { DecisionAttention } from '@pkg/shared/decisionAttention';
const question: any = { kind: 'question', status: 'expired', attention: 'active', expiresAt: 1 };
describe('For You attention lifetime', () => {
  it('keeps a question active after its waiter deadline until answered or dismissed', () => {
    expect(DecisionAttention.active(question, 1000)).toBe(true); expect(DecisionAttention.label(question, 1000)).toBe('Needs your answer');
    for (const attention of ['dismissed', 'answered']) expect(DecisionAttention.active({ ...question, attention }, 1000)).toBe(false);
    expect(DecisionAttention.active({ ...question, status: 'answered' }, 1000)).toBe(false);
  });
  it('never revives an expired approval and preserves ambiguous legacy questions as history', () => {
    expect(DecisionAttention.active({ ...question, kind: 'approval' }, 1000)).toBe(false);
    expect(DecisionAttention.active({ ...question, attention: undefined }, 1000)).toBe(false);
    expect(DecisionAttention.active({ ...question, status: 'pending', attention: undefined }, 1000)).toBe(true);
  });
  it('moves only an older expired exact copy behind a newer saved answer without mutating records', () => {
    const older: any = {
      ...question,
      id:             'old',
      title:          'Review scope',
      conversationId: 'chat',
      channel:        'sulla',
      createdAt:      10,
      questions:      [{ question: 'Ship this scope?', options: [{ label: 'Yes', description: 'This scope only' }] }],
    };
    const answered = {
      ...older,
      id:             'new',
      createdAt:      20,
      attention:      'answered',
      answerDelivery: 'processing',
      answers:        [{ question: 'Ship this scope?', selected: ['Yes'] }],
    };
    const shown = DecisionAttention.present([older, answered]);
    expect(shown[0].supersededBy).toBe('new');
    expect(DecisionAttention.active(shown[0])).toBe(false);
    expect(DecisionAttention.label(shown[0])).toBe('Duplicate request');
    expect(older.supersededBy).toBeUndefined();
    expect(older.answers).toBeUndefined();
    for (const change of [{ conversationId: 'other' }, { channel: 'other' }, { title: 'Different scope' },
      { questions: [{ question: 'Ship this scope?', options: [{ label: 'Yes', description: 'All scopes' }] }] },
      { answers: [] }, { createdAt: 5 }]) {
      expect(DecisionAttention.present([older, { ...answered, ...change }])[0].supersededBy).toBeUndefined();
    }
    for (const change of [{ kind: 'approval' }, { status: 'pending' }, { status: 'deferred' }, { answers: [{ question: 'Ship this scope?', selected: ['No'] }] }]) {
      expect(DecisionAttention.present([{ ...older, ...change }, answered])[0].supersededBy).toBeUndefined();
    }
    expect(DecisionAttention.present([older, { ...answered, createdAt: 5 }])[0].supersededBy).toBeUndefined();
  });
});
