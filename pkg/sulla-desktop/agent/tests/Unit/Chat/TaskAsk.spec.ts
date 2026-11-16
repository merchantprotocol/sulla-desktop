// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';

import { buildToolingSection } from '@pkg/agent/prompts/sections/tooling';
import { normalizeQuestions } from '@pkg/agent/tools/meta/askUserQuestionShared';
import WaitingOnYou from '@pkg/pages/chat/components/sidedock/WaitingOnYou.vue';
import ToolTask from '@pkg/pages/chat/components/tool/ToolTask.vue';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import { TaskAsks } from '@pkg/pages/chat/messages/taskAsk';

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(() => Promise.resolve([])), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('@pkg/agent/services/WebSocketClientService', () => ({ getWebSocketClientService: () => ({ send: vi.fn() }) }));

const COMMAND = 'cd ~/Code/app && T=$(openssl rand -hex 32) && gh secret set STAGING_DEPLOY_HOOK_TOKEN -b "$T"';
const task = { question: 'Run this in Terminal; it stores one token in GitHub and the staging worker.', header: 'Set the staging deploy token', task: true, command: COMMAND, options: [{ label: 'Done' }] };
const taskMsg = (extra: Record<string, unknown> = {}) => ({ id: 't1', kind: 'tool_question', createdAt: Date.now() - 5 * 60_000, questionId: 'q1', status: 'pending', questions: [task], ...extra }) as any;
const questionMsg = { id: 'q2', kind: 'tool_question', createdAt: Date.now() - 60_000, questionId: 'q2', status: 'pending', questions: [{ question: 'Merge #1361 after #4352?', header: 'Merge order', options: [{ label: 'Yes' }, { label: 'No' }] }] } as any;
let controller: any;
const provide = () => ({ [ChatControllerKey as symbol]: controller });
beforeEach(() => {
  controller = { messages: computed(() => []), isRunning: computed(() => false), thread: ref({ id: 'c' }), send: vi.fn(), answerQuestion: vi.fn() };
});

describe('Sulla asks the user to do something', () => {
  // risk: "From you: run this in Terminal and reply done" sat inside a reply and was missed
  it('the question tool takes a task with its command, answered with Done', () => {
    const { questions } = normalizeQuestions({ questions: [{ question: 'Set the token', task: true, command: `  ${ COMMAND }  ` }] });
    expect(questions[0]).toMatchObject({ task: true, command: COMMAND, options: [{ label: 'Done' }], multiSelect: false });
    const plain = normalizeQuestions({ questions: [{ question: 'Pick one', command: 'rm -rf /', options: ['A', 'B'] }] }).questions[0];
    expect(plain).not.toHaveProperty('command');
    expect(plain).not.toHaveProperty('task');
  });

  it('Sulla is told to ask for actions this way, never inside a reply', () => {
    const text = JSON.stringify(buildToolingSection({ mode: 'full', templateVars: {}, toolMode: 'slim' } as any));
    expect(text).toContain('task: true');
    expect(text).toMatch(/never bury such a request in a normal reply/);
  });

  it('shows as a card with the command and Done, and Done answers the waiting tool', async() => {
    const card = mount(ToolTask, { props: { msg: taskMsg() }, global: { provide: provide() } });
    expect(card.text()).toContain('Waiting on you');
    expect(card.find('.tk-t').text()).toBe('Set the staging deploy token');
    expect(card.find('.tk-cmd code').text()).toBe(COMMAND);
    await card.find('.tk-pri').trigger('click');
    expect(controller.answerQuestion).toHaveBeenCalledWith('t1', [{ question: task.question, selected: ['Done'] }]);
  });

  it('a reply is sent as the answer, and the answered card stays as a short record', async() => {
    const card = mount(ToolTask, { props: { msg: taskMsg() }, global: { provide: provide() } });
    await card.findAll('.tk-btn').find(b => b.text().startsWith('Reply'))!.trigger('click');
    await card.find('.tk-in').setValue('It failed: gh is not signed in');
    await card.find('.tk-in').trigger('keyup.enter');
    expect(controller.answerQuestion).toHaveBeenCalledWith('t1', [{ question: task.question, selected: ['It failed: gh is not signed in'] }]);
    const done = mount(ToolTask, { props: { msg: taskMsg({ status: 'answered', answers: [{ question: task.question, selected: ['Done'] }] }) }, global: { provide: provide() } });
    expect(done.find('.tk-h').text()).toContain('Done');
    expect(done.find('.tk-cmd').exists()).toBe(false);
  });

  // risk: Done after Sulla stopped waiting went nowhere
  it('after Sulla stopped waiting, Done tells it in the chat', () => {
    TaskAsks.done(controller, taskMsg({ status: 'timed_out' }));
    expect(controller.answerQuestion).not.toHaveBeenCalled();
    expect(controller.send).toHaveBeenCalledWith('Done: Set the staging deploy token');
  });

  it('the side column lists tasks and questions first, with Done and Copy for a task', async() => {
    const list = mount(WaitingOnYou, { props: { items: [taskMsg(), questionMsg], now: Date.now() }, global: { provide: provide() } });
    const rows = list.findAll('.wy-i');
    expect(list.find('.wy-n').text()).toBe('2');
    expect(rows[0].text()).toContain('Task');
    expect(rows[0].text()).toContain('Set the staging deploy token');
    expect(rows[0].findAll('button').map(b => b.text())).toEqual(['Done', 'Copy command', 'Jump to']);
    expect(rows[1].findAll('button').map(b => b.text())).toEqual(['Answer', 'Jump to']);
    await rows[0].find('.wy-pri').trigger('click');
    expect(controller.answerQuestion).toHaveBeenCalledWith('t1', [{ question: task.question, selected: ['Done'] }]);
  });
});
