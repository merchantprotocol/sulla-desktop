// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../../../database/PostgresClient', () => ({ postgresClient: { query } }));
vi.mock('../../../database/models/ConversationThreadStore', () => ({ ConversationThreadStore: {} }));

import { ConversationHistoryModel } from '../../../database/models/ConversationHistoryModel';
import { BUILTIN_AGENT_RENAMES } from '../../../../shared/agentJobNames';

/** The value recordConversation writes to the `hidden` column for a new row on this channel. */
async function hiddenFor(channel_id: string | undefined, hidden?: boolean): Promise<unknown> {
  query.mockClear();
  await ConversationHistoryModel.recordConversation({ id: `conversation-${ channel_id }`, type: 'chat', channel_id, hidden });
  const [sql, values] = query.mock.calls[0];
  const columns = /\(([^)]*)\)\s*VALUES/.exec(sql)![1].split(',').map((column: string) => column.trim());
  return values[columns.indexOf('hidden')];
}

describe('worker channels in user-facing conversation history', () => {
  beforeEach(() => query.mockReset().mockResolvedValue([]));

  it('keeps the Advisor worker channel hidden under its current name and its earlier one', async() => {
    const advisor = BUILTIN_AGENT_RENAMES.find(([previous]) => previous === 'opus-worker')!;
    // risk: renaming the built-in agent would surface its internal worker conversations in History
    expect(await hiddenFor(advisor[1])).toBe(true);
    expect(await hiddenFor(advisor[0])).toBe(true);
    expect(advisor[1]).toBe('advisor');
  });

  it('still hides the other internal channels and shows ordinary chats', async() => {
    for (const channel of ['codex-test', 'thinker-worker', 'fable-planner', 'subconscious:memory-recall']) {
      expect(await hiddenFor(channel), channel).toBe(true);
    }
    for (const channel of ['sulla-desktop', 'account-manager', 'builder', undefined]) {
      expect(await hiddenFor(channel), String(channel)).toBe(false);
    }
  });

  it('lets a caller decide explicitly either way', async() => {
    expect(await hiddenFor('advisor', false)).toBe(false);
    expect(await hiddenFor('sulla-desktop', true)).toBe(true);
  });
});
