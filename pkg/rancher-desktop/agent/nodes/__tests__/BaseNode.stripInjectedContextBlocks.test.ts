import { describe, expect, it, jest } from '@jest/globals';

// stripInjectedContextBlocks doesn't touch any of these services itself, but
// BaseNode.ts imports them at module scope, so they need stubs to import the
// class at all. Mirrors the mock block in BaseNode.providerRecovery.test.ts.
jest.unstable_mockModule('../../languagemodels', () => ({
  getAgentOverrideService: jest.fn(async() => null),
  getPrimaryService:       jest.fn(async() => ({})),
  getSecondaryService:     jest.fn(async() => ({})),
  getSubconsciousService:  jest.fn(async() => ({})),
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

describe('BaseNode.stripInjectedContextBlocks', () => {
  it('strips a <conversation_context> block the same way as the existing observation blocks', async() => {
    const { BaseNode } = await import('../BaseNode');

    class TestNode extends BaseNode<any> {
      async execute(state: any) {
        return { state, decision: { type: 'end' as const } };
      }

      stripBlocks(state: any) {
        this.stripInjectedContextBlocks(state);
      }
    }

    const node = new TestNode('test-node', 'TestNode');

    const state: any = {
      messages: [
        {
          role:    'assistant',
          content: 'Here is my reply.\n\n<conversation_context>\n[thread:abc] prior decision\n</conversation_context>',
        },
      ],
      metadata: {},
    };

    (node as any).stripBlocks(state);

    expect(state.messages[0].content).toBe('Here is my reply.');
  });

  it('strips a <conversation_context> block alongside sibling observation blocks in one message, and from native content arrays', async() => {
    const { BaseNode } = await import('../BaseNode');

    class TestNode extends BaseNode<any> {
      async execute(state: any) {
        return { state, decision: { type: 'end' as const } };
      }

      stripBlocks(state: any) {
        this.stripInjectedContextBlocks(state);
      }
    }

    const node = new TestNode('test-node', 'TestNode');

    const state: any = {
      messages: [
        {
          role:    'assistant',
          content: [
            { type: 'text', text: 'Reply text.\n\n<observation_context>\nsome obs\n</observation_context>\n\n<conversation_context>\n[thread:xyz] prior thread\n</conversation_context>' },
          ],
        },
      ],
      metadata: {},
    };

    (node as any).stripBlocks(state);

    expect(state.messages[0].content[0].text).toBe('Reply text.');
  });

  it('leaves conversation_context untouched on non-assistant messages', async() => {
    const { BaseNode } = await import('../BaseNode');

    class TestNode extends BaseNode<any> {
      async execute(state: any) {
        return { state, decision: { type: 'end' as const } };
      }

      stripBlocks(state: any) {
        this.stripInjectedContextBlocks(state);
      }
    }

    const node = new TestNode('test-node', 'TestNode');

    const state: any = {
      messages: [
        { role: 'user', content: 'Please recall <conversation_context>not a real block</conversation_context>' },
      ],
      metadata: {},
    };

    (node as any).stripBlocks(state);

    expect(state.messages[0].content).toBe('Please recall <conversation_context>not a real block</conversation_context>');
  });

  it('injects all subconscious output into one fresh assistant message before the latest user turn', async() => {
    const { BaseNode } = await import('../BaseNode');

    class TestNode extends BaseNode<any> {
      async execute(state: any) {
        return { state, decision: { type: 'end' as const } };
      }

      injectContext(state: any) {
        this.injectSubconsciousAssistantContext(state);
      }
    }

    const node = new TestNode('test-node', 'TestNode');
    const state: any = {
      messages: [
        { role: 'user', content: 'old turn' },
        { role: 'assistant', content: 'real historical answer' },
        { role: 'user', content: 'current turn' },
      ],
      metadata: {
        humanIdentityContext:    'durable human identity',
        observationalMemoryContext: 'top observations',
        observationContext:      'targeted recall',
        conversationContext:     'prior conversation',
      },
    };

    (node as any).injectContext(state);

    expect(state.messages.map((message: any) => message.role)).toEqual([
      'user', 'assistant', 'assistant', 'user',
    ]);
    expect(state.messages[1].content).toBe('real historical answer');
    expect(state.messages[2].metadata).toEqual({ source: 'subconscious_context', _synthetic: true });
    expect(state.messages[2].content).toContain('<human_identity_context>\ndurable human identity\n</human_identity_context>');
    expect(state.messages[2].content).toContain('<observational_memory>\ntop observations\n</observational_memory>');
    expect(state.messages[2].content).toContain('<observation_context>\ntargeted recall\n</observation_context>');
    expect(state.messages[2].content).toContain('<conversation_context>\nprior conversation\n</conversation_context>');
  });

  it('replaces the prior synthetic context carrier instead of accumulating it', async() => {
    const { BaseNode } = await import('../BaseNode');

    class TestNode extends BaseNode<any> {
      async execute(state: any) {
        return { state, decision: { type: 'end' as const } };
      }

      injectContext(state: any) {
        this.injectSubconsciousAssistantContext(state);
      }
    }

    const node = new TestNode('test-node', 'TestNode');
    const state: any = {
      messages: [
        {
          role: 'assistant',
          content: '<human_identity_context>\nstale\n</human_identity_context>',
          metadata: { source: 'subconscious_context', _synthetic: true },
        },
        { role: 'user', content: 'current turn' },
      ],
      metadata: { humanIdentityContext: 'fresh' },
    };

    (node as any).injectContext(state);

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].content).toContain('fresh');
    expect(state.messages[0].content).not.toContain('stale');
  });
});
