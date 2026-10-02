import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { IdentityObservationsModel } from '../../../database/models/IdentityObservationsModel';

const recallMock = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../../../memory/MemoryRecallService', () => ({
  OBSERVATION_DOMAIN:   'observation',
  recallRankedMemories: (...args: any[]) => recallMock(...args),
}));

let SearchIdentityObservationsWorker: typeof import('../search_identity_observations').SearchIdentityObservationsWorker;
beforeAll(async() => {
  ({ SearchIdentityObservationsWorker } = await import('../search_identity_observations'));
});

const hum = {
  id:         'hum1',
  domain:     'human',
  level:      3,
  category:   'preference',
  content:    'Wants short status reports.',
  basis:      null,
  subject:    null,
  kind:       null,
  confidence: null,
  evidence:   null,
  archived:   false,
  created_at: '2026-09-30',
} as any;

function run(input: Record<string, unknown>): Promise<any> {
  return (new SearchIdentityObservationsWorker() as any)._validatedCall(input);
}

describe('search_identity_observations', () => {
  afterEach(() => { recallMock.mockReset(); jest.restoreAllMocks() });

  it('ranks by meaning with the recall engine and loads full rows', async() => {
    recallMock.mockResolvedValue([{ id: 'hum1', domain: 'human', score: 0.87 }]);
    jest.spyOn(IdentityObservationsModel, 'getById').mockResolvedValue(hum);
    const ilike = jest.spyOn(IdentityObservationsModel, 'search');
    const res = await run({ domain: 'human', query: 'weekly updates', limit: 5 });

    expect(recallMock).toHaveBeenCalledWith(['weekly updates'], expect.any(Date), { domain: 'human', limit: 5 });
    expect(ilike).not.toHaveBeenCalled();
    expect(res.responseString).toContain('(ranked by meaning)');
    expect(res.responseString).toContain('[id:hum1] L3·preference 2026-09-30 (score 0.87) — Wants short status reports.');
  });

  it('falls back to ILIKE when the engine is unavailable or archived rows are requested', async() => {
    recallMock.mockResolvedValue(null);
    jest.spyOn(IdentityObservationsModel, 'search').mockResolvedValue([hum]);

    expect((await run({ domain: 'human', query: 'status reports' })).responseString).toContain('[id:hum1] L3·preference');
    await run({ domain: 'human', query: 'status reports', include_archived: true });
    expect(recallMock).toHaveBeenCalledTimes(1);
    expect(IdentityObservationsModel.search).toHaveBeenLastCalledWith('human', 'status reports', 20, true);
  });
});
