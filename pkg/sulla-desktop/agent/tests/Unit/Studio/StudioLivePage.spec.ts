// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConversationDetail, AgentsListResponse } from '@pkg/main/agentsIpc';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke } }));

import StudioLivePage from '@pkg/components/studio/StudioLivePage.vue';

class LivePageFixture {
  private conversationReadCount = 0;

  readonly firstEntry = { kind: 'assistant' as const, ts: '2026-11-05T01:00:00Z', text: 'Initial activity' };
  readonly appendedEntry = { kind: 'tool' as const, ts: '2026-11-05T01:00:01Z', text: '{}', toolName: 'check_status' };

  readonly list: AgentsListResponse = {
    agents: [],
    heartbeat: null,
    jobs: [{
      jobId: 'job-1', status: 'running', createdAt: 1, finishedAt: null, taskCount: 1, parentAgentId: 'lead', parentTitle: 'Keep the feed stable',
      tasks: [{ taskIndex: 0, agentId: 'worker', label: 'Worker', status: 'running', threadId: 'thread-1', startedAt: 1, depth: 1, kind: 'job', lastActivity: 'Working', lastActivityAt: 1, waitingForHuman: false, latestCheckin: null }],
    }],
    workflowRuns: [],
    updatedAt: Date.now(),
  };

  install(): void {
    invoke.mockImplementation(async(channel: string) => {
      if (channel === 'agents:list') return this.list;
      if (channel === 'agents:conversation') {
        this.conversationReadCount += 1;
        return this.detail(this.conversationReadCount === 1 ? [this.firstEntry] : [this.firstEntry, this.appendedEntry]);
      }
      throw new Error(`Unexpected IPC channel: ${ channel }`);
    });
  }

  private detail(entries: AgentConversationDetail['entries']): AgentConversationDetail {
    return { id: 'thread-1', channel: 'worker', title: 'Run', status: 'running', createdAt: '', lastActiveAt: '', entries, truncated: false, missingLog: false };
  }
}

describe('StudioLivePage activity refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the mounted timeline while background refreshes append activity', async() => {
    // risk: activity continuity — fleet operators must keep their reading and scroll position during polling.
    const fixture = new LivePageFixture();

    fixture.install();
    const wrapper = mount(StudioLivePage, { attachTo: document.body });

    await flushPromises();
    await wrapper.get('.agent-row').trigger('click');
    await flushPromises();
    const timeline = wrapper.get('.tl').element;

    expect(wrapper.text()).not.toContain('Loading activity…');
    expect(wrapper.text()).toContain(fixture.firstEntry.text);

    await vi.advanceTimersByTimeAsync(6_000);
    await flushPromises();

    expect(wrapper.get('.tl').element).toBe(timeline);
    expect(wrapper.text()).not.toContain('Loading activity…');
    expect(wrapper.text()).toContain(fixture.appendedEntry.toolName);
    wrapper.unmount();
  });
});
