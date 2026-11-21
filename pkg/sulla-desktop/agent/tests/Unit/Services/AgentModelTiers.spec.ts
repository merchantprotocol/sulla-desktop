// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { cleanAgentModelTiers, exactTierRequest, orderTierEntries, resolveTierEntries, tierEntries } from '../../../languagemodels/agentModelTiers';
import { workerRouteCandidates } from '../../../languagemodels/workerModelBindings';

const primary = { provider: 'claude-code', model: 'opus' };
const second = { provider: 'codex', model: 'sol', effort: 'high' };
const third = { provider: 'grok', model: 'review' };
const tiers = [{ candidates: [primary, second] }, { candidates: [third] }];
const config = cleanAgentModelTiers({ version: 1, tiers });
const entries = tierEntries(config);
const providers = [primary, second, third].map(row => ({
  id: row.provider, connected: true, models: [{ id: row.model, efforts: [{ id: 'high' }] }],
})) as any;
describe('explicit agent model tiers', () => {
  it('keeps a Fable-first profile closed to an unlisted Opus launch', () => {
    const fable = { provider: 'claude-code', model: 'fable', effort: 'high' };
    const astra = { provider: 'codex', model: 'gpt-6.2-astra', effort: 'high' };
    const advisor = cleanAgentModelTiers({ version: 1, tiers: [{ candidates: [fable] }, { candidates: [astra] }] });
    const advisorEntries = tierEntries(advisor);

    expect(advisor.allowLaunchOverride).toBe('listed');
    expect(advisorEntries.map(row => row.candidate)).toEqual([fable, astra]);
    expect(() => exactTierRequest('advisor', advisor, advisorEntries, { provider: 'claude-code', model: 'opus' }))
      .toThrow(/doesn't list/);
  });

  it('retains tier and entry order within each health group', () => {
    expect(orderTierEntries(config, new Set(['claude-code'])).map(row => row.candidate)).toEqual([second, third, primary]);
    expect(entries.map(row => row.candidate)).toEqual([primary, second, third]);
  });
  it('allows 10 by 10 unique candidates and rejects excessive, empty or duplicate entries', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ candidates: Array.from({ length: 10 }, (_, j) => ({ provider: 'codex', model: String(i * 10 + j) })) }));
    expect(tierEntries(cleanAgentModelTiers({ version: 1, tiers: ten }))).toHaveLength(100);
    for (const invalid of [[], [...ten, ten[0]], [{ candidates: [...ten[0].candidates, primary] }], [{ candidates: [] }], [...tiers, tiers[0]]]) {
      expect(() => cleanAgentModelTiers({ version: 1, tiers: invalid })).toThrow();
    }
  });
  it('returns explicit skip reasons for cross-company, forbidden and unsupported models', () => {
    const restricted = { ...config, crossCompanyFallback: false };
    expect(resolveTierEntries(restricted, entries, providers, []).available.map(row => row.candidate)).toEqual([primary]);
    expect(resolveTierEntries(config, entries, providers, [{ ...primary, effort: 'any' }]).skipped[0].reason).toContain('Never-use');
    const unsupported = [{ ...entries[1], candidate: { ...second, effort: 'impossible' } }];
    expect(resolveTierEntries(config, unsupported, providers, []).skipped[0].reason).toContain('effort');
    const missing = resolveTierEntries(config, entries, [{ ...providers[0], connected: false }], []);
    expect(missing.skipped[0].transient).toBe(true);
  });
  it('pins exact requested candidates, enforces the override policy and preserves the fallback cursor', () => {
    expect(exactTierRequest('tester', config, entries, third)).toEqual(entries[2]);
    const extra = { ...second, model: 'other' };
    expect(() => exactTierRequest('tester', config, entries, extra)).toThrow(/list/);
    expect(() => exactTierRequest('tester', { ...config, allowLaunchOverride: 'never' }, entries, second)).toThrow(/accept/);
    expect(exactTierRequest('tester', { ...config, allowLaunchOverride: 'any' }, entries, extra).candidate).toEqual(extra);
    expect(() => exactTierRequest('tester', { ...config, crossCompanyFallback: false }, entries, second)).toThrow(/company/);
    const route = { version: 1 as const, revision: 1, slug: 'tester', agentId: 'id', modelTiers: config, selected: 1, candidates: [primary, second, third], candidateTiers: [1, 1, 2] };
    expect(workerRouteCandidates(JSON.parse(JSON.stringify(route)), providers, [])).toEqual([second, third]);
  });
});
