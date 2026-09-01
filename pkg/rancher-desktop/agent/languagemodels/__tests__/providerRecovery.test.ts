import { classifyLLMFailure, redactLLMFailureMessage, sameLLMRoute } from '../providerRecovery';

describe('providerRecovery', () => {
  it('classifies quota and weekly-limit failures as fallbackable provider failures', () => {
    expect(classifyLLMFailure(new Error('HTTP 402 Grok Build usage balance exhausted'))).toMatchObject({
      kind:            'quota',
      retryPrimary:    false,
      fallbackAllowed: true,
    });

    expect(classifyLLMFailure(new Error('Claude weekly limit reached'))).toMatchObject({
      kind:            'quota',
      retryPrimary:    false,
      fallbackAllowed: true,
    });

    expect(classifyLLMFailure(new Error("You've hit your session limit · resets 3:50pm"))).toMatchObject({
      kind:            'quota',
      retryPrimary:    false,
      fallbackAllowed: true,
    });
  });

  it('classifies process and stream failures as retryable before fallback', () => {
    expect(classifyLLMFailure(new Error('Codex app-server event stream lag dropped events'))).toMatchObject({
      kind:            'unavailable',
      retryPrimary:    true,
      fallbackAllowed: true,
    });

    expect(classifyLLMFailure(new Error('codex exited with code null'))).toMatchObject({
      kind:            'unavailable',
      retryPrimary:    true,
      fallbackAllowed: true,
    });
  });

  it('treats aborts as controlled interruptions, not provider fallbacks', () => {
    const err = new Error('Chat operation aborted');
    (err as any).name = 'AbortError';

    expect(classifyLLMFailure(err)).toMatchObject({
      kind:            'interrupted',
      retryPrimary:    false,
      fallbackAllowed: false,
    });
  });

  it('redacts provider secrets from failure messages', () => {
    expect(redactLLMFailureMessage('bad key sk-proj-abcdefghijklmnopqrstuvwxyz123456')).toBe('bad key [redacted]');
  });

  it('detects duplicate provider/model fallback routes', () => {
    expect(sameLLMRoute(
      { provider: 'OpenAI Codex', model: 'codex' },
      { provider: 'openai codex', model: 'CODEX' },
    )).toBe(true);

    expect(sameLLMRoute(
      { provider: 'OpenAI Codex', model: 'codex' },
      { provider: 'OpenAI', model: 'gpt-5' },
    )).toBe(false);
  });
});
