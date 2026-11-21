// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, provide, ref } from 'vue';

import ForYouPanel from '@pkg/pages/chat/components/sidedock/ForYouPanel.vue';
import MessageRouter from '@pkg/pages/chat/components/transcript/MessageRouter.vue';
import ToolApproval from '@pkg/pages/chat/components/tool/ToolApproval.vue';
import ToolQuestion from '@pkg/pages/chat/components/tool/ToolQuestion.vue';
import ToolTask from '@pkg/pages/chat/components/tool/ToolTask.vue';
import { ChatDecisions } from '@pkg/pages/chat/composables/useChatDecisions';
import type { ChatController } from '@pkg/pages/chat/controller/ChatController';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import type { ToolApprovalMessage, ToolQuestionMessage } from '@pkg/pages/chat/models/Message';
import { asMessageId } from '@pkg/pages/chat/types/chat';
import type { DecisionRecord, DecisionResponse } from '@pkg/shared/decisions';

// This route does not render Sulla replies; avoid starting unrelated browser-tab IPC at import time.
vi.mock('@pkg/pages/chat/components/transcript/TurnSulla.vue', () => ({ default: {} }));

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Set<(event: unknown, record: DecisionRecord) => void>() }));
vi.mock('@pkg/utils/ipcRenderer', () => ({
  ipcRenderer: {
    invoke: ipc.invoke,
    send: vi.fn(),
    sendSync: vi.fn(),
    on: (channel: string, listener: (event: unknown, record: DecisionRecord) => void) => {
      if (channel === 'decisions:changed') ipc.listeners.add(listener);
    },
    removeListener: (_channel: string, listener: (event: unknown, record: DecisionRecord) => void) => ipc.listeners.delete(listener),
  },
}));

const owner = 'main-thread';
const approval: DecisionRecord = { id: 'permission', conversationId: owner, channel: 'sulla-desktop', kind: 'approval', status: 'pending', attention: 'active', title: 'Approve the operation', createdAt: 30, expiresAt: 0 };
const question: DecisionRecord = { ...approval, id: 'choice', kind: 'question', status: 'expired', createdAt: 10, title: 'Where?', questions: [{ question: 'Where?', options: [{ label: 'Staging' }, { label: 'Production' }] }] };
const task: DecisionRecord = { ...question, id: 'task', createdAt: 20, title: 'Review the preview', questions: [{ question: 'Review the preview', task: true, command: 'preview --open', options: [{ label: 'Done' }] }] };
let records: DecisionRecord[];
let historyOnly: Set<string>;
let beforeResolve: () => Promise<void>;
const mounted = new Set<ReturnType<typeof mount>>();
const submissions = () => ipc.invoke.mock.calls.filter(([channel]) => channel === 'decisions:resolve');

function publish(next: DecisionRecord): void {
  records = records.map(record => record.id === next.id ? next : record);
  for (const listener of ipc.listeners) listener(undefined, structuredClone(next));
}

beforeEach(() => {
  records = [structuredClone(question), structuredClone(task), { ...approval, expiresAt: Date.now() + 60_000 }];
  historyOnly = new Set();
  beforeResolve = async() => {};
  ipc.invoke.mockReset().mockImplementation(async(channel: string, input: unknown, ids?: string[]) => {
    if (channel === 'decisions:conversation') return structuredClone(records.filter(record => record.conversationId === input && !historyOnly.has(record.id)));
    if (channel === 'decisions:transcript') return structuredClone(records.filter(record => record.conversationId === input && ids?.includes(record.id)));
    if (channel === 'decisions:dismiss') {
      const current = records.find(record => record.id === input)!;
      publish({ ...current, attention: 'dismissed' });
      return { settled: true };
    }
    if (channel === 'decisions:resolve') {
      await beforeResolve();
      const response = input as DecisionResponse;
      const current = records.find(record => record.id === response.id && record.conversationId === response.conversationId);
      if (!current) return { settled: false };
      const late = current.status === 'expired';
      publish({ ...current, attention: 'answered', answers: response.answers, ...(late ? { answerDelivery: 'queued' } : { status: response.action }) });
      return { settled: true, late };
    }
    throw new Error(`Unexpected IPC: ${ channel }`);
  });
});
afterEach(() => { for (const wrapper of mounted) wrapper.unmount(); mounted.clear(); ipc.listeners.clear(); });

