import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// Regression coverage for the conversation-log blank-content bug (Projects
// task 7BAO): streaming/thinking chunks carry the real assistant text but
// are deliberately excluded from the conversation log as noise, while the
// empty 'streaming_complete'/'thinking_complete' boundary sentinels used to
// slip through the old logging condition and get logged as blank rows.
// wsChatMessage must log real content once (non-streaming/thinking kinds)
// and must never log empty sentinel content.

const logMessageMock: any = jest.fn();
const logToolCallMock: any = jest.fn();
const wsSendMock: any = jest.fn(async() => true);

// BaseNode reaches the conversation logger through a lazy `require(...)`
// inside a try/catch (deliberate — avoids a hard import cycle). Under
// ts-jest's ESM mode `require` doesn't exist as a global at all (throws
// "require is not defined"), so the try/catch silently no-ops and
// jest.unstable_mockModule alone never intercepts it. Polyfill a minimal
// `require` so the existing lazy-load pattern resolves to these mocks —
// this mirrors how it actually resolves in the real Electron/Node runtime.
(globalThis as any).require = (id: string) => {
  if (id.includes('ConversationLogger')) {
    return {
      getConversationLogger: () => ({
        logMessage:  logMessageMock,
        logToolCall: logToolCallMock,
      }),
    };
  }
  throw new Error(`unmocked require() in test: ${ id }`);
};

