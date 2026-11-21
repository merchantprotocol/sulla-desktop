// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import '../../Support/TestHomeEnv';

import { flushPromises, mount } from '@vue/test-utils';
import { expect, it, onTestFinished, vi } from 'vitest';
import { ref } from 'vue';

import { createMessageDispatcher } from '@pkg/agent/database/models/MessageDispatcher';
import type { ChatMessage } from '@pkg/agent/database/registry/AgentPersonaRegistry';
import Transcript from '@pkg/pages/chat/components/transcript/Transcript.vue';
import { TranscriptReporting } from '@pkg/pages/chat/components/transcript/toolGroups';
import ToolApproval from '@pkg/pages/chat/components/tool/ToolApproval.vue';
import { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import type { Message } from '@pkg/pages/chat/models/Message';
import type { ReportingLevel } from '@pkg/pages/chat/models/ReportingLevel';
import { PersonaAdapter } from '@pkg/pages/chat/services/PersonaAdapter';
import { asMessageId, asThreadId } from '@pkg/pages/chat/types/chat';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(), send: vi.fn(), sendSync: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('@pkg/pages/agent/ChatInterface', () => ({ ChatInterface: class {} }));

class ReportingFixture {
  readonly ctx = {
    messages: ref<ChatMessage[]>([]).value, graphRunning: ref(false),
    currentActivity: ref(''), toolRunIdToMessageId: new Map(), registry: { setLoading() {} },
  };

  private readonly dispatcher = createMessageDispatcher();
  private readonly adapter = Object.create(PersonaAdapter.prototype);
  readonly reporting = new TranscriptReporting();

  constructor(readonly chat = new ChatController()) {
    onTestFinished(() => chat.dispose());
    Object.assign(this.adapter, {
      controller: chat, ci: { messages: ref(this.ctx.messages), graphRunning: this.ctx.graphRunning, threadId: ref('fixture-thread') },
      seen: new Set(), seenRunning: new Set(), optimisticUserMessages: new Map(), pendingA2aStatuses: new Map(),
      firstSeenAt: new Map(), firstCompletedAt: new Map(), lastMappedHash: new Map(), lastRawSignature: new Map(),
      persistentArtifacts: new Set(),
    });
  }

  emit(type: 'progress' | 'assistant_message', data: object) {
    this.dispatcher.dispatch(this.ctx as any, 'fixture-agent', 'fixture-thread', { type, data } as any);
    this.adapter.syncMessages();
  }

  resolveWaitingGate(id: string) {
    this.adapter.armDecisionResume(id, 'fixture-thread');
  }

  entries(level: ReportingLevel) {
    return this.reporting.entries(this.chat.messages.value, level);
  }

  mount(level: ReportingLevel) {
    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    if (!scroll) Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value() {} });
    const wrapper = mount(Transcript, {
      props:  { reportingLevel: level },
      global: { provide: { [ChatControllerKey as symbol]: this.chat } },
    });
    onTestFinished(() => {
      wrapper.unmount();
      if (!scroll) Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
    });
    return wrapper;
  }
}