function fixture(main = true, includeLegacy = false) {
  const thread = ref<string | undefined>(owner);
  const messages: Array<ToolQuestionMessage | ToolApprovalMessage> = [
    ...[question, task].map(record => ({
      id: asMessageId(`original-${ record.id }`), kind: 'tool_question', createdAt: record.createdAt, status: 'pending',
      questions: record.questions!, questionId: record.id,
    } satisfies ToolQuestionMessage)),
    { id: asMessageId('original-approval'), kind: 'tool_approval', createdAt: 30, approvalId: approval.id, reason: 'User permission required', command: 'preview --publish', decision: 'pending' } satisfies ToolApprovalMessage,
  ];
  if (includeLegacy) messages.push({ ...messages[0] as ToolQuestionMessage, id: asMessageId('legacy'), questionId: 'legacy-question' });
  const controller = { messages: ref(messages), thread: ref({ id: 'ui-thread' }), send: vi.fn(), answerQuestion: vi.fn(), approveTool: vi.fn(), denyTool: vi.fn() };
  const TranscriptHarness = defineComponent({
    setup: () => () => h('section', messages.map(msg => h(MessageRouter, { key: msg.id, msg }))),
  });
  const wrapper = mount(defineComponent({
    setup() {
      ChatDecisions.provide(thread, main ? ref(messages.flatMap(message => message.kind === 'tool_question' ? [message.questionId!] : [message.approvalId!])) : undefined);
      provide(ChatControllerKey, controller as unknown as ChatController);
      provide('chat:main-decision-transcript', ref(main));
      provide('chat:activity-context', { backendThreadId: thread });
      return () => h('div', [
        h(TranscriptHarness),
        h(ForYouPanel),
      ]);
    },
  }));
  mounted.add(wrapper);
  return { controller, wrapper, transcript: wrapper.getComponent(TranscriptHarness), drawer: wrapper.getComponent(ForYouPanel) };
}