jest.unstable_mockModule('../../languagemodels', () => ({
  getAgentOverrideService: jest.fn(async() => null),
  getPrimaryService:       jest.fn(async() => null),
  getSecondaryService:     jest.fn(async() => null),
  getSubconsciousService:  jest.fn(async() => null),
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
    send:        wsSendMock,
    onMessage:   jest.fn(),
    connect:     jest.fn(() => true),
    isConnected: jest.fn(() => true),
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

jest.unstable_mockModule('../../utils/stripProtocolTags', () => ({
  stripProtocolTags:         (s: string) => s,
  stripProtocolTagsStreaming: (s: string) => s,
}));

describe('BaseNode conversation logging', () => {
  beforeEach(() => {
    logMessageMock.mockReset();
    logToolCallMock.mockReset();
    wsSendMock.mockClear();
  });

  const buildState = () => ({
    messages: [],
    metadata: {
      threadId:       'test-thread',
      wsChannel:      'test-channel',
      conversationId: 'conv-123',
    },
  }) as any;

  it('logs real assistant content once for a normal (non-streaming) message', async() => {
    const { BaseNode } = await import('../BaseNode');

    class TestNode extends BaseNode<any> {
      async execute(state: any) {
        return { state, decision: { type: 'end' as const }, response: '' };
      }

      async send(state: any, content: string, kind = 'progress') {
        return this.wsChatMessage(state, content, 'assistant', kind);
      }
    }

    const node = new TestNode('test-node', 'TestNode');
    const state = buildState();

    await node.send(state, 'Here is the daily briefing you asked for.');

    expect(logMessageMock).toHaveBeenCalledTimes(1);
    expect(logMessageMock).toHaveBeenCalledWith('conv-123', 'assistant', 'Here is the daily briefing you asked for.');
  });

  it('does not log individual streaming/thinking chunks', async() => {
    const { BaseNode } = await import('../BaseNode');

    class TestNode extends BaseNode<any> {
      async execute(state: any) {
        return { state, decision: { type: 'end' as const }, response: '' };
      }

      async send(state: any, content: string, kind: string) {
        return this.wsChatMessage(state, content, 'assistant', kind);
      }
    }

    const node = new TestNode('test-node', 'TestNode');
    const state = buildState();

    await node.send(state, 'partial toke', 'streaming');
    await node.send(state, 'reasoning about the plan', 'thinking');

    expect(logMessageMock).not.toHaveBeenCalled();
  });

  it('does not log empty streaming_complete/thinking_complete boundary sentinels', async() => {
    const { BaseNode } = await import('../BaseNode');

    class TestNode extends BaseNode<any> {
      async execute(state: any) {
        return { state, decision: { type: 'end' as const }, response: '' };
      }

      async send(state: any, kind: string) {
        return this.wsChatMessage(state, '', 'assistant', kind);
      }
    }

    const node = new TestNode('test-node', 'TestNode');
    const state = buildState();

    await node.send(state, 'streaming_complete');
    await node.send(state, 'thinking_complete');

    expect(logMessageMock).not.toHaveBeenCalled();
  });

  it('suppresses every WebSocket emission from a silent post-turn subconscious writer', async() => {
    const { BaseNode } = await import('../BaseNode');

    class TestNode extends BaseNode<any> {
      async execute(state: any) {
        return { state, decision: { type: 'end' as const }, response: '' };
      }

      async send(state: any, content: string, kind: string, messageType: 'assistant_message' | 'subconscious_message' = 'assistant_message') {
        return this.wsChatMessage(state, content, 'assistant', kind, undefined, messageType);
      }
    }

    const node = new TestNode('test-node', 'TestNode');
    const state = buildState();
    state.metadata.isSubAgent = true;
    state.metadata.subconsciousSilent = true;
    state.metadata.parentWsChannel = 'sulla-desktop';

    // These cover the shared provider-stream paths that bypassed
    // SubconsciousAgentNode.emitThinking() and reopened graphRunning after
    // the primary loop had completed.
    await node.send(state, 'Provider is still thinking', 'thinking');
    await node.send(state, 'partial observer output', 'streaming');
    await node.send(state, '', 'thinking_complete', 'subconscious_message');

    expect(wsSendMock).not.toHaveBeenCalled();
    expect(logMessageMock).not.toHaveBeenCalled();
  });

  it('logConversationMessage lets a caller persist the assembled text after skipping the WS resend', async() => {
    const { BaseNode } = await import('../BaseNode');

    class TestNode extends BaseNode<any> {
      async execute(state: any) {
        return { state, decision: { type: 'end' as const }, response: '' };
      }

      logFullText(state: any, content: string) {
        this.logConversationMessage(state, 'assistant', content);
      }
    }

    const node = new TestNode('test-node', 'TestNode');
    const state = buildState();

    // Mirrors AgentNode's alreadyStreamed branch: streaming already showed
    // this text in the UI, so no wsChatMessage WS resend — but the log
    // still needs the full text since 'streaming' chunks weren't logged.
    node.logFullText(state, 'The full assembled reply text.');

    expect(logMessageMock).toHaveBeenCalledTimes(1);
    expect(logMessageMock).toHaveBeenCalledWith('conv-123', 'assistant', 'The full assembled reply text.');
  });

  it('logConversationToolCall writes a tool_use/tool_result entry for CLI-backed providers', async() => {
    const { BaseNode } = await import('../BaseNode');

    class TestNode extends BaseNode<any> {
      async execute(state: any) {
        return { state, decision: { type: 'end' as const }, response: '' };
      }

      logTool(state: any) {
        this.logConversationToolCall(state, 'Read', { file_path: '/etc/hosts' }, { chars: 240, error: undefined });
      }
    }

    const node = new TestNode('test-node', 'TestNode');
    const state = buildState();

    node.logTool(state);

    expect(logToolCallMock).toHaveBeenCalledTimes(1);
    expect(logToolCallMock).toHaveBeenCalledWith(
      'conv-123', 'Read', { file_path: '/etc/hosts' }, { chars: 240, error: undefined },
    );
  });

  it('skips logging entirely when the state has no conversationId', async() => {
    const { BaseNode } = await import('../BaseNode');

    class TestNode extends BaseNode<any> {
      async execute(state: any) {
        return { state, decision: { type: 'end' as const }, response: '' };
      }

      logFullText(state: any, content: string) {
        this.logConversationMessage(state, 'assistant', content);
      }
    }

    const node = new TestNode('test-node', 'TestNode');
    const state = buildState();
    delete state.metadata.conversationId;

    node.logFullText(state, 'orphaned text with no conversation to attach to');

    expect(logMessageMock).not.toHaveBeenCalled();
  });
});
