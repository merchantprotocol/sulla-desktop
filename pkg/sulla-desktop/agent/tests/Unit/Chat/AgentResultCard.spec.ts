// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, ref, nextTick } from 'vue';

import ProactiveCard from '@pkg/pages/chat/components/proactive/ProactiveCard.vue';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { readAgentResultCard } from '@pkg/shared/agentResults/AgentResultCard';
import type { AgentResultItem } from '@pkg/shared/agentResults/AgentResultCard';
const decisions = ref<any[]>([]);
vi.mock('@pkg/composables/useDecisions', () => ({ useDecisions: () => ({ records: decisions }) }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke: vi.fn(() => Promise.resolve([])) } }));

const merge: AgentResultItem = {
  jobId:        'j1',
  taskIndex:    0,
  label:        'Merge train',
  agentId:      'codex-sol-worker',
  threadId:     'spawn-merge',
  durationMs:   8_340_000,
  status:       'completed',
  purpose:      'merge',
  verdict:      'Merged',
  tone:         'ok',
  outcome:      'All 11 PRs are on main and staging deployed ea0d945.',
  merges:       [{ pr: '#4320', sha: '70c870f' }, { pr: '#4315', sha: 'ea0d945' }],
  environments: [{ name: 'Staging', state: 'deployed' }],
  next:         { label: 'Run staging QA', prompt: 'Run staging QA for the merged perf-audit PRs.' },
  report:       'Full merge report.',
};
const review: AgentResultItem = {
  jobId:     'j2',
  taskIndex: 0,
  label:     'QBO re-grade',
  status:    'completed',
  purpose:   'review',
  verdict:   'Changes needed',
  tone:      'warn',
  outcome:   '2 gaps block sign-off.',
  findings:  [{ severity: 'blocking', title: 'C7a token refresh', file: 'qbo/oauth.ts:212' }],
  report:    'Review report.',
};

const mounted: { unmount(): void }[] = [];
function tracked<T extends { unmount(): void }>(card: T): T { mounted.push(card); return card }
function render(msg: Record<string, unknown>, openConversation = vi.fn(), chat: { messages?: any[]; running?: boolean; rows?: any[] } = {}) {
  const snapshot = ref({ rows: chat.rows ?? [] });
  const messageList = ref(chat.messages ?? []);
  return {
    snapshot,
    messageList,
    openConversation,
    card: tracked(mount(ProactiveCard, {
      attachTo: document.body,
      props:    { msg: { id: 'p1', kind: 'proactive', createdAt: 1, headline: 'Background agents finished', body: 'Task ready.', ...msg } as any },
      global:   { provide: { 'chat:activity-context': { backendThreadId: ref('parent') }, [AGENT_STATE_CLIENT_KEY as symbol]: { snapshot, error: ref('') }, [ChatControllerKey as symbol]: { thread: computed(() => ({ id: 'thread-1' })), messages: messageList, isRunning: computed(() => !!chat.running) }, 'chat:open-subagent-conversation': openConversation } },
    })),
  };
}

afterEach(() => { mounted.splice(0).forEach(card => card.unmount()); document.body.innerHTML = ''; localStorage.clear(); decisions.value = [] });

