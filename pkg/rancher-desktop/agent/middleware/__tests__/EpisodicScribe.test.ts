import { describe, expect, it, jest, beforeEach } from '@jest/globals';

import {
  isSubconsciousThread,
  meetsEpisodeWorkFloor,
  runEpisodicScribe,
} from '../EpisodicScribe';

jest.mock('../../services/GraphRegistry', () => ({
  GraphRegistry: {
    createEpisodicScribe: jest.fn(),
  },
}));

import { GraphRegistry } from '../../services/GraphRegistry';

function msg(role: string, content: any, extra: Record<string, any> = {}) {
  return { role, content, ...extra };
}

describe('EpisodicScribe gates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('isSubconsciousThread matches the subconscious_ prefix only', () => {
    expect(isSubconsciousThread('subconscious_abc')).toBe(true);
    expect(isSubconsciousThread('heartbeat')).toBe(false);
    expect(isSubconsciousThread(null)).toBe(false);
    expect(isSubconsciousThread(12)).toBe(false);
  });

  it('meetsEpisodeWorkFloor is true when any real message carries a tool_use', () => {
    const state: any = {
      messages: [
        msg('user', 'hi'),
        msg('assistant', [{ type: 'tool_use', name: 'read_file', id: '1' }]),
      ],
    };
    expect(meetsEpisodeWorkFloor(state)).toBe(true);
  });

  it('meetsEpisodeWorkFloor is true at ≥4 real user/assistant messages even without tools', () => {
    const state: any = {
      messages: [
        msg('user', 'one'),
        msg('assistant', 'two'),
        msg('user', 'three'),
        msg('assistant', 'four'),
      ],
    };
    expect(meetsEpisodeWorkFloor(state)).toBe(true);
  });

  it('meetsEpisodeWorkFloor ignores subconscious-sourced messages and chit-chat', () => {
    const state: any = {
      messages: [
        msg('user', 'hey', { metadata: { source: 'subconscious' } }),
        msg('assistant', 'ok', { metadata: { source: 'subconscious' } }),
        msg('user', 'hi'),
        msg('assistant', 'hello'),
        msg('system', 'noise'),
      ],
    };
    expect(meetsEpisodeWorkFloor(state)).toBe(false);
  });

  it('runEpisodicScribe returns without launching a scribe on a subconscious thread', async() => {
    await runEpisodicScribe({
      messages: [msg('user', 'a'), msg('assistant', [{ type: 'tool_use', name: 'x', id: '1' }])],
      metadata: { threadId: 'subconscious_scribe' },
    } as any);
    expect(GraphRegistry.createEpisodicScribe).not.toHaveBeenCalled();
  });

  it('runEpisodicScribe returns without launching a scribe below the work floor', async() => {
    await runEpisodicScribe({
      messages: [msg('user', 'hi'), msg('assistant', 'hey')],
      metadata: { threadId: 'sulla-desktop' },
    } as any);
    expect(GraphRegistry.createEpisodicScribe).not.toHaveBeenCalled();
  });

  it('runEpisodicScribe launches the scribe graph when the floor is met', async() => {
    const execute = jest.fn(async(..._args: any[]) => undefined);
    (GraphRegistry.createEpisodicScribe as any).mockResolvedValue({
      graph:    { execute },
      state:    { metadata: { agent: { status: 'done' } }, messages: [] },
      threadId: 'subconscious_scribe_1',
    });

    await runEpisodicScribe({
      messages: [
        msg('user', 'one'),
        msg('assistant', [{ type: 'tool_use', name: 'read_file', id: '1' }]),
      ],
      metadata: { threadId: 'sulla-desktop' },
    } as any);

    expect(GraphRegistry.createEpisodicScribe).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.anything(), 'subconscious', { maxIterations: 10 });
  });
});
