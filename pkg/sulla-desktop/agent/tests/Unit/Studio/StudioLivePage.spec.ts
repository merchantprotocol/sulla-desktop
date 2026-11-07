// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom
/// <reference path="../../../../typings/shims-vue.d.ts" />

import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';

import type { AgentConversationDetail, AgentsListResponse } from '@pkg/main/agentsIpc';
import type { AgentStateClient } from '@pkg/services/agentState/AgentStateClient';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import type { AgentStateRow, AgentStateSnapshot } from '@pkg/shared/agentState/AgentStateSnapshot';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { invoke } }));

import StudioLivePage from '@pkg/components/studio/StudioLivePage.vue';


class FakeAgentStateClient {
  readonly snapshot = shallowRef<AgentStateSnapshot>({ version: 0, generatedAt: new Date(0).toISOString(), rows: [] });

  apply(next: AgentStateSnapshot): boolean {
    if (next.version <= this.snapshot.value.version) return false;
    this.snapshot.value = next;
    return true;
  }
}

class LivePageFixture {
  private conversationReadCount = 0;
  private version = 0;
  readonly client = new FakeAgentStateClient();

  readonly firstEntry = { kind: 'assistant' as const, ts: '2026-11-05T01:00:00Z', text: 'Initial activity' };
  readonly appendedEntry = { kind: 'tool' as const, ts: '2026-11-05T01:00:01Z', text: '{}', toolName: 'check_status' };

  readonly list: AgentsListResponse = {
    agents: [],
    heartbeat: null,
    jobs: [{
      jobId: 'job-1', status: 'running', createdAt: 1, finishedAt: null, taskCount: 1, parentAgentId: 'lead', parentTitle: 'Keep the feed stable', killedByHuman: false,
      tasks: [{ taskIndex: 0, agentId: 'worker', label: 'Worker', status: 'running', threadId: 'thread-1', startedAt: 1, depth: 1, kind: 'job', lastActivity: 'Working', lastActivityAt: 1, waitingForHuman: false, latestCheckin: null }],
    }],
    workflowRuns: [],
    updatedAt: Date.now(),
  };

  get conversationReads(): number {
    return this.conversationReadCount;
  }

  finishSelectedRun(): void {
    this.list.jobs[0].status = 'completed';
    this.list.jobs[0].tasks[0].status = 'completed';
    this.publish('Worker', 'done');
  }

  publish(label = 'Worker', state: AgentStateRow['state'] = 'working', version = ++this.version): void {
    const row: AgentStateRow = { key: 'job-1:0', jobId: 'job-1', taskIndex: 0, parentJobId: null, parentTaskIndex: null, rootThreadId: 'root-1', threadId: 'thread-1', depth: 0, agentId: 'worker', label, visibility: 'hidden', state, stateReason: null, waitingOnChildren: 0, startedAt: new Date(1).toISOString(), endedAt: state === 'done' ? new Date().toISOString() : null, lastCheckinAt: new Date(1).toISOString(), lastCheckinSummary: 'Working', canMessage: state === 'working', canStop: state === 'working', canOpen: true };
    this.client.apply({ version, generatedAt: new Date().toISOString(), rows: [row] });
  }

  mount() {
    this.publish();
    return mount(StudioLivePage, { attachTo: document.body, global: { provide: { [AGENT_STATE_CLIENT_KEY as symbol]: this.client as unknown as AgentStateClient } } });
  }


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
    const wrapper = fixture.mount();

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

  it('keeps vanished selected activity readable but disables controls and stops detail polling', async() => {
    // risk: operator safety — a finished run must not retain stale message or stop controls.
    const fixture = new LivePageFixture();

    fixture.install();
    const wrapper = fixture.mount();

    await flushPromises();
    await wrapper.get('.agent-row').trigger('click');
    await flushPromises();
    const timeline = wrapper.get('.tl').element;

    fixture.finishSelectedRun();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushPromises();

    expect(wrapper.get('.tl').element).toBe(timeline);
    expect(wrapper.text()).toContain('Finished — no longer running');
    expect(wrapper.find('.composer').exists()).toBe(false);
    expect(wrapper.find('.hero .btn.danger').exists()).toBe(false);
    const readsAfterFinalFetch = fixture.conversationReads;

    await vi.advanceTimersByTimeAsync(6_000);
    await flushPromises();
    expect(fixture.conversationReads).toBe(readsAfterFinalFetch);
    wrapper.unmount();
  });

  it('applies every newer authoritative state snapshot', async() => {
    // risk: activity continuity — every newer push must update the visible fleet.
    const fixture = new LivePageFixture();
    fixture.install();
    const wrapper = fixture.mount();

    fixture.publish('First response'); await flushPromises();
    expect(wrapper.text()).toContain('First response');
    fixture.publish('Second response'); await flushPromises();
    expect(wrapper.text()).toContain('Second response');
    fixture.publish('Third response'); await flushPromises();
    expect(wrapper.text()).toContain('Third response');
    wrapper.unmount();
  });

  it('applies an earlier snapshot before a later snapshot', async() => {
    // risk: activity continuity — increasing versions must remain visible in order.
    const fixture = new LivePageFixture();
    fixture.install();
    const wrapper = fixture.mount();

    fixture.publish('First response', 'working', 10); await flushPromises();
    expect(wrapper.text()).toContain('First response');
    fixture.publish('Second response', 'working', 11); await flushPromises();
    expect(wrapper.text()).toContain('Second response');
    wrapper.unmount();
  });

  it('discards an older snapshot delivered after a newer live snapshot', async() => {
    // risk: activity continuity — stale state must not stop a live selected detail feed.
    const fixture = new LivePageFixture();
    fixture.install();
    const wrapper = fixture.mount();
    await flushPromises();
    await wrapper.get('.agent-row').trigger('click');
    await flushPromises();

    fixture.publish('Current response', 'working', 20); await flushPromises();
    fixture.publish('Stale finished response', 'done', 19); await flushPromises();

    expect(wrapper.text()).toContain('Current response');
    expect(wrapper.text()).not.toContain('Finished — no longer running');
    expect(wrapper.find('.hero .btn.danger').exists()).toBe(true);
    const readsBeforeNextPoll = fixture.conversationReads;
    await vi.advanceTimersByTimeAsync(3_000); await flushPromises();
    expect(fixture.conversationReads).toBeGreaterThan(readsBeforeNextPoll);
    wrapper.unmount();
  });
});
