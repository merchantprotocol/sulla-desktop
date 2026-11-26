// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { AgentModelStatusRegistry } from '../../../services/AgentModelStatusRegistry';

import { AgentModelStatus } from '@pkg/shared/agentState/AgentModelStatus';

describe('model and effort status', () => {
  it('distinguishes requested max, effective default and unreported historical effort', () => {
    expect(AgentModelStatus.label({ model: 'gpt-6-luna', effort: 'max', source: 'requested' })).toBe('gpt-6-luna · Max (requested)');
    expect(AgentModelStatus.label({ model: 'gpt-6-luna', effort: 'max', source: 'resolved' })).toBe('gpt-6-luna · Max');
    expect(AgentModelStatus.label({ model: 'gpt-6-luna', effort: '', source: 'resolved' })).toBe('gpt-6-luna · Default');
    expect(AgentModelStatus.label({ model: 'gpt-6-luna', effort: null, source: 'requested' })).toContain('Effort not reported');
    expect(AgentModelStatus.label({ model: 'grok-4.7', provider: 'grok', effort: null, source: 'resolved' })).toContain('No effort setting');
  });
  it('labels selected aliases whose response has no provider model receipt', () => {
    const selected = { model: 'opus', provider: 'claude-code', effort: 'high', source: 'resolved' as const };
    expect(AgentModelStatus.label({ ...selected, modelEvidence: 'unconfirmed' })).toContain('response model unconfirmed');
    expect(AgentModelStatus.label({ ...selected, model: 'provider-version', modelEvidence: 'provider' })).toBe('provider-version · High');
  });
  it('publishes only changed runtime settings and keeps separate threads isolated', () => {
    let updates = 0; const stop = AgentModelStatusRegistry.onChange(() => { updates++ });
    const value = { model: 'gpt-6-luna', effort: 'max', source: 'resolved' as const };
    AgentModelStatusRegistry.record('effort-status-qa-one', value);
    AgentModelStatusRegistry.record('effort-status-qa-one', value);
    AgentModelStatusRegistry.record('effort-status-qa-two', { ...value, effort: '' });
    stop();
    expect(updates).toBe(2);
    expect(AgentModelStatusRegistry.get('effort-status-qa-one')?.effort).toBe('max');
    expect(AgentModelStatusRegistry.get('effort-status-qa-two')?.effort).toBe('');
  });
});
