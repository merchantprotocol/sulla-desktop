import { postgresClient } from '../../PostgresClient';
import { ConversationKeywordsModel, normalizeConversationKeyword } from '../ConversationKeywordsModel';
import { jest } from '@jest/globals';

describe('ConversationKeywordsModel', () => {
  const originalQuery = postgresClient.query;

  beforeEach(() => {
    postgresClient.query = jest.fn(async() => [{ term: 'sulla', thread_id: 'thread-1', hit_count: 1 }]) as any;
  });

  afterEach(() => {
    postgresClient.query = originalQuery;
  });

  it('canonicalizes case and whitespace', () => {
    expect(normalizeConversationKeyword('  SULLA   Desktop  ')).toBe('sulla desktop');
  });

  it('deduplicates a batch and emits an atomic unique-key upsert', async() => {
    const rows = await ConversationKeywordsModel.upsertMany({
      terms: [' Sulla ', 'sulla', 'Postgres'],
      thread_id: 'thread-1',
      channel_id: 'chat',
      source: 'subconscious',
    });

    expect(rows).toHaveLength(2);
    expect(postgresClient.query).toHaveBeenCalledTimes(2);
    const [sql, params] = (postgresClient.query as any).mock.calls[0];
    expect(sql).toContain('ON CONFLICT (term, thread_id) DO UPDATE');
    expect(sql).toContain('hit_count');
    expect(params.slice(1)).toEqual(['sulla', 'thread-1', null, 'chat', null, 'subconscious']);
  });

  it('does not write an empty term set', async() => {
    await expect(ConversationKeywordsModel.upsertMany({ terms: ['  ', ''], thread_id: 'thread-1' })).resolves.toEqual([]);
    expect(postgresClient.query).not.toHaveBeenCalled();
  });
});
