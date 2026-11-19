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
function fixture() {
  const snapshot = ref({ rows: [] as WorkflowRunRow[] });
  const thread = ref('chat-a');
  fake.invoke.mockImplementation(async(channel: string) => {
    if (channel === 'chat-workflow:get') return plan;
    if (channel === 'chat-workflow:save') return plan;
    if (channel === 'chat-workflow:history') return [row('build', 'Build export'), row('implementation', 'Implement export', { parentJobId: 'build', parentTaskIndex: 0, responseModels: [realResponse] })];
    return [];
  });
  const wrapper = mount(WorkflowPanel, { global: { provide: { [AGENT_STATE_CLIENT_KEY as symbol]: { snapshot }, 'chat:activity-context': { backendThreadId: thread } } } });
  return { wrapper, snapshot, thread };
}
afterEach(() => fake.invoke.mockReset());

describe('chat Workflow panel', () => {
  it('edits and reorders a chat-scoped configuration, leaving the API model absent', async() => {
    const { wrapper } = fixture();
    await flushPromises();
    expect(wrapper.text()).toContain('Product Owner workflow');
    expect(wrapper.text()).toContain('Demo & handoff');
    const button = (label: string) => wrapper.findAll('button').find(element => element.text() === label)!;
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
    const { wrapper, snapshot } = fixture();
    await flushPromises();
    await wrapper.findAll('button').find(element => element.text() === 'Run history')!.trigger('click');
    await flushPromises();
    const implementation = wrapper.findAll('button').find(element => element.text().includes('Implement export'))!;
    expect(implementation.text()).toContain('sonnet · High');
    await implementation.trigger('click');
    expect(wrapper.text()).toContain('Delegated by Build export');
    snapshot.value.rows = [row('implementation', 'Implement export', { parentJobId: 'build', parentTaskIndex: 0, state: 'working' }),
      row('another', 'Another chat’s work', { rootThreadId: 'chat-b' })];
    await flushPromises();
    expect(wrapper.text()).toContain('Working');
    expect(wrapper.text()).toContain('sonnet · High');
    expect(wrapper.text()).not.toContain('Another chat’s work');
    wrapper.unmount();
  });
});
