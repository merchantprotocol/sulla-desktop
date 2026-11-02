// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { classifyLLMFailure, redactLLMFailureMessage, sameLLMRoute } from '../providerRecovery';

describe('providerRecovery', () => {
  it.each([
    ['auth', new Error('HTTP 401 unauthorized'), 'auth'],
    ['quota', new Error('weekly limit reached'), 'quota'],
    ['rate limit', new Error('too many requests'), 'rate_limit'],
    ['timeout', new Error('request ETIMEDOUT'), 'timeout'],
    ['empty', new Error('returned empty response'), 'empty'],
    ['unavailable', new Error('service unavailable'), 'unavailable'],
    ['routing', new Error('workspace routing discovery failed'), 'unavailable'],
    ['interrupted', new Error('operation aborted'), 'interrupted'],
    ['CLI exhausted', Object.assign(new Error('recovery exhausted'), { cliRecoveryExhausted: true }), 'unavailable'],
    ['unknown', new Error('something unexpected happened'), 'unknown'],
  ])('classifies %s failures', (_label, error, kind) => {
    expect(classifyLLMFailure(error)).toMatchObject({ kind });
  });

  it('does not turn vault or broker credential text into provider auth', () => {
    expect(classifyLLMFailure(new Error('vault broker credential lookup failed'))).toMatchObject({ kind: 'unknown' });
  });

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
