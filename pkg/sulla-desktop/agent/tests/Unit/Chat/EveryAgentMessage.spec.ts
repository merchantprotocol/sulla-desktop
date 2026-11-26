// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';

import { expect, it, onTestFinished, vi } from 'vitest';
import { ref } from 'vue';

import type { ChatMessage } from '@pkg/agent/database/registry/AgentPersonaRegistry';
import { ClaudeAssistantMessageStream } from '@pkg/agent/languagemodels/ClaudeCodeService';
import { CodexAssistantMessageStream } from '@pkg/agent/languagemodels/CodexService';
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
  private readonly dispatcher = createMessageDispatcher();

  constructor() {
    onTestFinished(() => this.chat.dispose());
  }

  emit(data: Record<string, unknown>): void {
    this.dispatcher.dispatch(this.context as any, 'fixture-agent', 'fixture-thread', { type: 'assistant_message', data } as any);
    this.adapter.syncMessages();
  }

  async replay(events: Event[], responseText: string): Promise<void> {
    await this.replayProvider(new ScriptedProvider(events, responseText));
  }

  async replayProvider(provider: { getModel(): string; chatStream(messages: ChatMessage[], callbacks: any): Promise<any> }): Promise<void> {
    const fixture = this;
    const node = Object.create(BaseNode.prototype) as any;
    node.name = 'fixture-agent';
    node.getChatController = () => ({
      getMode: () => 'text', buildContext: () => ({}), reset() {},
      processChunk: (token: string) => token, processComplete() {},
    });
    node.voiceLog = () => {};
    node.recordedReplyAttribution = () => ({ model: 'fixture-model' });
    node.replyReporting = () => undefined;
    node.wsChatMessage = async (_state: unknown, content: string, role: string, kind: string, extras: Record<string, unknown> = {}) => {
      fixture.emit({ content, role, kind, thread_id: 'fixture-thread', ...extras });
      return true;
    };
    const state = { metadata: { threadId: 'fixture-thread', wsChannel: 'fixture-agent' }, messages: [] } as any;
    await node.callLLMStreaming(state, [], {}, {}, provider);
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
