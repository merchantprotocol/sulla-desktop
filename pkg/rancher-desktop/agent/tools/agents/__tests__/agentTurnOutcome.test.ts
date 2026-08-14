import { describe, expect, it } from '@jest/globals';

import { extractAgentTurnOutcome } from '../agentTurnOutcome';

describe('extractAgentTurnOutcome', () => {
  it('reports blocked with reason and requirements', () => {
    const out = extractAgentTurnOutcome({
      metadata: {
        agent: {
          status:                'BLOCKED',
          blocker_reason:        'needs credential',
          unblock_requirements:  'GITHUB_TOKEN',
        },
      },
    });

    expect(out.status).toBe('blocked');
    expect(out.text).toBe('[BLOCKED] needs credential | Requirements: GITHUB_TOKEN');
  });

  it('reports blocked with a default reason and no requirements clause', () => {
    const out = extractAgentTurnOutcome({ metadata: { agent: { status: 'blocked' } } });

    expect(out.status).toBe('blocked');
    expect(out.text).toBe('[BLOCKED] Unknown blocker');
  });

  it('prefers finalSummary for completed turns', () => {
    const out = extractAgentTurnOutcome({
      metadata: {
        finalSummary: 'all done',
        agent:        { status: 'completed' },
      },
      messages: [{ role: 'assistant', content: 'ignored last message' }],
    });

    expect(out.status).toBe('completed');
    expect(out.text).toBe('all done');
  });

  it('falls back to the last message content when there is no finalSummary', () => {
    const out = extractAgentTurnOutcome({
      metadata: {},
      messages: [
        { role: 'user',      content: 'do the thing' },
        { role: 'assistant', content: 'the result' },
      ],
    });

    expect(out.status).toBe('completed');
    expect(out.text).toBe('the result');
  });

  it('falls back to (no output) when neither summary nor messages exist', () => {
    const out = extractAgentTurnOutcome({ metadata: {}, messages: [] });

    expect(out.status).toBe('completed');
    expect(out.text).toBe('(no output)');
  });

  it('stringifies non-string message content', () => {
    const payload = { foo: 'bar' };
    const out = extractAgentTurnOutcome({
      metadata: {},
      messages: [{ role: 'assistant', content: payload }],
    });

    expect(out.status).toBe('completed');
    expect(out.text).toBe(JSON.stringify(payload));
  });

  it('tolerates a bare/empty state', () => {
    expect(extractAgentTurnOutcome({}).text).toBe('(no output)');
    expect(extractAgentTurnOutcome(undefined).text).toBe('(no output)');
  });
});
