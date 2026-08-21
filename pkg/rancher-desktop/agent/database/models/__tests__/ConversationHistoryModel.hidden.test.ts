import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { ConversationHistoryModel } from '../ConversationHistoryModel';

describe('ConversationHistoryModel — hidden flag', () => {
  let originalQuery: any;

  beforeAll(() => {
    originalQuery = postgresClient.query;
  });

  afterEach(() => {
    (postgresClient as any).query = originalQuery;
    jest.restoreAllMocks();
  });

  it.each([
    ['subconscious:memory-recall', true],
    ['subconscious:observation', true],
    ['subconscious', true],
    ['codex-test', true],
    ['thinker-worker', true],
    ['opus-worker', true],
    ['fable-planner', true],
    ['sulla-desktop', false],
    ['mobile-relay', false],
    [undefined, false],
  ])('derives hidden=%s for channel_id %s when not explicitly set', async(channelId, expected) => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await ConversationHistoryModel.recordConversation({
      id:         'conv1',
      type:       'graph',
      channel_id: channelId as string | undefined,
    });

    const [, params] = (postgresClient.query as jest.Mock).mock.calls[0] as [string, unknown[]];
    expect(params[params.length - 1]).toBe(expected);
  });

  it('respects an explicit hidden override regardless of channel_id', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await ConversationHistoryModel.recordConversation({
      id:         'conv2',
      type:       'chat',
      channel_id: 'sulla-desktop',
      hidden:     true,
    });

    const [, params] = (postgresClient.query as jest.Mock).mock.calls[0] as [string, unknown[]];
    expect(params[params.length - 1]).toBe(true);
  });

  it('filters hidden rows out of getRecent/search/getByDateRange via the hidden column', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await ConversationHistoryModel.getRecent(10);
    await ConversationHistoryModel.search('foo');
    await ConversationHistoryModel.getByDateRange(new Date(0), new Date());

    const calls = (postgresClient.query as jest.Mock).mock.calls as [string, unknown[]][];
    for (const [sql] of calls) {
      expect(sql).toContain('hidden = FALSE');
      expect(sql).not.toContain("NOT LIKE 'subconscious%'");
    }
  });
});
