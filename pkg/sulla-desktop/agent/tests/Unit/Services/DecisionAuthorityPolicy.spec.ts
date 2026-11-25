// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { DecisionAuthorityPolicy } from '../../../services/DecisionAuthorityPolicy';

const question = { kind: 'question' as const, title: 'First contact', questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }] };

describe('DecisionAuthorityPolicy', () => {
  const policy = new DecisionAuthorityPolicy();

  it('classifies approvals, task questions and explicit consent as human-only, but not by title', () => {
    // risk: authorization — only a human may grant approvals, complete task asks or grant contact consent.
    expect(policy.classify({ ...question, kind: 'approval' })).toBe('human');
    expect(policy.classify({ ...question, questions: [{ ...question.questions[0], task: true }] })).toBe('human');
    expect(policy.classify({ ...question, questions: [...question.questions, { question: 'Do this?', task: true, options: [{ label: 'Done' }] }] })).toBe('human');
    expect(policy.classify({ ...question, payload: { decisionAuthority: 'human' } })).toBe('human');
    expect(policy.classify(question)).toBe('any');
  });

  it('allows agents to answer only ordinary questions and to deny or pass approvals, never grant them', () => {
    // risk: authorization — delegated agents must not grant any human-only approval or answer task/consent questions.
    expect(policy.allows(question, 'answer', 'agent')).toBe(true);
    expect(policy.allows({ ...question, questions: [{ ...question.questions[0], task: true }] }, 'answer', 'agent')).toBe(false);
    expect(policy.allows({ ...question, payload: { decisionAuthority: 'human' } }, 'answer', 'agent')).toBe(false);
    const approval = { ...question, kind: 'approval' as const };
    expect(policy.allows(approval, 'deny', 'agent')).toBe(true);
    expect(policy.allows(approval, 'pass', 'agent')).toBe(true);
    expect(policy.allows(approval, 'approve', 'agent')).toBe(false);
    expect(policy.allows(question, 'answer', 'human')).toBe(true);
  });
});
