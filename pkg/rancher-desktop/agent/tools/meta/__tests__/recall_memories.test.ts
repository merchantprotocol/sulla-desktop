import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { RecallMemoriesWorker } from '../recall_memories';

const recallMock = jest.fn<(...args: any[]) => Promise<any>>();

jest.mock('../../../memory/MemoryRecallService', () => ({
  OBSERVATION_DOMAIN:   'observation',
  recallRankedMemories: (...args: any[]) => recallMock(...args),
}));

function run(input: Record<string, unknown>): Promise<any> {
  return (new RecallMemoriesWorker() as any)._validatedCall(input);
}

describe('recall_memories', () => {
  afterEach(() => { recallMock.mockReset() });

  it('returns dated, ranked rows and passes domain + limit through', async() => {
    recallMock.mockResolvedValue([
      { id: 'a1', domain: 'human', level: 3, category: 'preference', date: '2026-09-30', score: 0.91, content: 'Prefers 16 memories per domain.' },
      { id: 'o1', domain: 'observation', level: null, category: 'high', date: '2026-09-29', score: 0.5, content: 'Ranked recall is live.' },
    ]);
    const res = await run({ query: 'memory recall', domain: 'Human', limit: 5 });

    expect(recallMock).toHaveBeenCalledWith(['memory recall'], expect.any(Date), { domain: 'human', limit: 5 });
    expect(res.successBoolean).toBe(true);
    expect(res.responseString).toContain('[id:a1] human L3·preference 2026-09-30');
    expect(res.responseString).toContain('[id:o1] high 2026-09-29');
  });

  it('rejects unknown domains and reports when the engine is unavailable', async() => {
    expect((await run({ query: 'x', domain: 'nope' })).responseString).toContain('Unknown domain');
    recallMock.mockResolvedValue(null);
    const res = await run({ query: 'x' });

    expect(res.successBoolean).toBe(false);
    expect(res.responseString).toContain('unavailable');
  });
});
