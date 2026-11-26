// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import WorkflowPanel from '@pkg/pages/chat/components/sidedock/WorkflowPanel.vue';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import type { WorkflowPlan, WorkflowRunRow } from '@pkg/shared/productOwnerWorkflow';
import { WORKFLOW_STEPS } from '@pkg/shared/productOwnerWorkflow';

const fake = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: fake }));

const providers = [
  { id: 'codex', name: 'OpenAI Codex', connected: true, accessMethod: 'subscription-cli', models: [{ id: 'sol', label: 'GPT-6.2-Sol', efforts: [{ id: 'max' }] }] },
  { id: 'claude-code', name: 'Claude Code', connected: true, accessMethod: 'subscription-cli', models: [{ id: 'sonnet', label: 'Sonnet' }] },
  { id: 'anthropic', name: 'Anthropic API', connected: false, accessMethod: 'api-key', models: [{ id: 'api', label: 'Unconfigured API' }] },
] as WorkflowPlan['providers'];
const realResponse = { model: 'sonnet', provider: 'claude-code', effort: 'high', source: 'resolved' as const };
const startedAt = '2026-01-01T00:00:00Z';
function row(jobId: string, label: string, patch: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return { key: `${ jobId }:0`, jobId, taskIndex: 0, parentJobId: null, parentTaskIndex: null, rootThreadId: 'chat-a',
    agentId: 'worker', label, state: 'done', startedAt, endedAt: startedAt, stateReason: null, ...patch };
}
const plan: WorkflowPlan = {
  canEdit: true, providers, agents: [{ slug:'worker', name:'Sonnet Worker' }], leadModels: [],
  steps: Object.fromEntries(WORKFLOW_STEPS.map(step => [step.id, { choice: { candidates: [] }, allowedAgents: ['worker'], inherited: [], revision:'v1' }])),
};
function fixture(savedChildState: WorkflowRunRow['state'] = 'done', view: 'activity' | 'team' = 'activity') {
  const snapshot = ref({ rows: [] as WorkflowRunRow[] });
  const thread = ref('chat-a');
  fake.invoke.mockImplementation(async(channel: string) => {
    if (channel === 'chat-workflow:get') return plan;
    if (channel === 'chat-workflow:save') return plan;
    if (channel === 'chat-workflow:history') return [row('build', 'Build export'), row('implementation', 'Implement export', { parentJobId: 'build', parentTaskIndex: 0, state: savedChildState, responseModels: [realResponse] })];
    return [];
  });
  const wrapper = mount(WorkflowPanel, { props: { view }, global: { provide: { [AGENT_STATE_CLIENT_KEY as symbol]: { snapshot }, 'chat:activity-context': { backendThreadId: thread } } } });
  return { wrapper, snapshot, thread };
}
afterEach(() => {
  vi.useRealTimers();
  fake.invoke.mockReset();
});