// risk: private reasoning or tool payloads escape on live, saved or paged paths;
// work moves ahead of interleaved evidence or duplicates when live state is restored.
it('projects safe individual events in source order before and after tool settlement and reload', () => {
  const live = new ReportingFixture();
  live.emit('assistant_message', { kind: 'thinking', content: 'Preparing your turn…' });
  live.emit('assistant_message', { kind: 'thinking', content: '💭 PRIVATE_REASONING' });
  live.emit('assistant_message', { kind: 'citation', citations: [{ num: 1, title: 'Evidence', origin: 'fixture' }] });
  live.emit('assistant_message', { kind: 'thinking', content: '$ echo PRIVATE_COMMAND' });
  live.emit('progress', { phase: 'tool_call', toolRunId: 'fixture-call', toolName: 'exec', args: { command: 'echo PRIVATE_INPUT' } });
  live.emit('assistant_message', { kind: 'thinking', content: 'Tools connected — calling model' });

  const debug = live.entries('debug');
  expect(debug.map(row => row.kind === 'activity' ? row.text : row.message.kind)).toEqual([
    'Preparing your turn…', 'citation', 'Running a shell command', 'Shell · Running', 'Tools connected — calling model',
  ]);
  expect(live.entries('info').map(row => row.id)).toEqual([debug[0].id, debug[1].id, debug[4].id]);
  expect(live.entries('fatal').map(row => row.id)).toEqual([debug[1].id]);
  expect(JSON.stringify(debug)).not.toContain('PRIVATE_');

  live.emit('progress', { phase: 'tool_result', toolRunId: 'fixture-call', success: false, error: 'PRIVATE_ERROR', result: 'PRIVATE_OUTPUT' });
  const settled = live.entries('debug');
  expect(settled.map(row => row.id)).toEqual(debug.map(row => row.id));
  expect(live.entries('info')).toContainEqual({ ...debug[3], level: 'info', text: 'Shell · Failed' });
  expect(live.entries('fatal').map(row => row.id)).toEqual([debug[1].id]);
  expect(JSON.stringify(settled)).not.toContain('PRIVATE_');

  const reopened = new ReportingFixture(new ChatController({ hydrateFrom: JSON.parse(JSON.stringify(live.chat.serialize())) }));
  reopened.chat.prependOlder([...reopened.chat.messages.value, {
    id: asMessageId('legacy-tool'), createdAt: 1, kind: 'tool', tool: 'Bash',
    desc: 'PRIVATE_LEGACY', input: 'PRIVATE_LEGACY', status: 'ok',
  }]);
  expect(reopened.entries('debug')).toEqual(settled);
  expect(reopened.chat.messages.value.some(message => message.id === 'legacy-tool')).toBe(true);
});

// risk: filtering hides an unanswered gate, a deliverable, or a run-ending
// error (which may arrive as an assistant reply instead of an ErrorCard).
it('keeps the original actionable cards and terminal failure at every level', async() => {
  const live = new ReportingFixture();
  const approval: Message = {
    id: asMessageId('pending-approval'), createdAt: 1, kind: 'tool_approval',
    approvalId: 'approve-123', decision: 'pending', reason: 'Human permission required', command: 'review --publish',
  };
  const deliverable: Message = { id: asMessageId('deliverable'), createdAt: 2, kind: 'sulla', model: 'test', text: 'Delivered the requested report.' };
  live.chat.appendMessage(approval);
  live.chat.appendMessage(deliverable);
  live.emit('assistant_message', { kind: 'thinking', content: '$ synthetic command' });
  live.emit('assistant_message', { runEnded: true, content: 'The execution environment stopped.' });
  const wrapper = live.mount('info');
  const approvalCard = wrapper.getComponent(ToolApproval);
  const approve = vi.spyOn(live.chat, 'approveTool').mockImplementation(() => {});

  for (const level of ['debug', 'fatal', 'info'] as const) {
    await wrapper.setProps({ reportingLevel: level });
    expect(wrapper.getComponent(ToolApproval).vm).toBe(approvalCard.vm);
    expect(approvalCard.props('msg')).toMatchObject(approval);
    expect(wrapper.text()).toContain(deliverable.text);
    expect(wrapper.text()).toContain('The execution environment stopped.');
    expect(wrapper.text().includes('Running a shell command')).toBe(level === 'debug');
    expect(live.entries(level).at(-1)).toMatchObject({ kind: 'card', level: 'fatal' });
  }
  await wrapper.setProps({ reportingLevel: 'fatal' });
  await approvalCard.get('button.approve').trigger('click');
  expect(approve).toHaveBeenCalledExactlyOnceWith(approval.id);
});

