// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';

import { expect, it, onTestFinished, vi } from 'vitest';
import { ref } from 'vue';

import type { ChatMessage } from '@pkg/agent/database/registry/AgentPersonaRegistry';
import { ClaudeAssistantMessageStream } from '@pkg/agent/languagemodels/ClaudeCodeService';
import { CodexAssistantMessageStream, CodexService } from '@pkg/agent/languagemodels/CodexService';
import { AgentNode } from '@pkg/agent/nodes/AgentNode';
import { BaseNode } from '@pkg/agent/nodes/BaseNode';
import { DetailedTraceProjection } from '@pkg/pages/chat/components/transcript/DetailedTraceProjection';
import { TranscriptReporting } from '@pkg/pages/chat/components/transcript/toolGroups';
import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import type { Message } from '@pkg/pages/chat/models/Message';
import { PersonaAdapter } from '@pkg/pages/chat/services/PersonaAdapter';
import { createMessageDispatcher } from '../../../database/models/MessageDispatcher';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test', isPackaged: false }, safeStorage: {} }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(), send: vi.fn(), sendSync: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('@pkg/pages/agent/ChatInterface', () => ({ ChatInterface: class {} }));

type Event =
  | { type: 'token'; text: string }
  | { type: 'activity'; text: string }
  | { type: 'message-boundary' };

class ScriptedProvider {
  constructor(private readonly events: Event[], private readonly responseText: string) {}

  getModel(): string { return 'fixture-model'; }

  async chatStream(_messages: ChatMessage[], callbacks: any): Promise<any> {
    const assistantMessages = new ClaudeAssistantMessageStream(callbacks);
    for (const event of this.events) {
      if (event.type === 'token') {
        callbacks.onToken(event.text);
        assistantMessages.noteText();
      }
      else if (event.type === 'activity') callbacks.onActivity(event.text, 'tool');
      else assistantMessages.onStreamEvent('message_stop');
    }
    return { content: this.responseText, metadata: { model: 'fixture-model' } };
  }
}

class TranscriptFixture {
  readonly context = {
    messages: ref<ChatMessage[]>([]).value,
    graphRunning: ref(true),
    currentActivity: ref(''),
    toolRunIdToMessageId: new Map(),
    registry: { setLoading() {} },
  };
  readonly chat = new ChatController();
  readonly adapter: { syncMessages(): void } = Object.assign(Object.create(PersonaAdapter.prototype), {
    controller: this.chat,
    ci: { messages: ref(this.context.messages), graphRunning: this.context.graphRunning, threadId: ref('fixture-thread') },
    seen: new Set<string>(),
    seenRunning: new Set<string>(),
    optimisticUserMessages: new Map(),
    pendingA2aStatuses: new Map(),
    firstSeenAt: new Map(),
    firstCompletedAt: new Map(),
    lastMappedHash: new Map(),
    lastRawSignature: new Map(),
    persistentArtifacts: new Set(),
  }) as PersonaAdapter & { syncMessages(): void };
  readonly reporting = new TranscriptReporting();
  readonly emitted: Record<string, unknown>[] = [];
  readonly conversationLogs: string[] = [];
  lastStateMessages: ChatMessage[] = [];
  lastRunContextMessages: ChatMessage[] = [];
  private readonly dispatcher = createMessageDispatcher();

  constructor() {
    onTestFinished(() => this.chat.dispose());
  }

  emit(data: Record<string, unknown>): void {
    this.emitted.push({ ...data });
    this.dispatcher.dispatch(this.context as any, 'fixture-agent', 'fixture-thread', { type: 'assistant_message', data } as any);
    this.adapter.syncMessages();
  }

  async replay(events: Event[], responseText: string): Promise<void> {
    await this.replayProvider(new ScriptedProvider(events, responseText));
  }

  async replayProvider(provider: { getModel(): string; chatStream(messages: ChatMessage[], callbacks: any): Promise<any> }, mode: 'text' | 'voice' = 'text'): Promise<any> {
    const node = this.createNode(BaseNode.prototype, mode);
    const state = { metadata: { threadId: 'fixture-thread', wsChannel: 'fixture-agent' }, messages: [] } as any;
    const reply = await node.callLLMStreaming(state, [], {}, {}, provider);
    this.lastStateMessages = state.messages;
    return { reply, state, node };
  }

