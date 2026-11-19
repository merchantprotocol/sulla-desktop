// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { AgentModelConfiguration } from '@pkg/components/studio/AgentModelConfiguration';
const state:any = { workers: [{ id: 'luna-id', slug: 'luna' }], workerBindings: { luna: { agentId: 'luna-id', revision: 3, editToken: 'opened', candidates: [{ provider: 'codex', model: 'gpt-6-luna', effort: 'max' }, { provider: 'claude-code', model: 'sonnet', effort: 'high' }] } } };
describe('existing agent editor uses its actual execution selection', () => {
  it('hydrates the configured model and effort instead of the old definition class, without mutating launch snapshots', () => {
    const editor = new AgentModelConfiguration('luna-id', 'luna', state);
    expect(editor.choice({ mode: 'class', class: 'fast' })).toEqual({ mode: 'pin', provider: 'codex', model: 'gpt-6-luna', effort: 'max' });
    const fallbacks = editor.fallbacks(); fallbacks[0].effort = 'low';
    expect(state.workerBindings.luna.candidates[1].effort).toBe('high');
  });
  it('changes effort while preserving fallback order and stale-edit protection', () => {
    const editor = new AgentModelConfiguration('luna-id', 'luna', state);
    const update = editor.change({ mode: 'pin', provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, editor.fallbacks(), state);
    expect(update).toEqual({ slug: 'luna', agentId: 'luna-id', expectedRevision: 3, expectedToken: 'opened', candidates: [{ provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, state.workerBindings.luna.candidates[1]] });
    expect(editor.change(editor.choice({ mode: 'list' }), editor.fallbacks(), state)).toBeUndefined();
  });
  it('returns to shared settings only by an explicit change and never adopts a reused slug', () => {
    const editor = new AgentModelConfiguration('luna-id', 'luna', state);
    expect(editor.change({ mode: 'class', class: 'fast' }, editor.fallbacks(), state)?.candidates).toBeNull();
    const replacement = new AgentModelConfiguration('different-id', 'luna', state);
    expect(replacement.choice({ mode: 'list' })).toEqual({ mode: 'list' }); expect(replacement.fallbacks()).toEqual([]);
  });
  it('rejects unsupported fallback conversion rather than silently discarding saved choices', () => {
    const editor = new AgentModelConfiguration('luna-id', 'luna', state);
    expect(() => editor.change({ mode: 'pin', provider: 'anthropic', model: 'opus' }, editor.fallbacks(), state)).toThrow('cannot be represented');
  });
  it('saves an exact Grok subscription pin and keeps owner-approved fallback order', () => {
    const editor = new AgentModelConfiguration('luna-id', 'luna', state);
    const update = editor.change({ mode: 'pin', provider: 'grok', model: 'grok-4.6' }, [{ provider: 'codex', model: 'gpt-6-luna', effort: 'max' }], state);
    expect(update?.candidates).toEqual([{ provider: 'grok', model: 'grok-4.6' }, { provider: 'codex', model: 'gpt-6-luna', effort: 'max' }]);
  });
  it('rejects duplicate or malformed fallback candidates before the owner CAS write', () => {
    const editor = new AgentModelConfiguration('luna-id', 'luna', state);
    expect(() => editor.change({ mode: 'pin', provider: 'codex', model: 'gpt-6-luna' }, [{ provider: 'codex', model: 'gpt-6-luna' }], state)).toThrow('unique');
    expect(() => editor.change({ mode: 'pin', provider: 'codex', model: 'gpt-6-luna' }, [{ provider: '', model: 'missing' }], state)).toThrow('provider and model');
  });
  it('lets the owner configure an unmapped disabled definition, while an unlisted enabled one still cannot be represented', () => {
    const noWorkers = { ...state, workers: [], workerBindings: {} };
    const chain = [{ provider: 'claude-code', model: 'sonnet', effort: 'high' }];
    const disabled = new AgentModelConfiguration('luna-id', 'luna', noWorkers, { mode: 'class', class: 'fast' }, true);
    expect(disabled.change({ mode: 'pin', provider: 'codex', model: 'gpt-6-luna', effort: 'max' }, chain, noWorkers)).toEqual({
      slug: 'luna', agentId: 'luna-id', expectedRevision: 0, expectedToken: '', candidates: [{ provider: 'codex', model: 'gpt-6-luna', effort: 'max' }, ...chain],
    });
    const unlisted = new AgentModelConfiguration('luna-id', 'luna', noWorkers, { mode: 'class', class: 'fast' });
    expect(() => unlisted.change({ mode: 'pin', provider: 'codex', model: 'gpt-6-luna' }, [], noWorkers)).toThrow('cannot be represented');
  });
  it('keeps a saved disabled-agent mapping readable while a profile-only save changes enabled state', () => {
    const disabled = { ...state, workers: [] };
    const editor = new AgentModelConfiguration('luna-id', 'luna', disabled, { mode: 'class', class: 'fast' });
    expect(editor.change(editor.choice({ mode: 'class', class: 'fast' }), editor.fallbacks(), disabled)).toBeUndefined();
    expect(editor.change({ mode: 'pin', provider: 'codex', model: 'gpt-6-luna', effort: 'high' }, editor.fallbacks(), disabled)?.candidates?.[0]).toEqual({ provider: 'codex', model: 'gpt-6-luna', effort: 'high' });
  });
});
it('leaves an unchanged legacy pin alone when only the profile is edited', () => {
  const unbound = { ...state, workerBindings: {} };
  const legacy:any = { mode: 'pin', provider: 'codex', model: 'legacy-cli-default' };
  const editor = new AgentModelConfiguration('luna-id', 'luna', unbound, legacy);
  expect(editor.change(legacy, [], unbound)).toBeUndefined();
  expect(editor.change({ ...legacy, model: 'new-version', effort: 'max' }, [], unbound)?.candidates).toEqual([{ provider: 'codex', model: 'new-version', effort: 'max' }]);
});