describe('a finished background agent in the chat', () => {
  // risk: the notice told the user to run check_agent_jobs(...) and never said what happened
  it('shows what the agent did instead of a tool instruction', () => {
    const { card } = render({ result: { items: [merge] } });

    expect(card.text()).toContain('All 11 PRs are on main and staging deployed ea0d945.');
    expect(card.text()).toContain('#4320');
    expect(card.text()).toContain('Deployed');
    expect(card.text()).toContain('codex-sol-worker · Model / effort not reported · 2h 19m');
    expect(card.text()).not.toContain('check_agent_jobs');
  });

  // risk: a "next step" button that merges or deploys on one click
  it('only drafts the next step into this chat for the user to send', async() => {
    const drafts: unknown[] = [];
    window.addEventListener('chat:draft', e => drafts.push((e as CustomEvent).detail));
    const { card } = render({ result: { items: [merge] } });

    await card.findAll('button').find(button => button.text() === 'Run staging QA')!.trigger('click');

    expect(drafts).toEqual([{ threadId: 'thread-1', text: 'Run staging QA for the merged perf-audit PRs.' }]);
  });

  it('opens the agent\'s own conversation', async() => {
    const { card, openConversation } = render({ result: { items: [merge] } });

    await card.findAll('button').find(button => button.text() === 'Open agent')!.trigger('click');

    expect(openConversation).toHaveBeenCalledWith({ agentId: 'codex-sol-worker', label: 'Merge train', conversationId: 'spawn-merge' });
  });

  it('opens the result that needs attention first when several agents finish together', () => {
    const { card } = render({ result: { items: [merge, review] } });

    expect(card.text()).toContain('2 agents finished');
    expect(card.text()).toContain('C7a token refresh');
    expect(card.text()).not.toContain('All 11 PRs are on main');
  });

  it('keeps an earlier changes-requested review neutral without hiding its recorded verdict', () => {
    const { card } = render({ result: { items: [review] } });
    expect(card.find('.ar-chip').text()).toBe('Earlier report');
    expect(card.find('.ar-chip').classes()).toContain('ar-dim');
    expect(card.find('details.ar-original summary').text()).toBe('Original report · Changes needed');
    expect(card.find('details.ar-original').attributes('open')).toBeUndefined();
  });

  it('keeps the plain notice for anything that is not a finished-agent notice', () => {
    expect(render({ headline: 'Heartbeat insight' }).card.text()).toContain('Task ready.');
    expect(readAgentResultCard({ items: [{ ...merge, tone: 'rainbow' }] })).toBeUndefined();
  });

  // risk: a blocked agent's card led with its progress ("Both review-fix commits are pushed.")
  // and hid what was blocking it, with nothing to act on
  describe('blocked and failed agents', () => {
    const blocked: AgentResultItem = {
      jobId:     'j3',
      taskIndex: 0,
      label:     'Fix · Fable/Opus findings',
      status:    'blocked',
      purpose:   'other',
      verdict:   'Blocked',
      tone:      'warn',
      outcome:   'Both review-fix commits are pushed.',
      report:    'Both review-fix commits are pushed.\nCI is green on #4329.\nBLOCKER: #4330 needs an owner sign-off on 25 catalog routes before merge.',
    };

    it('keeps the original blocker behind a neutral, collapsed history disclosure', () => {
      const { card } = render({ result: { items: [blocked] } });

      expect(card.find('.ar-chip').text()).toBe('Earlier report');
      expect(card.find('details.ar-original').attributes('open')).toBeUndefined();
      expect(card.find('.ar-problem').text()).toBe('Reported then: #4330 needs an owner sign-off on 25 catalog routes before merge.');
      expect(card.find('.ar-history-note').text()).toContain('not a request for your answer');
      expect(card.find('.ar-tail').exists()).toBe(false);
      expect(card.text()).toContain('CI is green on #4329.');
    });

    it('drafts a status check rather than inventing a new decision or retry', async() => {
      const drafts: string[] = [];
      window.addEventListener('chat:draft', e => drafts.push((e as CustomEvent).detail.text));
      const one = render({ result: { items: [blocked] } }).card;
      await one.findAll('button').find(b => b.text() === 'Draft status check')!.trigger('click');
      expect(drafts[0]).toContain('job j3, task 0');
      expect(drafts[0]).toContain('Do not duplicate work');
      expect(drafts[0]).not.toContain('What are my options?');
    });

    it('does not claim a reply or unrelated question means this result needs the user', () => {
      const { card } = render({ id: 'card-1', result: { items: [blocked] } }, vi.fn(), { messages: [{ id: 'card-1', kind: 'proactive' }, { id: 's1', kind: 'sulla' }, { id: 'q1', kind: 'tool_question', status: 'pending' }], running: true });
      expect(card.find('.ar-history-note').text()).toContain('earlier attempt');
      expect(card.find('.ar-acts .ar-pri').exists()).toBe(false);
      expect(card.text()).not.toContain('Waiting on you');
      expect(card.findAll('button').map(b => b.text())).not.toContain('View question');
    });

    it('updates the existing card live and opens only the linked pending question', async() => {
      const follow = { key: 'new:0', jobId: 'new', taskIndex: 0, state: 'working', rootThreadId: 'parent', threadId: 'new-thread', label: 'Finish prechecks', followUpOf: { jobId: 'j3', taskIndex: 0 } };
      const messages = [{ id: 'actual-question', kind: 'tool_question', questionId: 'real-q', status: 'pending' }];
      const { card, snapshot, messageList } = render({ result: { items: [blocked] } }, vi.fn(), { rows: [follow], messages });
      expect(card.find('.ar-chip').text()).toBe('Sulla handling');
      expect(card.find('.ar-whonext').text()).toBe('Finish prechecks');
      expect(card.find('.ar-history-note').exists()).toBe(false);
      expect(card.find('details.ar-original').attributes('open')).toBeUndefined();
      expect(card.findAll('button').map(b => b.text())).not.toContain('Draft status check');
      snapshot.value = { rows: [{ ...follow, state: 'parked', waitReason: 'GitHub CI tests running' }] };
      await nextTick();
      expect(card.find('.ar-chip').text()).toBe('Waiting for checks');
      decisions.value = [{ id: 'unrelated', conversationId: 'parent', status: 'pending', expiresAt: Date.now() + 10000 }];
      await nextTick();
      expect(card.findAll('button').map(b => b.text())).not.toContain('View question');
      decisions.value = [{ id: 'real-q', conversationId: 'new-thread', title: 'Choose scope', status: 'pending', expiresAt: Date.now() + 10000 }];
      await nextTick();
      expect(card.find('.ar-chip').text()).toBe('Needs your answer');
      const jumps: unknown[] = [];
      window.addEventListener('chat:jump-to-message', e => jumps.push((e as CustomEvent).detail));
      await card.findAll('button').find(b => b.text() === 'View question')!.trigger('click');
      expect(jumps).toEqual([{ messageId: 'actual-question' }]);
      decisions.value = [{ ...decisions.value[0], status: 'answered' }];
      await nextTick();
      expect(card.find('.ar-chip').text()).toBe('Waiting for checks');
      messageList.value = [...messages, { id: 'returned', kind: 'proactive', result: { items: [{ ...blocked, jobId: 'new', status: 'completed', followUpOf: { jobId: 'j3', taskIndex: 0 } }] } }];
      snapshot.value = { rows: [{ ...follow, state: 'done' }] };
      await nextTick();
      expect(card.find('.ar-chip').text()).toBe('Follow-up completed');
      expect(card.text()).toContain('does not by itself verify');
    });

    it('keeps quoted workspace-retention metadata in Details instead of the blocker', () => {
      const { card } = render({ result: { items: [{ ...blocked, problem: 'Checkout retained to recover blocked work in bounded job workspace.\",', report: 'Work handed off.\nCheckout retained to recover blocked work in bounded job workspace.' }] } });
      expect(card.find('.ar-problem').exists()).toBe(false);
      expect(card.find('.ar-report').text()).toContain('Checkout retained');
    });

    it('collapses to one line when marked handled, and can be undone', async() => {
      const { card } = render({ result: { items: [blocked] } });

      await card.findAll('button').find(b => b.text() === 'Hide report')!.trigger('click');
      expect(card.find('.ar-handled').text()).toContain('Hidden on this device');
      expect(card.find('.ar-problem').exists()).toBe(false);

      await card.find('.ar-handled button').trigger('click');
      expect(card.find('.ar-problem').exists()).toBe(true);
    });
  });
});