describe('chat AI Team panel', () => {
  it('edits and reorders a chat-scoped configuration, leaving the API model absent', async() => {
    const { wrapper } = fixture('done', 'team');
    await flushPromises();
    expect(wrapper.get('h2').text()).toBe('AI Team');
    const button = (label: string) => wrapper.findAll('button').find(element => element.text() === label)!;
    expect(wrapper.text()).toContain('Product Owner routing');
    expect(wrapper.text()).toContain('Demo & handoff');
    await button('Change for this chat').trigger('click');
    await wrapper.find('#workflow-agent').setValue('worker');
    await button('Choose a model').trigger('click');
    expect(wrapper.find('#workflow-model-0').text()).not.toContain('Unconfigured API');
    await wrapper.find('#workflow-model-0').setValue('codex/sol');
    await wrapper.find('select[aria-label="Effort for model 1"]').setValue('max');
    await button('Add fallback').trigger('click');
    await wrapper.find('#workflow-model-1').setValue('claude-code/sonnet');
    await wrapper.find('button[aria-label="Move model 2 up"]').trigger('click');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(fake.invoke).toHaveBeenCalledWith('chat-workflow:save', { threadId: 'chat-a', step: 'implementation', expectedRevision: 'v1',
      choice: { agentSlug: 'worker', candidates: [{ provider: 'claude-code', model: 'sonnet' }, { provider: 'codex', model: 'sol', effort: 'max' }] } });
    wrapper.unmount();
  });

  it('renders the original parent of a terminal job and updates a live child without borrowing other chats', async() => {
    const { wrapper, snapshot } = fixture('queued');
    await flushPromises();
    const implementation = wrapper.findAll('button').find(element => element.text().includes('Implement export'))!;
    expect(implementation.text()).toContain('sonnet · High');
    await implementation.trigger('click');
    expect(wrapper.text()).toContain('Delegated by Build export');
    snapshot.value.rows = [row('implementation', 'Implement export', { parentJobId: 'build', parentTaskIndex: 0, state: 'working', responseModels: [] }),
      row('another', 'Another chat’s work', { rootThreadId: 'chat-b' })];
    await flushPromises();
    const active = wrapper.get('ol[aria-label="Active handoffs"]');
    expect(active.text()).toContain('Working');
    expect(active.text()).toContain('Build export');
    expect(active.text()).toContain('sonnet · High');
    expect(wrapper.get('[aria-label="Handoff totals"]').text()).toContain('1 in progress');
    expect(wrapper.text()).not.toContain('Another chat’s work');
    wrapper.unmount();
  });

  it('keeps a saved return visible when a stale live snapshot still says Working', async() => {
    const { wrapper, snapshot } = fixture();
    snapshot.value.rows = [row('implementation', 'Implement export', {
      parentJobId: 'build', parentTaskIndex: 0, state: 'working', endedAt: null,
    })];
    await flushPromises();

    expect(wrapper.find('ol[aria-label="Active handoffs"]').exists()).toBe(false);
    const earlier = wrapper.get('ol[aria-label="Earlier handoffs"]');
    expect(earlier.text()).toContain('Returned');
    expect(earlier.text()).toContain('sonnet · High');
    wrapper.unmount();
  });

  it('shows a selected model until output is recorded and moves a settled branch to Earlier handoffs', async() => {
    const { snapshot, wrapper } = fixture();
    const job = row('active', 'Investigate export', {
      state:        'parked',
modelStatus:  { model: 'sol', provider: 'codex', effort: 'max', source: 'requested' },
      workflowStep: 'implementation',
    });
    snapshot.value.rows = [{ ...job, waitReason: 'Waiting for CI', wakeAt: startedAt } as WorkflowRunRow];
    await flushPromises();

    expect(wrapper.get('ol[aria-label="Active handoffs"]').text()).toContain('sol · selected');
    expect(wrapper.get('.wf-detail').text()).toContain('Selected model · sol · Max (requested)');
    expect(wrapper.get('.wf-detail').text()).toContain('Waiting for CI');
    expect(wrapper.get('.wf-detail').text()).toContain('Implementation');
    expect(wrapper.get('.wf-detail').text()).toContain('Next check');
    expect(wrapper.get('[aria-label="Handoff totals"]').text()).toContain('1 waiting or blocked');

    const fallback = { ...realResponse, fallbackFrom: { model: 'sol', provider: 'codex', reason: 'quota' } };
    snapshot.value.rows = [{ ...job, state: 'done', responseModels: [fallback] }];
    await flushPromises();
    expect(wrapper.find('ol[aria-label="Active handoffs"]').exists()).toBe(false);
    const earlier = wrapper.get('ol[aria-label="Earlier handoffs"]');
    expect(earlier.text()).toContain('sonnet · High');
    await earlier.findAll('button').find(element => element.text().includes('Investigate export'))!.trigger('click');
    expect(wrapper.get('.wf-detail').text()).toContain('Fallback after sol reached its usage limit.');
    wrapper.unmount();
  });

  it('refreshes saved handoffs while Full history is open and stops polling in Team setup', async() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { wrapper } = fixture();
    await flushPromises();
    fake.invoke.mockImplementation((channel: string) => Promise.resolve(
      channel === 'chat-workflow:history' ? [row('new', 'New recorded handoff')] : [],
    ));
    vi.advanceTimersByTime(6_000);
    await flushPromises();
    expect(wrapper.get('ol[aria-label="Earlier handoffs"]').text()).toContain('New recorded handoff');

    await wrapper.setProps({ view: 'team' });
    fake.invoke.mockClear();
    vi.advanceTimersByTime(12_000);
    expect(fake.invoke).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
