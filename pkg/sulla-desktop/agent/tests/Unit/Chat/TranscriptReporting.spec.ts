// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import '../../Support/TestHomeEnv';

import { flushPromises, mount } from '@vue/test-utils';
import { expect, it, onTestFinished, vi } from 'vitest';
import { ref } from 'vue';

import { CitationExtractor } from '@pkg/agent/controllers/CitationExtractor';
import { createMessageDispatcher } from '@pkg/agent/database/models/MessageDispatcher';
import type { ChatMessage } from '@pkg/agent/database/registry/AgentPersonaRegistry';
import Transcript from '@pkg/pages/chat/components/transcript/Transcript.vue';
import { DetailedTraceProjection } from '@pkg/pages/chat/components/transcript/DetailedTraceProjection';
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

  emit(type: 'progress' | 'assistant_message', data: object, id?: string, timestamp?: number,
    agentId = 'fixture-agent', threadId = 'fixture-thread') {
    this.dispatcher.dispatch(this.ctx as any, agentId, threadId, { type, data, id, timestamp } as any);
    this.adapter.syncMessages();
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

// risk: layout parity — Detailed must use the exact Standard projection; Brief still filters.
it('keeps the Standard entry projection identical for info and debug while Brief filters', () => {
  const live = new ReportingFixture();
  live.emit('assistant_message', { kind: 'user', content: 'hello' });
  live.emit('assistant_message', { kind: 'thinking', content: 'Preparing your turn…', reportingActivity: 'status' });
  live.emit('assistant_message', { kind: 'citation', citations: [{ num: 1, title: 'Evidence', origin: 'fixture' }] });
  const standard = live.reporting.standardEntries(live.chat.messages.value, 'info');
  const detailed = live.reporting.standardEntries(live.chat.messages.value, 'debug');
  expect(detailed).toEqual(standard);
  expect(live.reporting.standardEntries(live.chat.messages.value, 'fatal')).not.toEqual(standard);
  expect(live.reporting.standardEntries(live.chat.messages.value, 'fatal').map(row => row.id)).not.toContain(standard.find(row => row.kind === 'card' && row.message.kind === 'user')?.id);
});

// risk: text integrity — a completed segment must retain its stream identity so
// the next text segment gets a paragraph break without crossing reply/card boundaries.
it('keeps same-stream paragraph breaks after a completed segment and not across other replies', () => {
  const finishFirstSegment = (live: ReportingFixture) => {
    live.ctx.graphRunning.value = true;
    live.emit('assistant_message', { kind: 'streaming', content: 'First paragraph', replyStreamId: 'reply-1' });
    live.emit('assistant_message', { kind: 'streaming_complete', replyStreamId: 'reply-1' });
    expect(live.chat.messages.value[0]).toMatchObject({ kind: 'sulla', text: 'First paragraph', replyStreamId: 'reply-1' });
  };
  const continuationFor = (live: ReportingFixture) => {
    const next = live.chat.messages.value.find(message => message.kind === 'streaming' && message.text === 'Second paragraph');
    expect(next).toBeDefined();
    const entries = live.entries('info');
    return live.reporting.isStreamingContinuation(entries, entries.findIndex(entry => entry.id === next!.id));
  };

  const sameStream = new ReportingFixture();
  finishFirstSegment(sameStream);
  sameStream.emit('progress', { phase: 'tool_call', toolRunId: 'reply-tool', toolName: 'exec', args: { command: 'fixture' } });
  sameStream.emit('progress', { phase: 'tool_result', toolRunId: 'reply-tool', success: true, result: 'done' });
  sameStream.emit('assistant_message', { kind: 'streaming', content: 'Second paragraph', replyStreamId: 'reply-1' });
  expect(sameStream.entries('info').some(entry => entry.kind === 'activity')).toBe(true);
  expect(continuationFor(sameStream)).toBe(true);

  const differentStream = new ReportingFixture();
  finishFirstSegment(differentStream);
  differentStream.emit('assistant_message', { kind: 'streaming', content: 'Second paragraph', replyStreamId: 'reply-2' });
  expect(continuationFor(differentStream)).toBe(false);

  const interveningCard = new ReportingFixture();
  finishFirstSegment(interveningCard);
  interveningCard.emit('assistant_message', {
    kind: 'citation', citations: [{ num: 1, title: 'Evidence', origin: 'fixture' }],
  });
  interveningCard.emit('assistant_message', { kind: 'streaming', content: 'Second paragraph', replyStreamId: 'reply-1' });
  expect(continuationFor(interveningCard)).toBe(false);
});

// risk: private reasoning or tool payloads escape on live, saved or paged paths;
// work moves ahead of interleaved evidence or duplicates when live state is restored.
it('projects safe individual events in source order before and after tool settlement and reload', () => {
  const live = new ReportingFixture();
  live.emit('assistant_message', { kind: 'thinking', content: 'Preparing your turn…', reportingActivity: 'status' });
  live.emit('assistant_message', { kind: 'thinking', content: '💭 PRIVATE_REASONING' });
  live.emit('assistant_message', { kind: 'citation', citations: [{ num: 1, title: 'Evidence', origin: 'fixture' }] });
  live.emit('assistant_message', { kind: 'thinking', content: 'Private buffer\n\n$ echo PRIVATE_LEGACY_COMMAND\n\nPreparing your turn…' });
  live.emit('assistant_message', { kind: 'thinking', content: '$ echo PRIVATE_TYPED_COMMAND', reportingActivity: 'tool' });
  live.emit('progress', { phase: 'tool_call', toolRunId: 'fixture-call', toolName: 'exec', args: { command: 'echo PRIVATE_INPUT' } });
  live.emit('progress', { phase: 'tool_call', toolRunId: 'fixture-call', toolName: 'exec', args: { command: 'echo PRIVATE_INPUT' } });
  live.emit('assistant_message', { kind: 'thinking', content: 'Tools connected — calling model' });

  const debug = live.entries('debug');
  expect(debug.map(row => row.kind === 'activity' ? row.text : row.message.kind)).toEqual([
    'Preparing your turn…', 'citation', 'Details withheld', 'Bash · running · Details withheld', 'Tools connected — calling model',
  ]);
  expect(live.entries('info')).toEqual([debug[1]]);
  expect(live.entries('fatal')).toEqual([]);
  expect(JSON.stringify(debug)).not.toContain('PRIVATE_');

  live.emit('progress', { phase: 'tool_result', toolRunId: 'fixture-call', success: false, error: 'PRIVATE_ERROR', result: 'PRIVATE_OUTPUT' });
  const settled = live.entries('debug');
  expect(settled.map(row => row.id)).toEqual(debug.map(row => row.id));
  expect(live.entries('info')).toContainEqual({ ...debug[3], level: 'info', text: 'Shell · Failed' });
  expect(live.entries('fatal')).toEqual([]);
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
  live.emit('assistant_message', { kind: 'thinking', content: '$ synthetic command', reportingActivity: 'tool' });
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
    expect(wrapper.text().includes('synthetic command')).toBe(level === 'debug');
    expect(wrapper.text()).not.toContain('Details withheld');
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
  vi.mocked(ipcRenderer.invoke).mockImplementation((...[channel]) => {
    if (channel === 'chat-messages:message-count') return Promise.resolve({ success: true, count: 5 });
    if (channel === 'chat-messages:load-before') return new Promise(resolve => { finishPage = resolve; });
    return Promise.resolve(undefined);
  });
  onTestFinished(() => { vi.mocked(ipcRenderer.invoke).mockReset(); });
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
it.each(['Yes', 'No'])('attributes only the explicit %s answer reply live and after a dated reload', (answer) => {
  const clock = vi.spyOn(Date, 'now');
  onTestFinished(() => clock.mockRestore());
  clock.mockReturnValue(Date.parse('2026-10-14T12:00:00Z'));
  const live = new ReportingFixture();
  live.emit('assistant_message', { kind: 'streaming', content: 'Earlier unrelated reply' });
  const question = {
    id: asMessageId('question-line'), createdAt: Date.now(), kind: 'tool_question', status: 'pending',
    questionId: 'question-1', questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }],
  } satisfies Message;
  live.chat.appendMessage(question);
  live.chat.updateMessage(question.id, {
    status: 'answered', answers: [{ question: 'Proceed?', selected: [answer] }],
  });
  live.emit('assistant_message', { kind: 'streaming', content: 'Earlier unrelated reply, updated' });
  live.emit('assistant_message', { kind: 'streaming_complete' });
  live.emit('assistant_message', { kind: 'streaming', content: 'Decision follow-up', decisionFollowUpId: 'question-1' });
  live.emit('assistant_message', { kind: 'streaming_complete', decisionFollowUpId: 'question-1' });
  live.emit('assistant_message', { kind: 'text', content: 'Decision follow-up', decisionFollowUpId: 'question-1' });
  live.emit('assistant_message', { kind: 'text', content: 'Separate neighboring reply' });
  live.ctx.graphRunning.value = false;
  live.emit('assistant_message', { kind: 'text', content: 'Later ordinary reply' });

  const texts = (fx: ReportingFixture, level: ReportingLevel) => fx.entries(level).flatMap(row =>
    row.kind === 'card' && (row.message.kind === 'sulla' || row.message.kind === 'streaming') ? [row.message.text] : []);
  const brief = ['Earlier unrelated reply, updated', 'Separate neighboring reply', 'Later ordinary reply'];
  expect(texts(live, 'fatal')).toEqual(brief);
  expect(texts(live, 'info')).toEqual([brief[0], 'Decision follow-up', ...brief.slice(1)]);
  expect(live.entries('fatal').find(row => row.id === question.id)).toMatchObject({
    message: { status: 'answered', answers: [{ question: 'Proceed?', selected: [answer] }] },
  });
  clock.mockReturnValue(Date.parse('2026-11-21T12:00:00Z'));
  const reopened = new ReportingFixture(new ChatController({ hydrateFrom: JSON.parse(JSON.stringify(live.chat.serialize())) }));
  expect(reopened.entries('info').map(row => row.createdAt)).toEqual(live.entries('info').map(row => row.createdAt));
  const separate = new ReportingFixture(new ChatController());
  separate.chat.thread.value = { ...separate.chat.thread.value, id: asThreadId('separate-chat') };
  separate.emit('assistant_message', { kind: 'text', content: 'Decision follow-up' });
  expect(texts(separate, 'fatal')).toEqual(['Decision follow-up']);
  expect(texts(reopened, 'fatal')).toEqual(brief);
  expect(texts(reopened, 'debug')).toEqual(texts(live, 'info'));
});

// risk: a resumed answer's tagged stream can overwrite an unlinked stream,
// or promote narration to Brief merely because the text resembles a deliverable.
it('keeps decision-turn streams separate and honors explicit deliverable intent, not markup', () => {
  const live = new ReportingFixture();
  live.emit('assistant_message', { kind: 'streaming', content: 'Same prefix in ordinary output' });
  live.emit('assistant_message', { kind: 'streaming', content: 'Same prefix in decision follow-up', decisionFollowUpId: 'claimed-question' });
  const rows = live.entries('info').filter(row => row.kind === 'card');
  expect(rows.map(row => row.label)).toEqual(['Reply', 'Follow-up']);
  expect(live.entries('fatal').map(row => row.id)).toEqual([rows[0].id]);
  live.emit('assistant_message', { kind: 'streaming', content: 'Same prefix in decision follow-up <html><body>Report</body></html>', decisionFollowUpId: 'claimed-question' });
  expect(live.entries('fatal').map(row => row.id)).toEqual([rows[0].id]);
  live.emit('assistant_message', { kind: 'text', content: 'Report ready', decisionFollowUpId: 'claimed-question', agentReporting: 'brief' });
  expect(live.entries('fatal').map(row => row.id)).toEqual([rows[0].id, live.chat.messages.value.at(-1)?.id]);
});

// risk: an older decision-linked deliverable disappears at Brief, or prose overrides recorded intent.
it('preserves structured legacy decision attachments at Brief without overriding explicit intent', () => {
  const live = new ReportingFixture();
  const fileReferences = [{ fileId: 'file-1', versionId: 'v1', path: 'report.md', name: 'report.md' }];
  const emit = (content: string, fields: object = {}) => live.emit('assistant_message', {
    kind: 'text', decisionFollowUpId: 'decision-1', content, ...fields,
  });
  emit('Legacy attachment', { fileReferences });
  emit('Explicit routine update', { fileReferences, agentReporting: 'standard' });
  emit('Explicit important reply', { agentReporting: 'brief' });
  emit('Mere claim: report attached');
  emit('Inline link only: sulla-file://file-1?version=v1');
  live.emit('assistant_message', {
    kind: 'streaming', decisionFollowUpId: 'decision-2', content: 'Streamed legacy attachment',
  });
  live.emit('assistant_message', { kind: 'streaming_complete', decisionFollowUpId: 'decision-2' });
  live.emit('assistant_message', {
    kind: 'text', decisionFollowUpId: 'decision-2', content: 'Streamed legacy attachment',
    metadata: { fileReferences },
  });

  const reopened = new ReportingFixture(new ChatController({ hydrateFrom: JSON.parse(JSON.stringify(live.chat.serialize())) }));
  for (const fixture of [live, reopened]) {
    const replies = (level: ReportingLevel) => fixture.entries(level)
      .flatMap(row => row.kind === 'card' && row.message.kind === 'sulla' ? [row.message] : []);
    expect(replies('fatal').map(message => message.text)).toEqual([
      'Legacy attachment', 'Explicit important reply', 'Streamed legacy attachment',
    ]);
    expect(replies('info')).toHaveLength(6);
    expect(replies('fatal')[0].fileReferences?.[0].fileRef?.fileId).toBe('file-1');
    expect(replies('info')[4].fileReferences?.[0].fileRef?.fileId).toBe('file-1');
  }
});

// risk: switching models/agents rewrites historical attribution; filtering
// hides the visible reply's controls; completion credits a different attempt.
it('keeps recorded reply attribution and its actions together across levels and reload', async() => {
  const live = new ReportingFixture();
  const legacyAt = Date.UTC(2026, 10, 14, 17, 41);
  live.chat.appendMessage({
    id: asMessageId('legacy-reply'), kind: 'sulla', text: 'Legacy answer', createdAt: legacyAt,
    model: 'Former picker label', by: { agent: 'Former picker agent', model: 'Former picker label' },
  });
  live.emit('assistant_message', {
    kind: 'streaming', content: 'Recorded answer', replyStreamId: 'run-a',
    replyAttribution: { agent: 'Research Agent', model: 'selected-model' },
  });
  live.emit('assistant_message', { kind: 'streaming_complete', replyStreamId: 'run-b', reportedModel: 'wrong-model' });
  expect(live.chat.messages.value.at(-1)?.kind).toBe('streaming');
  live.emit('assistant_message', { kind: 'streaming_complete', replyStreamId: 'run-a', reportedModel: 'reported-model' });
  live.emit('assistant_message', {
    kind: 'text', content: 'Decision follow-up', decisionFollowUpId: 'decision-1',
    replyAttribution: { agent: 'Approvals Agent', model: 'follow-up-model' },
  });

  const reopened = new ReportingFixture(new ChatController({ hydrateFrom: JSON.parse(JSON.stringify(live.chat.serialize())) }));
  reopened.chat.model.value = { ...reopened.chat.model.value, name: 'Current picker label' };
  const wrapper = reopened.mount('info');
  const actionRows = () => wrapper.findAll('.tact-sulla');
  expect(actionRows()).toHaveLength(3);
  const [legacy, recorded, followUp] = actionRows();
  expect(legacy.text()).toContain('Agent not recorded');
  expect(legacy.text()).not.toContain('Model not recorded');
  expect(legacy.get('time').attributes('datetime')).toBe(new Date(legacyAt).toISOString());
  expect(recorded.text()).toContain('Research Agent');
  expect(recorded.text()).not.toContain('reported-model');
  expect(wrapper.text()).not.toMatch(/picker label|picker agent|selected-model|wrong-model/);
  expect(wrapper.findAll('.chat-turn.sulla .chat-role, .chat-turn.sulla .noir-avatar')).toHaveLength(0);
  expect(recorded.classes()).not.toContain('tact-latest');
  expect(followUp.classes()).not.toContain('tact-latest');

  await wrapper.setProps({ reportingLevel: 'debug' });
  expect(actionRows().map(row => row.element)).toEqual([legacy, recorded, followUp].map(row => row.element));
  expect(recorded.text()).toContain('Research Agent');
  expect(recorded.text()).not.toContain('reported-model');
  expect(wrapper.text()).toContain('reported-model');
  await wrapper.setProps({ reportingLevel: 'fatal' });
  const newestVisible = actionRows().find(row => row.text().includes('Research Agent'))!;
  expect(newestVisible.element).toBe(recorded.element);

  // Preserve the existing Reply, Regenerate and Pin dispatches; Copy and Fork
  // remain on the same row (Fork is still the existing visual placeholder).
  const recordedId = live.chat.messages.value.find(message => message.kind === 'sulla' && message.text === 'Recorded answer')!.id;
  const regenerate = vi.spyOn(reopened.chat, 'regenerate').mockImplementation(() => {});
  const pin = vi.spyOn(reopened.chat, 'togglePin');
  const reply = vi.fn();
  window.addEventListener('chat:reply', reply, { once: true });
  onTestFinished(() => window.removeEventListener('chat:reply', reply));
  await newestVisible.get('button[title="Reply to this message"]').trigger('click');
  expect(reply.mock.calls[0][0].detail.excerpt).toBe('Recorded answer');
  await newestVisible.get('button[aria-label="Regenerate"]').trigger('click');
  expect(regenerate).toHaveBeenCalledWith(recordedId);
  await newestVisible.get('button[aria-label="Pin"]').trigger('click');
  expect(pin).toHaveBeenCalledWith(recordedId);
  expect(newestVisible.get('button[aria-label="Unpin"]').attributes('aria-pressed')).toBe('true');
});

// risk: losing evidence or rendering it twice on streaming replay / rehydrate;
// Brief must not reveal reference titles or URLs.
it('renders ordered citation and report links directly at Standard and Detailed on stream, replay and reload', async() => {
  const live = new ReportingFixture();
  const wrapper = live.mount('info');
  live.emit('assistant_message', { kind: 'streaming', content: 'Streamed answer' });
  const deliver = vi.fn();
  const extractor = new CitationExtractor(deliver);
  const raw = { content: 'Streamed answer\n<citations>' +
    '<source num="3" title="First external source" origin="example.com" url="https://example.com/a" />' +
    '<source num="1" title="Saved report" origin="Projects/qa/audit.md" />' +
    '<source num="1" title="Saved report" origin="Projects/qa/audit.md" />' +
    '<source num="3" title="Last external source" origin="example.com" url="https://example.com/b" />' +
    '</citations>', metadata: { tokens_used: 1, time_spent: 1 } };
  expect(extractor.processComplete(raw, { state: {} } as any)).toBe('Streamed answer');
  expect(deliver).toHaveBeenCalledTimes(1);
  const evidence = deliver.mock.calls[0][4] as { citationId: string; citations: unknown[] };
  live.emit('assistant_message', { kind: 'citation', ...evidence });
  await wrapper.setProps({ reportingLevel: 'debug' });
  expect(live.chat.messages.value[0].kind).toBe('streaming');
  expect(wrapper.findAll('ul.supporting-reports')).toHaveLength(1);
  live.emit('assistant_message', { kind: 'streaming_complete' });
  live.emit('assistant_message', { kind: 'citation', ...evidence });

  const titles = ['First external source', 'Saved report', 'Last external source'];
  await wrapper.setProps({ reportingLevel: 'fatal' });
  expect(wrapper.find('.supporting-reports').exists()).toBe(false);
  await wrapper.setProps({ reportingLevel: 'info' });
  expect(wrapper.findAll('.report-row b').map(row => row.text())).toEqual(titles);
  await wrapper.setProps({ reportingLevel: 'debug' });
  expect(wrapper.findAll('ul.supporting-reports')).toHaveLength(1);
  expect(wrapper.findAll('.report-row b').map(row => row.text())).toEqual(titles);
  expect(wrapper.findAll('.report-row a').map(link => link.attributes('href'))).toEqual([
    'https://example.com/a', 'https://example.com/b',
  ]);
  expect(wrapper.get('.report-row button').text()).toContain('Read report');

  const reopened = new ReportingFixture(new ChatController({ hydrateFrom: JSON.parse(JSON.stringify(live.chat.serialize())) }));
  reopened.emit('assistant_message', { kind: 'citation', ...evidence });
  const hydrated = reopened.mount('debug');
  expect(hydrated.findAll('.report-row b').map(row => row.text())).toEqual(titles);
  reopened.emit('assistant_message', { kind: 'citation', ...evidence, citationId: evidence.citationId.replace(/.$/, c => c === 'f' ? '0' : 'f') });
  await flushPromises();
  // An independent reply may legitimately cite the same source again.
  expect(hydrated.findAll('.report-row b').map(row => row.text())).toEqual([...titles, ...titles]);
});

// risk: losing recorded provenance or exposing payloads in the shared Standard entries.
it('retains exact tool data and recorded timestamps through Detailed projection and reload', async() => {
  const live = new ReportingFixture();
  live.emit('progress', { phase: 'tool_call', toolRunId: 'benign-run', toolName: 'exec', args: { command: 'echo fixture' } });
  live.emit('progress', { phase: 'tool_result', toolRunId: 'benign-run', success: true, result: 'FIXTURE_OUTPUT' });
  live.chat.appendMessage({
    id: asMessageId('undated-status'), kind: 'thinking', createdAt: 0,
    thoughts: ['Preparing your turn…'], reportingActivity: 'status', startedAt: 0, completed: true,
  });
  const saved = JSON.stringify(live.chat.serialize());
  const originalRecords = JSON.stringify(live.chat.messages.value);
  const tool = live.chat.messages.value.find(message => message.kind === 'tool')!;
  const reopened = new ReportingFixture(new ChatController({ hydrateFrom: JSON.parse(saved) }));
  for (const fixture of [live, reopened]) {
    const standard = fixture.reporting.standardEntries(fixture.chat.messages.value, 'info');
    const turns = new DetailedTraceProjection().project(fixture.chat.messages.value, standard);
    const rows = turns.flatMap(turn => turn.rows);
    const trace = rows.find(row => row.kind === 'tool')!;
    expect(trace).toMatchObject({ target: 'exec', status: 'ok', at: tool.createdAt });
    expect(JSON.parse(trace.rawPayload!)).toMatchObject({ input: tool.input, output: 'FIXTURE_OUTPUT' });
    expect(rows).toContainEqual(expect.objectContaining({ at: 0, target: 'Preparing your turn…' }));
    expect(JSON.stringify(fixture.chat.messages.value)).toBe(originalRecords);
  }

  const wrapper = reopened.mount('info');
  const standardText = wrapper.findAll('.report-activity-text').map(row => row.text());
  expect(standardText).toEqual(['Shell · Completed']);
  await wrapper.setProps({ reportingLevel: 'debug' });
  expect(wrapper.findAll('.report-activity-text').map(row => row.text())).toEqual(standardText);
  await wrapper.get('article.dtr-row-tool button').trigger('click');
  expect(wrapper.get('article.dtr-row-tool pre').text()).toContain('FIXTURE_OUTPUT');
  await wrapper.setProps({ reportingLevel: 'fatal' });
  expect(wrapper.text()).not.toContain('FIXTURE_OUTPUT');
});

// risk: Brief loses a deliverable or picks up structured narration by reading its prose;
// a final stream classification must not change earlier segments or another stream.
it('keeps producer-classified narration and deliverables apart across streaming and save/restore', () => {
  const live = new ReportingFixture();
  live.emit('assistant_message', { kind: 'text', content: 'Legacy report-looking sentence' });
  live.emit('assistant_message', { kind: 'streaming', content: 'Report ready', replyStreamId: 'producer-turn' });
  live.emit('assistant_message', { kind: 'streaming_complete', replyStreamId: 'producer-turn', agentReporting: 'standard' });
  live.emit('assistant_message', { kind: 'streaming', content: 'Opening it now', replyStreamId: 'producer-turn' });
  live.emit('assistant_message', { kind: 'streaming_complete', replyStreamId: 'unrelated-turn', agentReporting: 'standard' });
  live.emit('assistant_message', { kind: 'streaming_complete', replyStreamId: 'producer-turn', agentReporting: 'brief', reportedModel: 'actual-model' });
  live.emit('assistant_message', { kind: 'proactive', headline: 'Action needed', body: 'Review fixture', agentReporting: 'brief' });
  live.emit('assistant_message', { kind: 'proactive', headline: 'Progress', body: 'Routine update', agentReporting: 'standard' });

  const reopened = new ReportingFixture(new ChatController({ hydrateFrom: JSON.parse(JSON.stringify(live.chat.serialize())) }));
  const briefs = live.chat.messages.value.filter(message => message.agentReporting === 'brief' || !message.agentReporting).map(message => message.id);
  expect(briefs).toHaveLength(3);
  expect(reopened.entries('fatal').map(row => row.id)).toEqual(briefs);
  expect(reopened.entries('info').map(row => row.id)).toEqual(live.chat.messages.value.map(message => message.id));
  expect(reopened.entries('fatal')[1]).toMatchObject({ message: {
    text: 'Opening it now', agentReporting: 'brief', replyAttribution: { model: 'actual-model' },
  } });
});

// risk: a hidden operation leaks across threads or exposes private arguments/results;
// visibility filtering must not reorder or discard authorized retained activity.
it('keeps safe thread-bound activities, patches and memory at their cumulative levels', () => {
  const live = new ReportingFixture();
  live.chat.appendMessage({ id: asMessageId('patch-fixture'), kind: 'patch', createdAt: 1,
    path: 'synthetic.txt', stat: { added: 1, removed: 0 }, state: 'applied', hunks: [] });
  live.chat.appendMessage({ id: asMessageId('memory-fixture'), kind: 'memory', createdAt: 2,
    memId: 'synthetic-memory', action: 'saved' });
  const activity = (chatToolActivity: string, thread_id = 'fixture-thread') =>
    live.emit('assistant_message', { kind: 'chat_tool_activity', thread_id, chatToolActivity, content: 'PRIVATE_RAW' });
  activity('artifact-opened', 'another-thread');
  activity('browser:PRIVATE_URL:Failed');
  activity('artifact-opened');
  expect(live.ctx.graphRunning.value).toBe(false);
  live.emit('progress', { phase: 'tool_call', toolRunId: 'hidden-run', toolName: 'background_browse', args: { action: 'read', url: 'PRIVATE_URL' } });
  activity('browser:read:Running');
  activity('browser:read:Failed');
  live.emit('progress', { phase: 'tool_result', toolRunId: 'hidden-run', success: false, error: 'PRIVATE_RESULT' });
  activity('browser:list:Completed');

  expect(live.entries('fatal')).toEqual([]);
  expect(live.entries('info').map(row => row.id)).toEqual(['patch-fixture']);
  const reopened = new ReportingFixture(new ChatController({ hydrateFrom: JSON.parse(JSON.stringify(live.chat.serialize())) }));
  expect(reopened.entries('debug').map(row => row.kind === 'card' ? row.message.kind : row.text)).toEqual([
    'patch', 'memory', 'Artifact opened', 'Hidden browser · read · Running', 'Hidden browser · read · Failed',
    'Hidden browser · list · Completed',
  ]);
  expect(JSON.stringify(live.ctx.messages)).not.toContain('PRIVATE_');
});

// risk: replay duplicates lifecycle rows, or deduplication swallows distinct operations or changes their order.
it('deduplicates lifecycle envelope redelivery in scope without losing phases, operations or saved order', () => {
  const live = new ReportingFixture();
  const timestamp = Date.now();
  const activity = (fixture: ReportingFixture, id: string, chatToolActivity: string,
    agentId = 'fixture-agent', thread_id = 'fixture-thread') => fixture.emit('assistant_message', {
    kind: 'chat_tool_activity', thread_id, chatToolActivity,
  }, id, timestamp, agentId, thread_id);
  activity(live, 'read-a-start', 'browser:read:Running');
  live.emit('assistant_message', { kind: 'text', content: 'Interleaved reply' });
  activity(live, 'read-a-end', 'browser:read:Completed');
  activity(live, 'read-b-start', 'browser:read:Running');
  activity(live, 'read-b-end', 'browser:read:Completed');
  activity(live, 'read-a-start', 'browser:read:Running');
  activity(live, 'read-a-end', 'browser:read:Completed');
  activity(live, 'artifact-a', 'artifact-opened');
  activity(live, 'artifact-a', 'artifact-opened');
  activity(live, 'artifact-b', 'artifact-opened');

  const expected = [
    'Hidden browser · read · Running', 'Interleaved reply', 'Hidden browser · read · Completed',
    'Hidden browser · read · Running', 'Hidden browser · read · Completed', 'Artifact opened', 'Artifact opened',
  ];
  const rows = (fixture: ReportingFixture) => fixture.entries('debug')
    .map(row => row.kind === 'activity' ? row.text : row.message.kind === 'sulla' ? row.message.text : row.message.kind);
  expect(rows(live)).toEqual(expected);
  const reopened = new ReportingFixture(new ChatController({ hydrateFrom: JSON.parse(JSON.stringify(live.chat.serialize())) }));
  activity(reopened, 'read-a-start', 'browser:read:Running');
  activity(reopened, 'artifact-a', 'artifact-opened');
  expect(rows(reopened)).toEqual(expected);
  expect(reopened.chat.messages.value.map(message => message.id)).toEqual(live.chat.messages.value.map(message => message.id));

  activity(live, 'artifact-a', 'artifact-opened', 'another-agent');
  activity(live, 'artifact-a', 'artifact-opened', 'fixture-agent', 'another-thread');
  expect(live.ctx.messages.filter(message => message.chatToolActivity === 'artifact-opened')
    .map(message => [message.channelId, message.threadId])).toEqual([
    ['fixture-agent', 'fixture-thread'], ['fixture-agent', 'fixture-thread'],
    ['another-agent', 'fixture-thread'], ['fixture-agent', 'another-thread'],
  ]);
});

// risk: formatter aliases replace the actual callable identity or captured payload on replay.
it('uses the recorded tool name and full payload through Detailed projection and reload', async() => {
  const live = new ReportingFixture();
  const calls = [
    ['git_status', { absolutePath: 'fixture-path' }],
    ['get_page_text', { tabId: 'fixture-tab' }],
    ['calendar_list', { calendar: 'fixture-calendar' }],
    ['browser_tab', { action: 'close', title: 'fixture-title' }],
    ['calendar_update', { title: 'fixture-event' }],
  ] as const;
  const output = 'x'.repeat(200_001) + '\nfixture-tail';
  calls.forEach(([toolName, args], index) => {
    const toolRunId = `format-${ index }`;
    live.emit('progress', { phase: 'tool_call', toolRunId, toolName, args });
    live.emit('progress', { phase: 'tool_result', toolRunId, success: true, result: 'fixture-result' });
    // Legacy producer formatters may omit inputs; exercise exact retained data
    // independently of those formatters, including a payload beyond the old renderer cap.
    const tool = live.chat.messages.value.findLast(message => message.kind === 'tool')!;
    live.chat.updateMessage(tool.id, { ...tool, input: JSON.stringify(args), output: index === 0 ? output : 'fixture-result' });
  });
  const reopened = new ReportingFixture(new ChatController({ hydrateFrom: JSON.parse(JSON.stringify(live.chat.serialize())) }));
  const projection = new DetailedTraceProjection();
  for (const fixture of [live, reopened]) {
    const messages = fixture.chat.messages.value;
    const standard = fixture.reporting.standardEntries(messages, 'info');
    expect(fixture.reporting.standardEntries(messages, 'debug')).toEqual(standard);
    expect(standard.flatMap(row => row.kind === 'activity' ? [row.text] : [])).toEqual([
      'Git · Completed', 'Browser · Completed', 'Calendar · Completed', 'Browser · Completed', 'Calendar · Completed',
    ]);
    const raw = projection.project(messages, standard).flatMap(turn => turn.rows)
      .filter(row => row.kind === 'tool')
      .map(row => JSON.parse(row.rawPayload!));
    expect(raw.map(row => [row.tool, row.status])).toEqual(calls.map(([name]) => [name, 'ok']));
    raw.forEach((row, index) => {
      expect(JSON.parse(row.input)).toEqual(calls[index][1]);
      expect(row.output).toBe(index === 0 ? output : 'fixture-result');
    });
  }
});
