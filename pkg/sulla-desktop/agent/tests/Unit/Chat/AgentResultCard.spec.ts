// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';

import ProactiveCard from '@pkg/pages/chat/components/proactive/ProactiveCard.vue';
import { ChatControllerKey } from '@pkg/pages/chat/controller/useChatController';
import { readAgentResultCard } from '@pkg/shared/agentResults/AgentResultCard';
import type { AgentResultItem } from '@pkg/shared/agentResults/AgentResultCard';

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

function render(msg: Record<string, unknown>, openConversation = vi.fn(), chat: { messages?: any[]; running?: boolean } = {}) {
  return {
    openConversation,
    card: mount(ProactiveCard, {
      attachTo: document.body,
      props:    { msg: { id: 'p1', kind: 'proactive', createdAt: 1, headline: 'Background agents finished', body: 'Task ready.', ...msg } as any },
      global:   { provide: { [ChatControllerKey as symbol]: { thread: computed(() => ({ id: 'thread-1' })), messages: computed(() => chat.messages ?? []), isRunning: computed(() => !!chat.running) }, 'chat:open-subagent-conversation': openConversation } },
    }),
  };
}

afterEach(() => { document.body.innerHTML = ''; localStorage.clear() });

describe('a finished background agent in the chat', () => {
  // risk: the notice told the user to run check_agent_jobs(...) and never said what happened
  it('shows what the agent did instead of a tool instruction', () => {
    const { card } = render({ result: { items: [merge] } });

    expect(card.text()).toContain('All 11 PRs are on main and staging deployed ea0d945.');
    expect(card.text()).toContain('#4320');
    expect(card.text()).toContain('Deployed');
    expect(card.text()).toContain('codex-sol-worker · 2h 19m');
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

  it('keeps the plain notice when there is no usable result', () => {
    expect(render({}).card.text()).toContain('Task ready.');
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

    it('leads with the blocker, keeps progress secondary, and shows the end of the report', () => {
      const { card } = render({ result: { items: [blocked] } });

      expect(card.find('.ar-problem').text()).toBe('Blocked: #4330 needs an owner sign-off on 25 catalog routes before merge.');
      expect(card.find('.ar-outcome').classes()).toContain('ar-secondary');
      expect(card.find('.ar-tail').text()).toContain('CI is green on #4329.');
    });

    it('drafts a resolve message for a blocked agent and a retry for a failed one', async() => {
      const drafts: string[] = [];
      window.addEventListener('chat:draft', e => drafts.push((e as CustomEvent).detail.text));
      const failed = { ...blocked, jobId: 'j4', status: 'error' as const, verdict: 'Failed', tone: 'bad' as const, report: 'Tests could not run: the container lost its workspace.' };

      const one = render({ result: { items: [blocked] } }).card;
      await one.findAll('button').find(b => b.text() === 'Resolve with Sulla')!.trigger('click');
      const two = render({ result: { items: [failed] } }).card;
      expect(two.findAll('button').map(b => b.text())).toEqual(expect.arrayContaining(['Ask why it failed', 'Retry']));
      await two.findAll('button').find(b => b.text() === 'Retry')!.trigger('click');

      expect(drafts[0]).toBe('Unblock "Fix · Fable/Opus findings": #4330 needs an owner sign-off on 25 catalog routes before merge. What are my options?');
      expect(drafts[1]).toBe('Relaunch "Fix · Fable/Opus findings" with the same task, and handle this first: Tests could not run: the container lost its workspace.');
    });

    it('says whose move it is from what follows the card', () => {
      const card = { id: 'card-1', kind: 'proactive' };
      const question = { id: 'q1', kind: 'tool_question', status: 'pending' };
      const reply = { id: 's1', kind: 'sulla' };
      const at = (messages: any[], running = false) => render({ id: 'card-1', result: { items: [blocked] } }, vi.fn(), { messages, running }).card.find('.ar-whonext').text();

      expect(at([card, reply, question])).toBe('Needs your decision: answer the question below.');
      expect(at([card], true)).toBe('Sulla is working on it now.');
      expect(at([card, reply])).toMatch(/^Sulla replied below/);
      expect(at([card])).toMatch(/^Waiting on you/);
    });

    it('collapses to one line when marked handled, and can be undone', async() => {
      const { card } = render({ result: { items: [blocked] } });

      await card.findAll('button').find(b => b.text() === 'Mark handled')!.trigger('click');
      expect(card.find('.ar-handled').text()).toContain('Handled');
      expect(card.find('.ar-problem').exists()).toBe(false);

      await card.find('.ar-handled button').trigger('click');
      expect(card.find('.ar-problem').exists()).toBe(true);
    });
  });
});
