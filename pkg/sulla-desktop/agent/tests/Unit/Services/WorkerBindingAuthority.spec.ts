// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, it, expect } from 'vitest';

import { assertWorkerBindingsUnchanged, withWorkerBindingWrite } from '../../../languagemodels/workerBindingAuthority';
import { assertWorkerSubscription } from '../../../languagemodels/workerSubscriptionGuard';

describe('worker owner controls and subscription boundaries', () => {
  it('allows normal legacy settings but prevents raw tool payloads from minting or deleting mappings', async() => {
    expect(() => assertWorkerBindingsUnchanged(undefined, {})).not.toThrow();
    expect(() => assertWorkerBindingsUnchanged({ luna: 1 }, undefined)).toThrow('AI Models');
    expect(() => assertWorkerBindingsUnchanged({}, { luna: 1 })).toThrow('AI Models');
    await withWorkerBindingWrite(async() => {
      await Promise.resolve();
      expect(() => assertWorkerBindingsUnchanged({}, { luna: 1 })).not.toThrow();
    });
    expect(() => assertWorkerBindingsUnchanged({}, { luna: 1 })).toThrow();
  });
  it('preserves unbound auth and rejects metered or changed connections for mapped jobs', () => {
    expect(() => assertWorkerSubscription(undefined, 'claude-code', 'anthropic', 'key', 'api-key')).not.toThrow();
    const state: any = { metadata: { workerModelRoute: { connections: { 'claude-code': 'oauth', codex: 'paid-chatgpt' } } } };
    expect(() => assertWorkerSubscription(state, 'claude-code', 'claude-code', 'oauth', 'oauth')).not.toThrow();
    expect(() => assertWorkerSubscription(state, 'claude-code', 'anthropic', 'key', 'api-key')).toThrow('subscription');
    expect(() => assertWorkerSubscription(state, 'claude-code', 'claude-code', 'oauth', 'api-key')).toThrow();
    expect(() => assertWorkerSubscription(state, 'codex', 'openai', 'paid-chatgpt')).toThrow();
    expect(() => assertWorkerSubscription(state, 'codex', 'codex', 'other-account')).toThrow();
    expect(() => assertWorkerSubscription({ metadata: {} } as any, 'grok', 'grok', 'api-key')).not.toThrow();
  });
});
