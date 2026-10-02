import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { ObservationsModel } from '../../../database/models/ObservationsModel';

const recallMock = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../../../memory/MemoryRecallService', () => ({
  OBSERVATION_DOMAIN:   'observation',
  recallRankedMemories: (...args: any[]) => recallMock(...args),
}));

let SearchObservationsWorker: typeof import('../search_observations').SearchObservationsWorker;
beforeAll(async() => {
  ({ SearchObservationsWorker } = await import('../search_observations'));
});

const obs = { id: 'o1', priority: 'high', created_at: '2026-09-30', content: 'Billing leak at Selkirk.', archived: false } as any;

function run(input: Record<string, unknown>): Promise<any> {
  return (new SearchObservationsWorker() as any)._validatedCall(input);
}

describe('search_observations', () => {
  afterEach(() => { recallMock.mockReset(); jest.restoreAllMocks() });

  it('ranks by meaning with the recall engine', async() => {
    recallMock.mockResolvedValue([{ id: 'o1', domain: 'observation', score: 0.74 }]);
    jest.spyOn(ObservationsModel, 'getById').mockResolvedValue(obs);
    const ilike = jest.spyOn(ObservationsModel, 'search');
    const res = await run({ query: 'invoice problems', limit: 3 });

    expect(recallMock).toHaveBeenCalledWith(['invoice problems'], expect.any(Date), { domain: 'observation', limit: 3 });
    expect(ilike).not.toHaveBeenCalled();
    expect(res.responseString).toContain('[id:o1] high 2026-09-30 (score 0.74) — Billing leak at Selkirk.');
  });

  it('falls back to ILIKE when the engine is unavailable or archived rows are requested', async() => {
    recallMock.mockResolvedValue(null);
    jest.spyOn(ObservationsModel, 'search').mockResolvedValue([obs]);

    expect((await run({ query: 'billing' })).responseString).toContain('[id:o1] high');
    await run({ query: 'billing', include_archived: true });
    expect(recallMock).toHaveBeenCalledTimes(1);
    expect(ObservationsModel.search).toHaveBeenLastCalledWith('billing', 20, true);
  });
});
