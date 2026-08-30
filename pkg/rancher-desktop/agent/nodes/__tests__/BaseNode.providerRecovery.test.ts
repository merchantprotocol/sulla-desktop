import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const primaryChatStreamMock: any = jest.fn();
const primaryChatMock: any = jest.fn();
const secondaryChatMock: any = jest.fn();

const primaryService = {
  getContextWindow: jest.fn(() => 100_000),
  getModel:         jest.fn(() => 'claude-code'),
  getProviderName:  jest.fn(() => 'Claude Code'),
  chatStream:       primaryChatStreamMock,
  chat:             primaryChatMock,
};

const secondaryService = {
  getModel:        jest.fn(() => 'gpt-5'),
  getProviderName: jest.fn(() => 'OpenAI'),
  initialize:      jest.fn(async() => true),
  isAvailable:     jest.fn(() => true),
  chat:            secondaryChatMock,
};

jest.unstable_mockModule('../../languagemodels', () => ({
  getAgentOverrideService: jest.fn(async() => null),
  getPrimaryService:       jest.fn(async() => primaryService),
  getSecondaryService:     jest.fn(async() => secondaryService),
  getSubconsciousService:  jest.fn(async() => primaryService),
}));

jest.unstable_mockModule('../../controllers/ChatController', () => ({
  ChatController: class MockChatController {
    private mode = 'text';

    setMode(mode: string) { this.mode = mode }
    getMode() { return this.mode }
    buildContext() { return {} }
    reset() {}
    processChunk(token: string) { return token }
    processComplete(content: string, metadata: any) {
      return { content, metadata };
    }
    processNonVoiceSpeak() {}
  },
}));

jest.unstable_mockModule('../../controllers/ToolExecutor', () => ({
  ToolExecutor: class MockToolExecutor {
    ctx: any;

    constructor(ctx: any) {
      this.ctx = ctx;
    }

    buildToolAccessPolicyForCall() {
      return {};
    }

    async filterLLMToolsByAccessPolicy(tools: any[]) {
      return { tools };
    }
  },
}));

jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: {
    get: jest.fn(async(_key: string, fallback: any) => fallback),
    set: jest.fn(async() => undefined),
  },
}));

jest.unstable_mockModule('../../services/JsonParseService', () => ({
  parseJson: jest.fn((value: string) => JSON.parse(value)),
}));

jest.unstable_mockModule('../../services/WebSocketClientService', () => ({
  getWebSocketClientService: jest.fn(() => ({
    send: jest.fn(),
  })),
}));

jest.unstable_mockModule('../../tools/registry', () => ({
  toolRegistry: {
    convertToolToLLM:          jest.fn(async() => null),
    getSlimPrimaryLLMTools:    jest.fn(async() => []),
    getLLMToolsFor:            jest.fn(async() => []),
    getToolsByCategory:        jest.fn(async() => []),
    getToolNamesForCategory:   jest.fn(() => []),
    getToolNames:              jest.fn(() => []),
    getNativeToolDefinitions:  jest.fn(() => new Map()),
  },
}));

describe('BaseNode provider recovery', () => {
  beforeEach(() => {
    primaryChatStreamMock.mockReset();
    primaryChatMock.mockReset();
    secondaryChatMock.mockReset();

    primaryChatStreamMock.mockRejectedValue(new Error('Codex app-server event stream lag dropped events'));
    primaryChatMock.mockRejectedValue(new Error('codex exited with code null'));
    secondaryChatMock.mockResolvedValue({
      content:  'fallback response ok',
      metadata: {
        rawProviderContent: 'fallback response ok',
      },
    });
  });

  it('retries a recoverable primary failure, then appends successful secondary fallback metadata', async() => {
    const { BaseNode } = await import('../BaseNode');

    class TestNode extends BaseNode<any> {
      async execute(state: any) {
        const reply = await this.normalizedChat(state, 'System prompt', { disableTools: true });
        return { state, decision: { type: 'end' as const }, response: reply?.content ?? '' };
      }
    }

    const state: any = {
      messages: [
        { role: 'user', content: 'Please answer.' },
      ],
      metadata: {
        threadId:  'test-thread',
        wsChannel: 'test-channel',
        options:   {},
      },
    };

    const node = new TestNode('test-node', 'TestNode');
    const result = await node.execute(state);

    expect(primaryChatStreamMock).toHaveBeenCalledTimes(1);
    expect(primaryChatMock).toHaveBeenCalledTimes(1);
    expect(secondaryChatMock).toHaveBeenCalledTimes(1);
    expect(result.response).toBe('fallback response ok');

    const assistantMessage = state.messages[state.messages.length - 1];
    expect(assistantMessage).toMatchObject({
      role:    'assistant',
      content: 'fallback response ok',
    });

    const fallbackReply = secondaryChatMock.mock.results[0].value;
    await expect(fallbackReply).resolves.toMatchObject({
      metadata: {
        fallback_used:   true,
        fallback_from:   'Claude Code',
        fallback_to:     'OpenAI',
        fallback_reason: 'unavailable',
        failed_model:    'claude-code',
        fallback_model:  'gpt-5',
      },
    });
  });

  it('ends the graph cycle without re-dispatching an already persisted assistant response', async() => {
    const { BaseNode } = await import('../BaseNode');

    class TestNode extends BaseNode<any> {
      async execute(state: any) {
        const reply = await this.normalizedChat(state, 'System prompt', { disableTools: true });
        return { state, decision: { type: 'end' as const }, response: reply };
      }
    }

    const state: any = {
      messages: [
        { role: 'user', content: 'Please answer.' },
        { role: 'assistant', content: 'Already displayed.' },
      ],
      metadata: {
        threadId:      'test-thread',
        wsChannel:     'test-channel',
        options:       {},
        cycleComplete: false,
      },
    };

    const node = new TestNode('test-node', 'TestNode');
    const result: any = await node.execute(state);

    expect(result.response).toMatchObject({
      content:  'Already displayed.',
      metadata: { reusedAssistantMessage: true },
    });
    expect(state.metadata.cycleComplete).toBe(true);
    expect(primaryChatStreamMock).not.toHaveBeenCalled();
    expect(primaryChatMock).not.toHaveBeenCalled();
    expect(secondaryChatMock).not.toHaveBeenCalled();
  });
});
