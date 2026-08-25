import { describe, expect, it } from '@jest/globals';

import { AgentQuestionModel } from '../AgentQuestionModel';

// Pure-logic fingerprint tests: the model's PostgresClient import is lazy
// (nothing connects until a query runs), so no database and no mocking is
// needed here. Persistence behavior is covered by
// AgentQuestionModel.postgres.test.ts on a migrated database.

describe('AgentQuestionModel.fingerprint', () => {
  const base = {
    conversationId: 'conv-1',
    kind:           'decision' as const,
    questions:      [{
      question: 'Deploy to prod?',
      options:  [{ label: 'Approve' }, { label: 'Deny' }],
    }],
  };

  it('is deterministic for identical input', () => {
    expect(AgentQuestionModel.fingerprint(base)).toBe(AgentQuestionModel.fingerprint(base));
  });

  it('is insensitive to option order, case, and whitespace', () => {
    const equivalent = {
      ...base,
      questions: [{
        question: '  DEPLOY TO PROD? ',
        options:  [{ label: 'deny' }, { label: 'approve' }],
      }],
    };
    expect(AgentQuestionModel.fingerprint(equivalent)).toBe(AgentQuestionModel.fingerprint(base));
  });

  it('differs when the conversation differs', () => {
    expect(AgentQuestionModel.fingerprint({ ...base, conversationId: 'conv-2' }))
      .not.toBe(AgentQuestionModel.fingerprint(base));
  });

  it('differs when the kind differs (decision vs dependency)', () => {
    expect(AgentQuestionModel.fingerprint({ ...base, kind: 'dependency' }))
      .not.toBe(AgentQuestionModel.fingerprint(base));
  });

  it('differs when the question text differs', () => {
    const other = {
      ...base,
      questions: [{ question: 'Delete the database?', options: [{ label: 'Approve' }, { label: 'Deny' }] }],
    };
    expect(AgentQuestionModel.fingerprint(other)).not.toBe(AgentQuestionModel.fingerprint(base));
  });

  it('produces a 64-char sha256 hex digest', () => {
    expect(AgentQuestionModel.fingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