// risk: a delayed history response from a previously selected thread
// displays that thread's content in the current conversation.
it('ignores an old page if the active thread changes while loading', async() => {
  const live = new ReportingFixture();
  let finishPage!: (data: unknown) => void;
  vi.mocked(ipcRenderer.invoke).mockImplementation((channel: string) => {
    if (channel === 'chat-messages:message-count') return Promise.resolve({ success: true, count: 5 });
    if (channel === 'chat-messages:load-before') return new Promise(resolve => { finishPage = resolve; });
    return Promise.resolve(undefined);
  });
  onTestFinished(() => vi.mocked(ipcRenderer.invoke).mockReset());
  live.chat.appendMessage({ id: asMessageId('original'), kind: 'user', createdAt: 1, text: 'Original chat' });
  const wrapper = live.mount('debug');
  await wrapper.get('.scroller').trigger('scroll');
  await flushPromises();
  expect(finishPage).toBeTypeOf('function');

  live.chat.thread.value = { ...live.chat.thread.value, id: asThreadId('another-thread'), messages: [] };
  finishPage({ success: true, data: [{ id: asMessageId('older'), kind: 'user', createdAt: 0, text: 'Private past chat' }] });
  await flushPromises();
  expect(live.chat.messages.value).toEqual([]);
  expect(wrapper.text()).not.toContain('Private past chat');
});


// risk: adjacent but unrelated replies can disappear if attribution relies
// on message proximity alone, or the first follow-up can duplicate on replay.
it('links just the first new reply of a resolved active gate and keeps neighboring replies after reload', () => {
  const live = new ReportingFixture();
  live.emit('assistant_message', { kind: 'streaming', content: 'Earlier unrelated reply' });
  const question = {
    id: asMessageId('question-line'), createdAt: Date.now(), kind: 'tool_question', status: 'pending',
    questionId: 'question-1', questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }],
  } satisfies Message;
  live.chat.appendMessage(question);
  live.resolveWaitingGate('question-1');
  live.chat.updateMessage(question.id, {
    status: 'answered', answers: [{ question: 'Proceed?', selected: ['Yes'] }],
  });
  live.emit('assistant_message', { kind: 'streaming', content: 'Earlier unrelated reply, updated' });
  live.emit('assistant_message', { kind: 'streaming_complete' });
  live.emit('assistant_message', { kind: 'streaming', content: 'Decision follow-up' });
  live.emit('assistant_message', { kind: 'streaming_complete' });
  live.emit('assistant_message', { kind: 'text', content: 'Separate neighboring reply' });
  live.ctx.graphRunning.value = false;
  live.emit('assistant_message', { kind: 'text', content: 'Later ordinary reply' });

  const texts = (fx: ReportingFixture, level: ReportingLevel) => fx.entries(level).flatMap(row =>
    row.kind === 'card' && (row.message.kind === 'sulla' || row.message.kind === 'streaming') ? [row.message.text] : []);
  const brief = ['Earlier unrelated reply, updated', 'Separate neighboring reply', 'Later ordinary reply'];
  expect(texts(live, 'fatal')).toEqual(brief);
  expect(texts(live, 'info')).toEqual([brief[0], 'Decision follow-up', ...brief.slice(1)]);
  expect(live.entries('fatal').find(row => row.id === question.id)).toMatchObject({
    message: { status: 'answered', answers: [{ question: 'Proceed?', selected: ['Yes'] }] },
  });
  const reopened = new ReportingFixture(new ChatController({ hydrateFrom: JSON.parse(JSON.stringify(live.chat.serialize())) }));
  expect(texts(reopened, 'fatal')).toEqual(brief);
  expect(texts(reopened, 'debug')).toEqual(texts(live, 'info'));
});

// risk: a resumed answer's tagged stream can overwrite an unlinked stream,
// or hide a deliverable, even though only follow-up prose should be filtered.
it('keeps explicit decision-turn streams separate from ordinary output and preserves embedded deliverables', () => {
  const live = new ReportingFixture();
  live.emit('assistant_message', { kind: 'streaming', content: 'Same prefix in ordinary output' });
  live.emit('assistant_message', { kind: 'streaming', content: 'Same prefix in decision follow-up', decisionFollowUpId: 'claimed-question' });
  const rows = live.entries('info').filter(row => row.kind === 'card');
  expect(rows.map(row => row.label)).toEqual(['Reply', 'Follow-up']);
  expect(live.entries('fatal').map(row => row.id)).toEqual([rows[0].id]);
  live.emit('assistant_message', { kind: 'streaming', content: 'Same prefix in decision follow-up <html><body>Report</body></html>', decisionFollowUpId: 'claimed-question' });
  expect(live.entries('fatal').map(row => row.id)).toEqual(rows.map(row => row.id));
});
