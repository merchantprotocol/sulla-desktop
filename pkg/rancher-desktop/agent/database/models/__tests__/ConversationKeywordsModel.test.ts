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

  it('returns exact matches without falling back to fuzzy or title/summary search', async() => {
    postgresClient.query = jest.fn(async() => [{ thread_id: 't1', match_reason: 'exact', matched_term: 'sulla' }]) as any;
    const hits = await ConversationKeywordsModel.searchByTerm('Sulla');
    expect(hits).toHaveLength(1);
    expect(postgresClient.query).toHaveBeenCalledTimes(1);
    const [sql] = (postgresClient.query as any).mock.calls[0];
    expect(sql).toContain("'exact' AS match_reason");
    expect(sql).toContain('ck.term = $1');
  });

  it('falls back to pg_trgm fuzzy match when no exact hit exists', async() => {
    postgresClient.query = (jest.fn() as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ thread_id: 't2', match_reason: 'fuzzy', matched_term: 'sula' }]);
    const hits = await ConversationKeywordsModel.searchByTerm('sula');
    expect(hits).toEqual([{ thread_id: 't2', match_reason: 'fuzzy', matched_term: 'sula' }]);
    expect(postgresClient.query).toHaveBeenCalledTimes(2);
    const [fuzzySql] = (postgresClient.query as any).mock.calls[1];
    expect(fuzzySql).toContain('similarity(ck.term, $1)');
  });

  it('falls back to conversation_history title/summary ILIKE when term/fuzzy both miss', async() => {
    postgresClient.query = (jest.fn() as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ thread_id: 't3', match_reason: 'title_summary_fallback' }]);
    const hits = await ConversationKeywordsModel.searchByTerm('unindexed phrase');
    expect(hits).toEqual([{ thread_id: 't3', match_reason: 'title_summary_fallback' }]);
    expect(postgresClient.query).toHaveBeenCalledTimes(3);
    const [fallbackSql, fallbackParams] = (postgresClient.query as any).mock.calls[2];
    expect(fallbackSql).toContain('ch.title ILIKE $1 OR ch.summary ILIKE $1 OR ch.last_summary ILIKE $1');
    expect(fallbackParams[0]).toBe('%unindexed phrase%');
  });

  it('does not filter conversation_history.hidden — the reader is meant to surface hidden rows', async() => {
    postgresClient.query = jest.fn(async() => []) as any;
    await ConversationKeywordsModel.searchByTerm('anything');
    for (const call of (postgresClient.query as any).mock.calls) {
      expect(call[0]).not.toMatch(/hidden\s*=\s*false/i);
    }
  });

  it('returns empty for a blank term without querying', async() => {
    postgresClient.query = jest.fn() as any;
    await expect(ConversationKeywordsModel.searchByTerm('   ')).resolves.toEqual([]);
    expect(postgresClient.query).not.toHaveBeenCalled();
  });

  it('lists keywords for a thread, most recent first', async() => {
    postgresClient.query = jest.fn(async() => [{ term: 'sulla', thread_id: 'thread-1' }]) as any;
    const rows = await ConversationKeywordsModel.searchByThread('thread-1');
    expect(rows).toHaveLength(1);
    const [sql, params] = (postgresClient.query as any).mock.calls[0];
    expect(sql).toContain('WHERE thread_id = $1');
    expect(sql).toContain('ORDER BY last_seen DESC');
    expect(params).toEqual(['thread-1', 100]);
  });

  it('returns empty for a blank thread_id without querying', async() => {
    postgresClient.query = jest.fn() as any;
    await expect(ConversationKeywordsModel.searchByThread('  ')).resolves.toEqual([]);
    expect(postgresClient.query).not.toHaveBeenCalled();
  });
});
