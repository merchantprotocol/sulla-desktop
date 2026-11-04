// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ModelRouter's production module reads the process-global provider factory table at import time.
// This narrow replacement is the only available seam; provider behavior itself is injected publicly below.
vi.mock('../../../languagemodels/index', () => ({ PROVIDER_FACTORIES: { openai: {}, anthropic: {} } }));
import { SullaSettingsModel } from '../../../database/models/SullaSettingsModel';
import { Interrupted } from '../../../languagemodels/failures';
import { CliFaultError, CliHandoffFailure, markSullaInternalFault } from '../../../languagemodels/cliFaultRecovery';
import { BACKOFF_FREE_FAILURES, ModelRouter, backoffMs, type EditableState } from '../../../languagemodels/modelRouter';
import { InfrastructureFailure, classifyLLMFailure } from '../../../languagemodels/providerRecovery';

const state: EditableState = {
  agentsList: [
    { provider: 'openai', class: 'standard', enabled: true },
    { provider: 'anthropic', class: 'standard', enabled: true },
  ],
  subconsciousList: [],
  classes: {
    frontier: [], fast: [], coding: [], local: [],
    standard: [{ provider: 'openai', model: 'top' }, { provider: 'anthropic', model: 'next' }],
  },
  followProviderOrder: { frontier: true, standard: true, fast: true, coding: true, local: true },
};

function router(): ModelRouter {
  return new ModelRouter(() => ({
    getAvailableProviders: async () => [
      { id: 'openai', connected: true }, { id: 'anthropic', connected: true },
    ],
    getModelsForProvider: async (id: string) => [{ id: id === 'openai' ? 'top' : 'next' }],
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
  vi.spyOn(SullaSettingsModel, 'get').mockImplementation(async (key: string, fallback: any) => key === 'modelRouting' ? state : fallback);
  vi.spyOn(SullaSettingsModel, 'set').mockResolvedValue(undefined as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() });

describe('BL-044 provider health is a temporary routing hint', () => {
  it('gives the first failures free and grows backoff only with consecutive provider failures', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 30 }), failures => {
      const delay = backoffMs(failures);
      if (failures <= BACKOFF_FREE_FAILURES) expect(delay).toBe(0);
      else expect(delay).toBeGreaterThan(0);
      expect(backoffMs(failures + 1)).toBeGreaterThanOrEqual(delay);
    }));
  });

  it('one success fully resets any failure history', async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 12 }), async failures => {
      const subject = router();
      for (let i = 0; i < failures; i++) await subject.markFailure('openai', new Error('provider unavailable'));
      await subject.markSuccess('openai');
      expect(await subject.isUnavailable('openai')).toBe(false);
      for (let i = 0; i < BACKOFF_FREE_FAILURES; i++) await subject.markFailure('openai', new Error('provider unavailable'));
      expect(await subject.isUnavailable('openai')).toBe(false);
    }));
  });

  it('never changes provider health for interruption, abort, infrastructure, or handoff failures', async () => {
    const subject = router();
    const internal = markSullaInternalFault(new CliFaultError('spawn', 'spawn failed'));
    const failures = [new Interrupted('openai'), Object.assign(new Error('aborted'), { name: 'AbortError' }), new InfrastructureFailure('container lifecycle'), internal, new CliHandoffFailure('transport', internal)];
    for (const error of failures) {
      expect(['interrupted', 'infrastructure']).toContain(classifyLLMFailure(error).kind);
      await subject.markFailure('openai', error);
    }
    expect(await subject.isUnavailable('openai')).toBe(false);
  });

  it('starts each message at the configured top healthy provider and never returns no provider when all are backed off', async () => {
    const subject = router();
    expect((await subject.resolve('agents'))[0]).toEqual({ provider: 'openai', model: 'top' });
    for (let i = 0; i <= BACKOFF_FREE_FAILURES; i++) await subject.markFailure('openai', new Error('down'));
    expect((await subject.resolve('agents'))[0]?.provider).toBe('anthropic');
    for (let i = 0; i <= BACKOFF_FREE_FAILURES; i++) await subject.markFailure('anthropic', new Error('down'));
    expect(await subject.resolve('agents')).toEqual([{ provider: 'openai', model: 'top' }, { provider: 'anthropic', model: 'next' }]);
  });

  it('a pinned request resolves exactly that model without fallback and does not alter unpinned routing', async () => {
    const subject = router();
    expect(await subject.resolve('agents', { mode: 'pin', provider: 'anthropic', model: 'fixed' })).toEqual([{ provider: 'anthropic', model: 'fixed' }]);
    expect((await subject.resolve('agents'))[0]?.provider).toBe('openai');
  });

  it('matches the consecutive-failure reset model across random health event sequences', async () => {
    type Event = 'provider-fail' | 'provider-success' | 'internal-error' | 'clock-advance';
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom<Event>('provider-fail', 'provider-success', 'internal-error', 'clock-advance'), { minLength: 1, maxLength: 80 }), async events => {
      const subject = router(); let consecutive = 0; let now = Date.now(); let unavailableUntil = 0;
      for (const event of events) {
        if (event === 'provider-fail') { consecutive++; unavailableUntil = now + backoffMs(consecutive); await subject.markFailure('openai', new Error('provider down')) }
        else if (event === 'provider-success') { consecutive = 0; unavailableUntil = 0; await subject.markSuccess('openai') }
        else if (event === 'internal-error') await subject.markFailure('openai', new InfrastructureFailure('runtime'));
        else { now += 1_000; vi.advanceTimersByTime(1_000) }
        expect(await subject.isUnavailable('openai')).toBe(unavailableUntil > now);
      }
    }), { numRuns: 50 });
  });
});
