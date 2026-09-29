import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const send = jest.fn<(channel: string, msg: unknown) => Promise<boolean>>();
jest.mock('../../services/WebSocketClientService', () => ({
  getWebSocketClientService: () => ({ send }),
}));

import type { ReflexExampleRow } from '../../database/models/ReflexModel';
import {
  announceReflexLearned,
  buildReflexLearnedPayload,
  formatReflexLearned,
  reflexNoticeTarget,
  shouldAnnounceReflexLearning,
} from '../reflexLearnedNotice';

const row = (over: Partial<ReflexExampleRow>): ReflexExampleRow => ({
  id: 'ex1', utterance: 'pull up the PM system', tool_name: 'open_tab', params: { mode: 'projects' },
  positive: true, source: 'trainer', thread_id: 't1', archived: false, created_at: '', updated_at: '',
  ...over,
});

const trainerState = { metadata: { threadId: 'subconscious-1', wsChannel: 'subconscious:reflex-trainer', parentConversationId: 'thread-A', parentWsChannel: 'sulla-desktop' } };

describe('shouldAnnounceReflexLearning', () => {
  it('announces live writes (trainer, human, model, correction)', () => {
    for (const source of ['trainer', 'human', 'model', 'correction']) {
      expect(shouldAnnounceReflexLearning(source, 1)).toBe(true);
    }
    expect(shouldAnnounceReflexLearning('trainer', 4)).toBe(true);
  });

  it('stays silent for seed/bulk imports and big batches', () => {
    expect(shouldAnnounceReflexLearning('seed', 1)).toBe(false);
    expect(shouldAnnounceReflexLearning('reflex-seed-v1', 1)).toBe(false);
    expect(shouldAnnounceReflexLearning('import', 1)).toBe(false);
    expect(shouldAnnounceReflexLearning('bulk-augment', 2)).toBe(false);
    expect(shouldAnnounceReflexLearning('model', 40)).toBe(false);
    expect(shouldAnnounceReflexLearning('model', 0)).toBe(false);
  });
});

describe('reflexNoticeTarget', () => {
  it('routes a subconscious writer to its parent conversation', () => {
    expect(reflexNoticeTarget(trainerState)).toEqual({ wsChannel: 'sulla-desktop', threadId: 'thread-A' });
  });

  it('routes a primary-agent call to its own conversation', () => {
    expect(reflexNoticeTarget({ metadata: { threadId: 'thread-B', wsChannel: 'sulla-desktop' } }))
      .toEqual({ wsChannel: 'sulla-desktop', threadId: 'thread-B' });
  });

  it('returns null without a bound conversation', () => {
    expect(reflexNoticeTarget(null)).toBeNull();
    expect(reflexNoticeTarget({ metadata: { wsChannel: 'sulla-desktop' } })).toBeNull();
  });
});

describe('buildReflexLearnedPayload / formatReflexLearned', () => {
  it('headlines the first positive example and counts paraphrases', () => {
    const payload = buildReflexLearnedPayload([
      row({ id: 'a' }),
      row({ id: 'b', utterance: 'open projects' }),
      row({ id: 'c', utterance: 'show me the project board' }),
    ], 'trainer')!;
    expect(payload.exampleIds).toEqual(['a', 'b', 'c']);
    expect(payload.extraPhrasings).toBe(2);
    expect(formatReflexLearned(payload)).toBe('⚡ Learned: "pull up the PM system" → Open Projects (+2 phrasings)');
  });

  it('prefers the corrected action over the counter-example, and undoes both', () => {
    const payload = buildReflexLearnedPayload([
      row({ id: 'neg', tool_name: 'tab', params: { action: 'upsert', url: 'https://x.test' }, positive: false }),
      row({ id: 'pos' }),
    ], 'correction')!;
    expect(payload.label).toBe('Open Projects');
    expect(payload.exampleIds).toEqual(['neg', 'pos']);
    expect(payload.extraPhrasings).toBe(0);
  });

  it("labels a counter-example alone as won't run", () => {
    const payload = buildReflexLearnedPayload([row({ positive: false })], 'correction')!;
    expect(payload.label).toBe("won't run Open Projects");
  });

  it('returns null when nothing new was created', () => {
    expect(buildReflexLearnedPayload([], 'trainer')).toBeNull();
  });
});

describe('announceReflexLearned', () => {
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue(true);
  });

  it('posts a subconscious reflex_learned message into the originating thread', async() => {
    await expect(announceReflexLearned(trainerState, [row({})], { source: 'trainer', batchSize: 1 })).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const [channel, msg] = send.mock.calls[0] as [string, any];
    expect(channel).toBe('sulla-desktop');
    // subconscious_message: must not reopen a finished run in the UI.
    expect(msg.type).toBe('subconscious_message');
    expect(msg.data.kind).toBe('reflex_learned');
    expect(msg.data.thread_id).toBe('thread-A');
    expect(msg.data.reflexLearned.exampleIds).toEqual(['ex1']);
  });

  it('sends nothing for seed imports, unbound calls, or already-known rows', async() => {
    await announceReflexLearned(trainerState, [row({})], { source: 'seed', batchSize: 1 });
    await announceReflexLearned(null, [row({})], { source: 'trainer', batchSize: 1 });
    await announceReflexLearned(trainerState, [], { source: 'trainer', batchSize: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws when the socket fails', async() => {
    send.mockRejectedValue(new Error('socket down'));
    await expect(announceReflexLearned(trainerState, [row({})], { source: 'trainer', batchSize: 1 })).resolves.toBe(false);
  });
});
