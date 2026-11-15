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

function render(msg: Record<string, unknown>, openConversation = vi.fn()) {
  return {
    openConversation,
    card: mount(ProactiveCard, {
      attachTo: document.body,
      props:    { msg: { id: 'p1', kind: 'proactive', createdAt: 1, headline: 'Background agents finished', body: 'Task ready.', ...msg } as any },
      global:   { provide: { [ChatControllerKey as symbol]: { thread: computed(() => ({ id: 'thread-1' })) }, 'chat:open-subagent-conversation': openConversation } },
    }),
  };
}

afterEach(() => { document.body.innerHTML = '' });

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
});
