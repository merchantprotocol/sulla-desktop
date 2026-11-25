// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { DecisionAuthorityPolicy } from '../../../services/DecisionAuthorityPolicy';

const question = { kind: 'question' as const, title: 'First contact', questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }] };

describe('DecisionAuthorityPolicy', () => {
  const policy = new DecisionAuthorityPolicy();

  it('enforces the full actor/action matrix for approvals, ordinary questions, task asks and explicit consent', () => {
    // risk: authorization — an agent must not grant approvals or answer task/consent questions, while ordinary questions remain parent-answerable.
    const approval = { ...question, kind: 'approval' as const };
    const task = { ...question, questions: [{ ...question.questions[0], task: true }] };
    const consent = { ...question, payload: { decisionAuthority: 'human' } };
    const cases: [typeof question | typeof approval, 'answer' | 'approve' | 'deny' | 'pass', 'agent' | 'human', boolean][] = [
      [approval, 'approve', 'human', true], [approval, 'deny', 'human', true], [approval, 'pass', 'human', false], [approval, 'answer', 'human', false],
      [approval, 'approve', 'agent', false], [approval, 'deny', 'agent', true], [approval, 'pass', 'agent', true], [approval, 'answer', 'agent', false],
      [question, 'answer', 'human', true], [question, 'approve', 'human', false], [question, 'deny', 'human', false], [question, 'pass', 'human', false],
      [question, 'answer', 'agent', true], [question, 'approve', 'agent', false], [question, 'deny', 'agent', false], [question, 'pass', 'agent', false],
      [task, 'answer', 'human', true], [task, 'answer', 'agent', false],
      [consent, 'answer', 'human', true], [consent, 'answer', 'agent', false],
    ];

    expect(policy.classify(approval)).toBe('human');
    expect(policy.classify(task)).toBe('human');
    expect(policy.classify({ ...question, questions: [...question.questions, { question: 'Do this?', task: true, options: [{ label: 'Done' }] }] })).toBe('human');
    expect(policy.classify(consent)).toBe('human');
    expect(policy.classify({ ...question, title: 'Run this task?' })).toBe('any');
    for (const [record, action, actor, allowed] of cases) expect(policy.allows(record, action, actor)).toBe(allowed);
  });
});