describe('For You from the original transcript', () => {
  it('shares the question selection and sends only one late answer when both surfaces submit', async() => {
    // risk: sending two human messages to a parked agent
    const { transcript, drawer, controller } = fixture();
    await flushPromises();
    const inline = transcript.getComponent(ToolQuestion);
    const inDrawer = drawer.getComponent(ToolQuestion);
    await inline.get('[role=radio]').trigger('click');
    expect(inDrawer.get('[role=radio]').attributes('aria-checked')).toBe('true');
    let release!: () => void;
    beforeResolve = () => new Promise<void>(resolve => { release = resolve; });
    const inlineClick = inline.get('button.qc-submit').trigger('click');
    const drawerClick = inDrawer.get('button.qc-submit').trigger('click');
    await Promise.all([inlineClick, drawerClick]);
    expect(submissions()).toEqual([['decisions:resolve', { id: question.id, conversationId: owner, action: 'answered', answers: [{ question: 'Where?', selected: ['Staging'] }] }]]);
    release();
    await flushPromises();
    expect(inline.props('msg')).toMatchObject({ status: 'answered', answers: [{ question: 'Where?', selected: ['Staging'] }] });
    expect(drawer.findComponent(ToolQuestion).exists()).toBe(false);
    expect(controller.answerQuestion).not.toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();
  });

  it.each(['Done', 'Preview is good'])('saves task %s and restores the original result after reload', async(reply) => {
    // risk: losing a recorded task acknowledgement or bypassing the durable route
    const { wrapper, transcript, controller } = fixture();
    await flushPromises();
    const card = transcript.getComponent(ToolTask);
    if (reply === 'Done') {
      await card.get('.tk-pri').trigger('click');
    } else {
      await card.get('footer button:last-child').trigger('click');
      await card.get('input').setValue(reply);
      await card.get('input').trigger('keyup.enter');
    }
    await flushPromises();
    expect(submissions()).toEqual([['decisions:resolve', { id: task.id, conversationId: owner, action: 'answered', answers: [{ question: task.title, selected: [reply] }] }]]);
    expect(controller.answerQuestion).not.toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();
    wrapper.unmount();
    mounted.delete(wrapper);
    historyOnly.add(task.id);
    const reloaded = fixture();
    await flushPromises();
    const saved = reloaded.transcript.getComponent(ToolTask);
    expect(saved.props('msg')).toMatchObject({ id: 'original-task', status: 'answered', answers: [{ question: task.title, selected: [reply] }] });
    expect(saved.get('code').text()).toBe(task.questions![0].command);
    expect(saved.find('footer').exists()).toBe(false);
    expect(reloaded.drawer.findComponent(ToolTask).exists()).toBe(false);
    expect(submissions()).toHaveLength(1);
  });

  it.each(['approved', 'denied'] as const)('does not send opposing approval actions; restores %s outside the first drawer page', async(action) => {
    // risk: executing an approval twice or reopening a decided operation
    const { wrapper, transcript, drawer, controller } = fixture();
    await flushPromises();
    const card = transcript.getComponent(ToolApproval);
    const index = action === 'approved' ? 0 : 1;
    let release!: () => void;
    beforeResolve = () => new Promise<void>(resolve => { release = resolve; });
    const firstClick = card.findAll('button')[index].trigger('click');
    const otherClick = drawer.get(`[data-decision-id="${ approval.id }"]`).findAll('.fy-actions button')[1 - index].trigger('click');
    await Promise.all([firstClick, otherClick]);
    expect(submissions()).toEqual([['decisions:resolve', { id: approval.id, conversationId: owner, action }]]);
    release();
    await flushPromises();
    expect(card.props('msg')).toMatchObject({ decision: action, command: 'preview --publish' });
    expect(controller.approveTool).not.toHaveBeenCalled();
    expect(controller.denyTool).not.toHaveBeenCalled();
    wrapper.unmount();
    mounted.delete(wrapper);
    historyOnly.add(approval.id);
    const reloaded = fixture();
    expect(reloaded.transcript.getComponent(ToolApproval).findAll('button').every(button => button.attributes('disabled') !== undefined)).toBe(true);
    await flushPromises();
    expect(reloaded.transcript.getComponent(ToolApproval).props('msg').decision).toBe(action);
    expect(reloaded.transcript.getComponent(ToolApproval).findAll('button')).toHaveLength(0);
    expect(ipc.invoke).toHaveBeenCalledWith('decisions:transcript', owner, [approval.id]);
    expect(submissions()).toHaveLength(1);
  });

  it('shows a durable answer from another surface instead of a stale local choice, and restores it on interruption', async() => {
    // risk: showing an unsubmitted choice as the user's recorded answer
    const { transcript, drawer } = fixture();
    await flushPromises();
    const card = transcript.getComponent(ToolQuestion);
    await card.get('[role=radio]').trigger('click');
    const queued: DecisionRecord = {
      ...question, attention: 'answered', answerDelivery: 'queued',
      answers: [{ question: 'Where?', selected: ['Production'] }],
    };
    publish(queued);
    await flushPromises();
    expect(card.findAll('[role=radio]').map(option => option.attributes('aria-checked'))).toEqual(['false', 'true']);
    publish({ ...queued, attention: 'active', answerDelivery: 'interrupted' });
    await flushPromises();
    expect(card.props('msg').status).toBe('pending');
    expect(card.findAll('[role=radio]').map(option => option.attributes('aria-checked'))).toEqual(['false', 'true']);
    expect(drawer.getComponent(ToolQuestion).findAll('[role=radio]')[1].attributes('aria-checked')).toBe('true');
    expect(submissions()).toHaveLength(0);
  });

  it('shows a failed save in both surfaces, then accepts a retry without changing the draft', async() => {
    // risk: silently dropping an answer or trapping it after a transient IPC failure
    const { transcript, drawer } = fixture();
    await flushPromises();
    const card = transcript.getComponent(ToolQuestion);
    await card.get('[role=radio]').trigger('click');
    beforeResolve = async() => { throw new Error('Could not save'); };
    await card.get('.qc-submit').trigger('click');
    await flushPromises();
    expect(card.props('msg')).toMatchObject({ status: 'pending', resolutionError: 'Could not save' });
    expect(drawer.get('[role=alert]').text()).toBe('Could not save');
    expect(card.get('[role=radio]').attributes('aria-checked')).toBe('true');
    beforeResolve = async() => {};
    await drawer.getComponent(ToolQuestion).get('.qc-submit').trigger('click');
    await flushPromises();
    expect(card.props('msg')).toMatchObject({ status: 'answered', answers: [{ question: 'Where?', selected: ['Staging'] }] });
    expect(submissions()).toHaveLength(2);
  });

  it('revalidates an older cached request on focus even when its change event was missed', async() => {
    // risk: a missed delivery transition turns a stale card back into an actionable request
    historyOnly.add(task.id);
    records = records.map(record => record.id === task.id
      ? { ...record, attention: 'answered', answerDelivery: 'queued', answers: [{ question: task.title, selected: ['Done'] }] }
      : record);
    const { transcript } = fixture();
    await flushPromises();
    const card = transcript.getComponent(ToolTask);
    expect(card.find('footer').exists()).toBe(false);

    // Recover an interrupted delivery without notifying this renderer.
    records = records.map(record => record.id === task.id ? { ...record, attention: 'active', answerDelivery: 'interrupted' } : record);
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(card.get('.tk-pri').attributes('disabled')).toBeUndefined();

    // A second missed event closes this now-actionable cached request.
    records = records.map(record => record.id === task.id ? { ...record, attention: 'answered', answerDelivery: 'delivered' } : record);
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(card.find('footer').exists()).toBe(false);
    expect(ipc.invoke.mock.calls.filter(([channel]) => channel === 'decisions:transcript')).toHaveLength(3);
    expect(submissions()).toHaveLength(0);
  });

  it('honors drawer dismissal inline without sending anything, including on reopen', async() => {
    // risk: reviving a dismissed request from stale transcript data
    const { wrapper, transcript, drawer } = fixture();
    await flushPromises();
    await drawer.get(`[data-decision-id="${ task.id }"] .fy-dismiss`).trigger('click');
    await flushPromises();
    expect(transcript.getComponent(ToolTask).find('footer').exists()).toBe(false);
    wrapper.unmount();
    mounted.delete(wrapper);
    const reloaded = fixture();
    await flushPromises();
    expect(reloaded.transcript.getComponent(ToolTask).find('footer').exists()).toBe(false);
    expect(submissions()).toHaveLength(0);
  });

  it('keeps unresolved legacy and explicitly non-main flows on their existing routes', async() => {
    // risk: routing unrelated or linked-agent replies to the wrong conversation
    const primary = fixture(true, true);
    await flushPromises();
    const legacy = primary.transcript.findAllComponents(ToolQuestion).at(-1)!;
    await legacy.get('[role=radio]').trigger('click');
    await legacy.get('.qc-submit').trigger('click');
    expect(primary.controller.answerQuestion).toHaveBeenCalledWith('legacy', [{ question: 'Where?', selected: ['Staging'] }]);
    const linked = fixture(false);
    await flushPromises();
    expect(linked.transcript.findComponent(ToolQuestion).exists()).toBe(false);
    expect(linked.transcript.findComponent(ToolTask).exists()).toBe(false);
    expect(linked.transcript.findComponent(ToolApproval).exists()).toBe(false);
    expect(linked.drawer.findComponent(ToolQuestion).exists()).toBe(true);
    expect(submissions()).toHaveLength(0);
  });
});