  async replayAgentProvider(provider: { getModel(): string; chatStream(messages: ChatMessage[], callbacks: any): Promise<any> }): Promise<any> {
    const node = this.createNode(AgentNode.prototype, 'text');
    node.id = 'fixture-agent';
    node.currentNodeRunContext = { messages: [] };
    node.normalizedChat = async(state: any, _systemPrompt: string, _options: any) => {
      const reply = await node.callLLMStreaming(state, state.messages, {}, {}, provider);
      if (reply) node.appendResponse(state, reply.content, reply.metadata.rawProviderContent);
      return reply;
    };
    node.extractAgentOutcome = () => ({ status: 'done' });
    node.toUserVisibleAgentMessage = (content: string) => content;
    node.processPendingToolCalls = async() => {};
    node.logConversationMessage = (_state: unknown, _role: string, content: string) => this.conversationLogs.push(content);
    const state = {
      metadata: { threadId: 'fixture-thread', wsChannel: 'fixture-agent', supportSessionId: 'fixture-support-session' },
      messages: [{ role: 'user', content: 'Replay the provider output.' }],
    } as any;
    const returned = await node.executeAgent('', state);
    this.lastStateMessages = state.messages;
    this.lastRunContextMessages = node.currentNodeRunContext.messages;
    return { returned, state, node };
  }

  private createNode(prototype: object, mode: 'text' | 'voice'): any {
    const fixture = this;
    const node = Object.create(prototype) as any;
    node.id = 'fixture-agent';
    node.name = 'fixture-agent';
    node.getChatController = () => ({
      getMode: () => mode, buildContext: () => ({}), reset() {},
      processChunk: (token: string) => token, processComplete() {},
    });
    node.voiceLog = () => {};
    node.recordedReplyAttribution = () => ({ model: 'fixture-model' });
    node.replyReporting = () => undefined;
    node.bumpStateVersion = () => {};
    node.wsChatMessage = async (_state: unknown, content: string, role: string, kind: string, extras: Record<string, unknown> = {}) => {
      fixture.emit({ content, role, kind, thread_id: 'fixture-thread', ...extras });
      return true;
    };
    return node;
  }

  replyTexts(): string[] {
    return this.chat.messages.value.filter((message): message is Extract<Message, { kind: 'sulla' }> => message.kind === 'sulla').map(message => message.text);
  }

