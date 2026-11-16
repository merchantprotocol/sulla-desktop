// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';

import AgentResultCard from '@pkg/pages/chat/components/proactive/AgentResultCard.vue';
import ProactiveCard from '@pkg/pages/chat/components/proactive/ProactiveCard.vue';
import SubAgentExchange from '@pkg/pages/chat/components/subagent/SubAgentExchange.vue';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import { LegacyAgentNotices } from '@pkg/pages/chat/messages/legacyAgentNotice';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';

const job = 'agent-job-1794718661746-9';
const resultCard = {
  id:       'card-1',
  kind:     'proactive',
  headline: 'x',
  body:     'x',
  result:   {
    items: [{
      jobId:       job,
      taskIndex:   0,
      label:       'Lane 0 · golden dataset seeder',
      agentId:     'codex-sol-worker',
      model:       'gpt-5.6-sol',
      runLocation: 'container',
      threadId:    'spawn-agent-lane-0',
      workspace:   '/mnt/data/sulla/runtime/conversations/037d/workspace',
      startedAt:   new Date(2026, 10, 14, 22, 57).getTime(),
      endedAt:     new Date(2026, 10, 15, 0, 4).getTime(),
      durationMs:  4_020_000,
      status:      'blocked',
      purpose:     'other',
      verdict:     'Blocked',
      tone:        'warn',
      outcome:     'QBO sandbox seeded.',
      report:      'QBO sandbox seeded.\nBLOCKER: staging never runs the A/R projection sweep.',
    }],
  },
};
const handoff = (direction: 'to_agent' | 'from_agent', extra: Record<string, unknown> = {}) => ({
  id:             `ex-${ direction }`,
  kind:           'subagent_exchange',
  direction,
  agentId:        'codex-sol-worker',
  label:          'Lane 0 · golden dataset seeder (staging + QBO sandbox)',
  summary:        'Started Lane 0',
  detail:         'Seed the golden dataset on staging.',
  status:         'running',
  jobId:          job,
  taskIndex:      0,
  conversationId: 'spawn-agent-lane-0',
  ...extra,
});

function provide(messages: any[], rows: any[] = [], openConversation = vi.fn()) {
  return {
    [ChatControllerKey as symbol]:      { thread: computed(() => ({ id: 't' })), messages: computed(() => messages), isRunning: computed(() => false) },
    [AGENT_STATE_CLIENT_KEY as symbol]: { snapshot: ref({ version: 1, generatedAt: '', rows }) },
    'chat:open-subagent-conversation':  openConversation,
  };
}

afterEach(() => { document.body.innerHTML = '' });

describe('one agent, one handoff line and one result', () => {
  // risk: the same agent appeared three times (started row, finished row, notice), each repeating its label
  it('drops the "returned" row when a result card covers the same job', () => {
    const back = handoff('from_agent', { status: 'done' });
    const withCard = mount(SubAgentExchange, { props: { msg: back as any }, global: { provide: provide([back, resultCard]) } });
    const withoutCard = mount(SubAgentExchange, { props: { msg: back as any }, global: { provide: provide([back]) } });

    expect(withCard.find('.sx').exists()).toBe(false);
    expect(withoutCard.text()).toContain('Returned from codex-sol-worker');
  });

  it('shows the sent line once, with live status and the brief on demand', async() => {
    const sent = handoff('to_agent');
    const line = mount(SubAgentExchange, {
      props:  { msg: sent as any },
      global: { provide: provide([sent], [{ jobId: job, taskIndex: 0, state: 'working' }]) },
    });

    expect(line.find('.sx-text').text()).toBe('Sent to codex-sol-worker · Lane 0 · golden dataset seeder (staging + QBO sandbox)');
    expect(line.find('.sx-status').text()).toBe('Working');
    expect(line.find('.sx-detail').exists()).toBe(false);
    await line.find('.sx-link').trigger('click');
    expect(line.find('.sx-detail').text()).toBe('Seed the golden dataset on staging.');
  });

  it('takes the status from the result card once the agent is no longer live', () => {
    const sent = handoff('to_agent');
    const line = mount(SubAgentExchange, { props: { msg: sent as any }, global: { provide: provide([sent, resultCard]) } });

    expect(line.find('.sx-status').text()).toBe('Blocked');
  });
});

describe('a job that finished before result cards existed', () => {
  it('takes the handoff status from its old text notice', () => {
    const sent = handoff('to_agent');
    const notice = { id: 'n0', kind: 'proactive', headline: 'Background agents finished — 0 done, 1 blocked, 0 failed, 0 stopped', body: `Task "x" is ready. Check \`check_agent_jobs("${ job }")\` for the full result.` };
    const line = mount(SubAgentExchange, { props: { msg: sent as any }, global: { provide: provide([sent, notice]) } });

    expect(line.find('.sx-status').text()).toBe('Blocked');
  });
});

describe('technical details stay reachable', () => {
  it('lists job, agent and model, timing, thread and workspace in Details', () => {
    const card = mount(AgentResultCard, { props: { data: resultCard.result as any, messageId: 'card-1' }, global: { provide: provide([resultCard]) } });
    const facts = Object.fromEntries(card.findAll('.ar-kv dt').map((dt, i) => [dt.text(), card.findAll('.ar-kv dd')[i].text()]));

    expect(facts).toEqual({
      Job:             `${ job } · task 0`,
      'Agent · model': 'codex-sol-worker · gpt-5.6-sol',
      Ran:             '22:57 → 0:04 (1h 7m) · container',
      Thread:          'spawn-agent-lane-0',
      Workspace:       '/mnt/data/sulla/runtime/conversations/037d/workspace',
    });
    expect(card.find('.ar-report summary').text()).toBe('Full report · 11 words');
  });
});

describe('old "Background agents finished" notices', () => {
  const body = `Task "Lane 0 · golden dataset seeder (staging + QBO sandbox)" is ready. Check \`check_agent_jobs("${ job }")\` for the full result.`;

  it('reads the status, task and job back out of the text', () => {
    expect(LegacyAgentNotices.parseLegacyAgentNotice('Background agents finished — 0 done, 1 blocked, 0 failed, 0 stopped', body))
      .toEqual({ verdict: 'Blocked', tone: 'warn', label: 'Lane 0 · golden dataset seeder (staging + QBO sandbox)', jobId: job });
    expect(LegacyAgentNotices.parseLegacyAgentNotice('Background agents finished — 2/2 complete', 'Tasks: A, B. Check `check_agent_jobs("agent-job-1")` for results.'))
      .toEqual({ verdict: 'Done', tone: 'ok', label: 'A, B', jobId: 'agent-job-1' });
    expect(LegacyAgentNotices.parseLegacyAgentNotice('Heartbeat insight', 'anything')).toBeUndefined();
  });

  it('shrinks to one line, and disappears when a result card covers the same job', () => {
    const notice = { id: 'n1', kind: 'proactive', headline: 'Background agents finished — 0 done, 1 blocked, 0 failed, 0 stopped', body };
    const alone = mount(ProactiveCard, { props: { msg: notice as any }, global: { provide: provide([notice, handoff('to_agent')]) } });
    const covered = mount(ProactiveCard, { props: { msg: notice as any }, global: { provide: provide([notice, resultCard]) } });

    expect(alone.find('.pc-legacy').text()).toContain('Blocked');
    expect(alone.text()).not.toContain('check_agent_jobs');
    expect(alone.find('.pc-link').text()).toBe('Open agent');
    expect(covered.html()).not.toContain('pc-legacy');
    expect(covered.text()).not.toContain('check_agent_jobs');
  });
});
