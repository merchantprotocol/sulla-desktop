// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, it, expect } from 'vitest';

import { InfrastructureFailure } from '../../../languagemodels/providerRecovery';
import { WorkerCatalogUnavailable, captureWorkerRoute, selectWorkerCandidate, workerRouteCandidates } from '../../../languagemodels/workerModelBindings';

const a = { provider: 'codex', model: 'luna', effort: 'max' };
const b = { provider: 'claude-code', model: 'sonnet', effort: 'high' };
const c = { provider: 'grok', model: 'grok-4.6' };
const providers: any = [{ id: 'codex', connected: true, models: [{ id: 'luna', defaultEffort: 'medium', efforts: [{ id: 'max' }] }] }, { id: 'claude-code', connected: true, models: [{ id: 'sonnet', efforts: [{ id: 'high' }] }] }, { id: 'grok', connected: true, models: [{ id: 'grok-4.6' }] }];
describe('named worker launch selections', () => {
  it('captures only the selected worker, independently of shared defaults and later settings edits', () => {
    const bindings = { luna: { agentId: 'definition-1', revision: 1, candidates: [a, b] } };
    const route = captureWorkerRoute('luna', 'definition-1', bindings)!;
    bindings.luna.candidates[0] = { ...a, effort: 'low' };
    expect(route.candidates[0].effort).toBe('max');
    expect(captureWorkerRoute('haiku', 'haiku-id', bindings)).toBeUndefined();
    expect(captureWorkerRoute('luna', 'replacement-custom-agent', bindings)).toBeUndefined();
  });
  it('resumes at the selected fallback under the original ordered snapshot', () => {
    const route = captureWorkerRoute('luna', 'id', { luna: { agentId: 'id', revision: 7, candidates: [a, b] } })!;
    const resumed = JSON.parse(JSON.stringify(selectWorkerCandidate(route, b)));
    expect(workerRouteCandidates(resumed, providers, [])).toEqual([b]);
    expect(resumed.revision).toBe(7);
    expect(() => selectWorkerCandidate(resumed, a)).toThrow('outside');
  });
  it('does not escape an exhausted policy or bypass exclusions', () => {
    const route = captureWorkerRoute('luna', 'id', { luna: { agentId: 'id', revision: 1, candidates: [a] } })!;
    expect(() => workerRouteCandidates(route, [], [])).toThrow('No configured');
    expect(() => workerRouteCandidates(route, providers, [{ ...a }])).toThrow('No configured');
  });
  it('routes a Grok OAuth model only from its exact owner-approved worker route', () => {
    const route = captureWorkerRoute('luna', 'id', { luna: { agentId: 'id', revision: 1, connections: { grok: 'oauth' }, candidates: [c] } })!;
    expect(workerRouteCandidates(route, providers, [])).toEqual([c]);
    expect(() => workerRouteCandidates(route, [], [])).toThrow('No configured');
  });
  it('treats a transient live-catalog outage as retryable infrastructure, never as a reason to substitute', () => {
    const route = captureWorkerRoute('luna', 'id', { luna: { agentId: 'id', revision: 1, candidates: [a] } })!;
    const outages: any[] = [
      [{ id: 'codex', connected: true, models: [] }],
      [{ id: 'codex', connected: true, models: [{ id: 'codex', label: 'Auto' }] }],
      [{ id: 'codex', connected: true, models: [{ id: 'luna', unverified: true }] }],
      [{ id: 'codex', connected: false, models: [] }],
    ];
    for (const outage of outages) {
      let thrown: unknown;
      try { workerRouteCandidates(route, outage, []) } catch (error) { thrown = error }
      expect(thrown).toBeInstanceOf(WorkerCatalogUnavailable);
      expect(thrown).toBeInstanceOf(InfrastructureFailure);
    }
  });
  it('keeps owner exclusions and real catalog changes final during an outage', () => {
    const both = captureWorkerRoute('luna', 'id', { luna: { agentId: 'id', revision: 1, candidates: [a, b] } })!;
    const codexDown: any = [{ id: 'codex', connected: true, models: [] }, providers[1]];
    // An approved fallback is still used; nothing outside the route is.
    expect(workerRouteCandidates(both, codexDown, [])).toEqual([b]);
    // Never-use on the only healthy fallback is not overridden by the primary outage, and the outage is still retryable.
    expect(() => workerRouteCandidates(both, codexDown, [{ provider: 'claude-code', model: 'sonnet', effort: 'high' }])).toThrow(WorkerCatalogUnavailable);
    // A never-used model is never waited for.
    const only = captureWorkerRoute('luna', 'id', { luna: { agentId: 'id', revision: 1, candidates: [a] } })!;
    let blocked: unknown;
    try { workerRouteCandidates(only, [{ id: 'codex', connected: true, models: [] }] as any, [{ provider: 'codex', model: 'luna', effort: 'max' }]) } catch (error) { blocked = error }
    expect(blocked).not.toBeInstanceOf(InfrastructureFailure);
    // A healthy catalog that no longer lists the model is an owner-visible change, not an outage.
    let removed: unknown;
    try { workerRouteCandidates(only, [{ id: 'codex', connected: true, models: [{ id: 'other' }] }] as any, []) } catch (error) { removed = error }
    expect(removed).toBeInstanceOf(Error); expect(removed).not.toBeInstanceOf(InfrastructureFailure);
  });
});