  expectVisibleReplies(expected: string[]): void {
    const info = this.reporting.entries(this.chat.messages.value, 'info');
    const debug = this.reporting.entries(this.chat.messages.value, 'debug');
    const infoReplies = info.filter(entry => entry.kind === 'card' && entry.message.kind === 'sulla').map(entry => entry.message.text);
    const detailedReplies = debug.filter(entry => entry.kind === 'card' && entry.message.kind === 'sulla').map(entry => entry.message.text);
    expect(this.replyTexts()).toEqual(expected);
    expect(infoReplies).toEqual(expected);
    expect(detailedReplies).toEqual(expected);
    const rawSegments = this.context.messages.filter(message => message.kind === 'streaming');
    const segmentIds = rawSegments.map(message => message.replyStreamId);
    expect(rawSegments.map(message => message.content.trim())).toEqual(expected);
    expect(segmentIds.every(id => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(segmentIds).size).toBe(expected.length);
    // DetailedTraceProjection is additive: it must anchor supplemental rows to Standard entries
    // without replacing or combining the reply entries rendered alongside them.
    const trace = new DetailedTraceProjection().project(this.chat.messages.value, info);
    expect(trace.every(turn => info.some(entry => entry.id === turn.anchorEntryId))).toBe(true);
  }
}

// risk: data accuracy — provider tool/activity boundaries must not merge the text replies around them.
it('keeps every assistant segment around interleaved tool activity as a separate Standard and Detailed reply', async() => {
  const fixture = new TranscriptFixture();
  await fixture.replay([
    { type: 'token', text: 'First answer.' },
    { type: 'activity', text: 'Running the first tool' },
    { type: 'token', text: 'Second answer.' },
    { type: 'activity', text: 'Running the second tool' },
    { type: 'token', text: 'Third answer.' },
  ], 'First answer. Second answer. Third answer.');
  fixture.expectVisibleReplies(['First answer.', 'Second answer.', 'Third answer.']);
});

// risk: data accuracy — adjacent provider messages without a tool event must not collapse into one reply.
it('splits adjacent provider assistant messages at explicit message boundaries', async() => {
  const fixture = new TranscriptFixture();
  await fixture.replay([
    { type: 'token', text: 'First assistant ' },
    { type: 'token', text: 'message.' },
    { type: 'message-boundary' },
    { type: 'token', text: 'Second assistant ' },
    { type: 'token', text: 'message.' },
    { type: 'message-boundary' },
  ], 'First assistant message. Second assistant message.');
  fixture.expectVisibleReplies(['First assistant message.', 'Second assistant message.']);
});

// risk: data accuracy — text similarity must never resurrect and overwrite an earlier sealed reply.
it('keeps a later segment that starts with an earlier reply’s words as a new reply', async() => {
  const fixture = new TranscriptFixture();
  await fixture.replay([
    { type: 'token', text: 'The answer begins' },
    { type: 'activity', text: 'Running a tool' },
    { type: 'token', text: 'The answer begins with the second thought.' },
  ], 'The answer begins. The answer begins with the second thought.');
  fixture.expectVisibleReplies(['The answer begins', 'The answer begins with the second thought.']);
});

// risk: data accuracy — Codex deltas and completed agent_message items must preserve each assistant message.
it('keeps each Codex agent_message item as its own reply through both transcript projections', async() => {
  const fixture = new TranscriptFixture();
  await fixture.replayProvider({
    getModel: () => 'fixture-model',
    async chatStream(_messages, callbacks) {
      const stream = new CodexAssistantMessageStream(callbacks);
      stream.appendDelta('First Codex message.');
      stream.completeAgentMessage('First Codex message.', () => {});
      stream.completeAgentMessage('Second Codex message.', () => {});
      expect(stream.text).toBe('First Codex message.\n\nSecond Codex message.');
      return { content: stream.text, metadata: { model: 'fixture-model' } };
    },
  });
  fixture.expectVisibleReplies(['First Codex message.', 'Second Codex message.']);
});

// risk: data accuracy — Claude delta buffers must reset at activity boundaries instead of replaying prior text.
it('does not repeat Claude text when a stream resumes after tool activity and returns the full reply once', async() => {
  const fixture = new TranscriptFixture();
  const first = 'Claude checked the first file.';
  const second = 'Claude checked the second file.';
  const third = 'Claude checked the final file.';
  const fullReply = `${ first }\n\n${ second }\n\n${ third }`;
  const result = await fixture.replayAgentProvider({
    getModel: () => 'fixture-model',
    async chatStream(_messages, callbacks) {
      const stream = new ClaudeAssistantMessageStream(callbacks);
      callbacks.onToken(first);
      stream.noteText();
      callbacks.onActivity('Running a Claude tool', 'tool');
      callbacks.onToken(second);
      stream.noteText();
      stream.onStreamEvent('message_stop');
      callbacks.onActivity('Running another Claude tool', 'tool');
      callbacks.onToken(third);
      stream.noteText();
      stream.onStreamEvent('message_stop');
      return { content: fullReply, metadata: { model: 'fixture-model' } };
    },
  });

  fixture.expectVisibleReplies([first, second, third]);
  expect(result.returned).toBe(fullReply);
  expect(fixture.lastStateMessages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([fullReply]);
  expect(fixture.lastRunContextMessages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([fullReply]);
  expect(fixture.conversationLogs).toEqual([fullReply]);
  expect(fixture.emitted.filter(message => message.kind === 'text')).toHaveLength(0);
  const claudeSegments = fixture.context.messages.filter(message => message.kind === 'streaming');
  expect(claudeSegments.every(message => (message as any)._completed)).toBe(true);
  expect(fixture.emitted.filter(message => message.kind === 'streaming_complete').map(message => message.replyStreamId))
    .toEqual(claudeSegments.map(message => message.replyStreamId));
});

// risk: data accuracy — Codex deltas after a tool must start a fresh UI segment without duplicating the accumulated reply.
it('does not repeat Codex delta text when a stream resumes after tool activity and preserves history once', async() => {
  const fixture = new TranscriptFixture();
  const first = 'Codex checked the first file.';
  const second = 'Codex checked the second file.';
  const third = 'Codex checked the final file.';
  const fullReply = `${ first }\n\n${ second }\n\n${ third }`;
  const result = await fixture.replayAgentProvider({
    getModel: () => 'fixture-model',
    async chatStream(_messages, callbacks) {
      const stream = new CodexAssistantMessageStream(callbacks);
      stream.appendDelta(first);
      stream.completeAgentMessage(first, () => {});
      callbacks.onActivity('Running a Codex tool', 'tool');
      stream.appendDelta(second);
      stream.completeAgentMessage(second, () => {});
      callbacks.onActivity('Running another Codex tool', 'tool');
      stream.appendDelta(third);
      stream.completeAgentMessage(third, () => {});
      return { content: stream.text, metadata: { model: 'fixture-model' } };
    },
  });

  fixture.expectVisibleReplies([first, second, third]);
  expect(result.returned).toBe(fullReply);
  expect(fixture.lastStateMessages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([fullReply]);
  expect(fixture.lastRunContextMessages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([fullReply]);
  expect(fixture.conversationLogs).toEqual([fullReply]);
  expect(fixture.emitted.filter(message => message.kind === 'text')).toHaveLength(0);
  const codexSegments = fixture.context.messages.filter(message => message.kind === 'streaming');
  expect(codexSegments.every(message => (message as any)._completed)).toBe(true);
  expect(fixture.emitted.filter(message => message.kind === 'streaming_complete').map(message => message.replyStreamId))
    .toEqual(codexSegments.map(message => message.replyStreamId));
});

// risk: data accuracy — the completed Codex transcript must retain all message separators when deltas were streamed.
it('returns every Codex message exactly once, in order, with separators after streaming deltas', async() => {
  const service = Object.create(CodexService.prototype) as any;
  service.getModel = () => 'fixture-model';
  service.recordMeterableTokens = async() => {};
  service.usageEventId = () => 'fixture-usage';
  service.runCodex = async(_messages: ChatMessage[], callbacks: any) => {
    const stream = new CodexAssistantMessageStream(callbacks);
    stream.appendDelta('First Codex message.');
    stream.completeAgentMessage('First Codex message.', () => {});
    stream.appendDelta('Second Codex message.');
    stream.completeAgentMessage('Second Codex message.', () => {});
    return { text: stream.text, usage: {} };
  };
  const response = await service.chatStream(
    [{ role: 'user', content: 'Return two messages.' }],
    { onToken() {}, onMessageBoundary() {} },
  );

  expect(response?.content).toBe('First Codex message.\n\nSecond Codex message.');
  expect(response?.content?.match(/First Codex message\./g)).toHaveLength(1);
  expect(response?.content?.match(/Second Codex message\./g)).toHaveLength(1);
});

// risk: data accuracy — provider boundaries with no buffered text must not create empty reply bubbles.
it('does not emit empty replies when provider message boundaries have no buffered text', async() => {
  const fixture = new TranscriptFixture();
  await fixture.replayProvider({
    getModel: () => 'fixture-model',
    async chatStream(_messages, callbacks) {
      callbacks.onMessageBoundary();
      callbacks.onToken('Visible answer.');
      callbacks.onMessageBoundary();
      callbacks.onMessageBoundary();
      return { content: 'Visible answer.', metadata: { model: 'fixture-model' } };
    },
  });

  expect(fixture.context.messages.filter(message => message.kind === 'streaming').map(message => message.content.trim())).toEqual(['Visible answer.']);
  expect(fixture.replyTexts()).toEqual(['Visible answer.']);
  const streamingUpdates = fixture.emitted.filter(message => message.kind === 'streaming');
  expect(streamingUpdates.length).toBeGreaterThan(0);
  expect(streamingUpdates.every(message => typeof message.content === 'string' && message.content.trim().length > 0)).toBe(true);
});

// risk: voice output — text-segment boundary callbacks must not change the voice streaming path.
it('keeps voice-mode output out of text reply bubbles across tool and message boundaries', async() => {
  const fixture = new TranscriptFixture();
  const first = 'Voice first part.';
  const second = 'Voice second part.';
  const fullReply = `${ first } ${ second }`;
  const { reply } = await fixture.replayProvider({
    getModel: () => 'fixture-model',
    async chatStream(_messages, callbacks) {
      const stream = new ClaudeAssistantMessageStream(callbacks);
      callbacks.onToken(first);
      stream.noteText();
      callbacks.onActivity('Running a voice-mode tool', 'tool');
      callbacks.onToken(second);
      stream.noteText();
      stream.onStreamEvent('message_stop');
      return { content: fullReply, metadata: { model: 'fixture-model' } };
    },
  }, 'voice');

  expect(reply.content).toBe(fullReply);
  expect(fixture.context.messages.filter(message => message.kind === 'streaming')).toHaveLength(0);
  expect(fixture.emitted.filter(message => message.kind === 'streaming' || message.kind === 'text')).toHaveLength(0);
});

// risk: data accuracy — when no tokens stream, AgentNode must still dispatch and persist the completed reply once.
it('dispatches one final reply when a provider returns text without streaming tokens', async() => {
  const fixture = new TranscriptFixture();
  const finalReply = 'This provider returned one final reply.';
  const result = await fixture.replayAgentProvider({
    getModel: () => 'fixture-model',
    async chatStream() { return { content: finalReply, metadata: { model: 'fixture-model' } }; },
  });
  const infoReplies = fixture.reporting.entries(fixture.chat.messages.value, 'info')
    .filter(entry => entry.kind === 'card' && entry.message.kind === 'sulla')
    .map(entry => (entry as any).message.text);
  const detailedReplies = fixture.reporting.entries(fixture.chat.messages.value, 'debug')
    .filter(entry => entry.kind === 'card' && entry.message.kind === 'sulla')
    .map(entry => (entry as any).message.text);

  expect(result.returned).toBe(finalReply);
  expect(fixture.replyTexts()).toEqual([finalReply]);
  expect(infoReplies).toEqual([finalReply]);
  expect(detailedReplies).toEqual([finalReply]);
  expect(fixture.emitted.filter(message => message.kind === 'text').map(message => message.content)).toEqual([finalReply]);
  expect(fixture.lastStateMessages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([finalReply]);
});
