import { AGENT_ERROR_MESSAGE_PREFIX, detectAgentNodeError } from '../agentNodeError';

describe('detectAgentNodeError', () => {
  const providerErrorText = `${ AGENT_ERROR_MESSAGE_PREFIX }: [Agent] LLM provider failed: HTTP 402 Grok Build usage balance exhausted. Please try again or switch to a different model.`;

  it('detects the structured agent_error metadata kind', () => {
    const msg = {
      metadata: {
        nodeId: 'node-1', nodeName: 'Agent', kind: 'agent_error', timestamp: 123,
      },
    };

    expect(detectAgentNodeError(msg, providerErrorText)).toBe(providerErrorText);
  });

  it('returns a fallback reason when the tagged message has empty text', () => {
    const msg = { metadata: { kind: 'agent_error' } };

    expect(detectAgentNodeError(msg, '   ')).toBe('Agent node reported an unrecoverable error');
  });

  it('falls back to the message prefix when metadata is missing', () => {
    expect(detectAgentNodeError(undefined, providerErrorText)).toBe(providerErrorText);
    expect(detectAgentNodeError({ metadata: {} }, `  ${ providerErrorText }`)).toBe(providerErrorText);
  });

  it('returns null for genuine output', () => {
    expect(detectAgentNodeError(undefined, 'Here is the daily briefing you asked for.')).toBeNull();
    expect(detectAgentNodeError({ metadata: { kind: 'other' } }, 'Normal output')).toBeNull();
    expect(detectAgentNodeError(undefined, '')).toBeNull();
  });

  it('does not flag output that merely mentions an error mid-text', () => {
    const text = `The deploy failed earlier; note it said "${ AGENT_ERROR_MESSAGE_PREFIX }" in the log, but I recovered and finished the task.`;

    expect(detectAgentNodeError(undefined, text)).toBeNull();
  });
});
