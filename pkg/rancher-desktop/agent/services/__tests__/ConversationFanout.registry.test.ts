import { describe, expect, it, jest } from '@jest/globals';

const convertToolToLLM = jest.fn((name: string) => Promise.resolve({ name }));

jest.unstable_mockModule('relaxed-json', () => ({
  parse: jest.fn((value: string) => JSON.parse(value)),
}));

jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: {
    get: jest.fn((key: string, fallback: string) => Promise.resolve(
      key === 'modelMode' ? 'remote' : key === 'remoteModel' ? 'test-model' : fallback,
    )),
  },
}));

jest.unstable_mockModule('../../tools/registry', () => ({
  toolRegistry: {
    convertToolToLLM,
    registerManifests: jest.fn(),
  },
}));

function parentState(): any {
  return {
    messages: [
      { role: 'user', content: 'What did we decide about the registry?' },
      { role: 'assistant', content: 'We chose an awaited pre-turn fan-out.' },
    ],
    metadata: {
      threadId:              'parent-thread',
      wsChannel:             'profile-42',
      agentId:               'primary-agent',
      channelId:             'profile-42',
      conversationHistoryId: 'history-42',
    },
  };
}

describe('GraphRegistry Conversation Writer + Reader factories', () => {
  it('builds both live roles with narrow, disjoint tool policies', async() => {
    const { GraphRegistry } = await import('../GraphRegistry');
    const parent = parentState();

    const writer = await GraphRegistry.createConversationWriter(parent);
    const reader = await GraphRegistry.createConversationReader(parent);

    expect((writer.state.metadata as any).allowedToolNames).toEqual([
      'upsert_conversation_keywords',
    ]);
    expect((reader.state.metadata as any).allowedToolNames).toEqual([
      'search_conversation_keywords',
      'search_conversation_logs',
    ]);
    expect((writer.state as any).llmTools).toEqual([
      { name: 'upsert_conversation_keywords' },
    ]);
    expect((reader.state as any).llmTools).toEqual([
      { name: 'search_conversation_keywords' },
      { name: 'search_conversation_logs' },
    ]);
  });

  it('keeps only the post-episode writer silent and carries no profile-specific prompt', async() => {
    const { GraphRegistry } = await import('../GraphRegistry');
    const parent = parentState();

    const writer = await GraphRegistry.createConversationWriter(parent);
    const reader = await GraphRegistry.createConversationReader(parent);
    const writerMeta = writer.state.metadata as any;
    const readerMeta = reader.state.metadata as any;

    expect(writerMeta.agentLabel).toBe('conversation-writer');
    expect(writerMeta.subconsciousSilent).toBe(true);
    expect(readerMeta.agentLabel).toBe('conversation-reader');
    expect(readerMeta.subconsciousSilent).toBe(false);
    expect(writerMeta.systemPrompt).not.toContain('profile-42');
    expect(readerMeta.systemPrompt).not.toContain('profile-42');
  });
});
